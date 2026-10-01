#!/usr/bin/env node
/*
 * import.js — 微博 / 腾讯视频导入本地库（两种模式）
 *
 * 模式一：直接下载整条视频（先下后标）
 *   node import.js http://t.cn/xxxx            # 微博，默认 720p，也可 480/1080
 *   node import.js https://v.qq.com/x/cover/... # 腾讯单视频页
 *
 * 模式二：消费待导入队列（微博页标记 → 电脑端按需裁剪，路线 A）
 *   node import.js --queue                     # 拉 pending 队列，逐条只下载片段区间
 *   node import.js --queue --dry-run           # 只看队列，不下载
 *   node import.js --queue 480                 # 队列片段用指定清晰度
 *
 * 队列消费做四件事：
 *   1. 读 Supabase pending_imports（status='pending'）
 *   2. 逐条：yt-dlp --download-sections 只下载 [start,end] 区间（重编码，帧级精确）
 *   3. 落盘成 sync.js 认识的 clips/{文件夹}/视频+meta.json 结构
 *   4. 把该条 status 置为 done（service_role 写）
 */
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

loadEnv();
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(process.env.USERPROFILE || '', 'Downloads', 'videos');
const CLIPS_DIR = process.env.CLIPS_DIR || path.join(process.env.USERPROFILE || '', 'Downloads', 'clips');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';

/* ---------- .env ---------- */
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* .env 可选 */ }
}

/* ---------- 找 yt-dlp / ffmpeg ---------- */
function findYtDlp() {
  const localAppData = process.env.LOCALAPPDATA || '';
  // 1) 优先 WinGet Packages 里的真身 exe（Links 下的 yt-dlp.exe 是 reparse point，可能 spawn 报 EBUSY）
  try {
    const pkgDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(pkgDir)) {
      if (/^yt-dlp\.yt-dlp/i.test(d)) {
        const exe = path.join(pkgDir, d, 'yt-dlp.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (_) {}
  // 2) 其次 WinGet Links shim（在 PATH 时）
  try {
    const link = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe');
    if (fs.existsSync(link) && fs.statSync(link).size > 0) return link;
  } catch (_) {}
  // 3) 最后 PATH 里的裸命令
  try { if (execSync('where yt-dlp', { stdio: 'pipe' }).toString().trim()) return 'yt-dlp'; } catch (_) {}
  console.error('找不到 yt-dlp。安装：winget install yt-dlp.yt-dlp');
  process.exit(1);
}

function findFfmpegDir() {
  const localAppData = process.env.LOCALAPPDATA || '';
  try {
    const pkgDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(pkgDir)) {
      if (/^yt-dlp\.FFmpeg/i.test(d)) {
        const bin = path.join(pkgDir, d);
        for (const sub of fs.readdirSync(bin)) {
          const b = path.join(bin, sub, 'bin');
          if (fs.existsSync(path.join(b, 'ffmpeg.exe'))) return b;
        }
      }
    }
  } catch (_) {}
  return null;
}

/* ---------- t.cn 短链解析 ---------- */
async function resolveShortLink(url) {
  const mShow = url.match(/weibo\.com\/tv\/show\/(1034:\d+)/i);
  if (mShow) return { fid: mShow[1], canonical: `https://weibo.com/tv/show/${mShow[1]}` };
  const mFid = url.match(/fid=(1034:\d+)/i);
  if (mFid) return { fid: mFid[1], canonical: `https://weibo.com/tv/show/${mFid[1]}` };

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
  let current = url;
  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, current).href;
    const m = next.match(/fid=(1034:\d+)/i) || next.match(/weibo\.com\/tv\/show\/(1034:\d+)/i);
    if (m) return { fid: m[1], canonical: `https://weibo.com/tv/show/${m[1]}` };
    current = next;
  }
  throw new Error('无法从链接解析出微博视频 fid（可能不是视频短链，或链接已失效）');
}

/* ---------- 统一来源解析 ---------- */
async function resolveInput(input) {
  if (/^https?:\/\/v\.qq\.com\/x\/(?:cover|page)\//i.test(input)) {
    return {
      provider: 'tencent',
      canonical: input,
      fid: null,
      videoId: (input.match(/\/([a-z0-9]+)\.html(?:[?#]|$)/i) || [])[1] || null
    };
  }
  const wb = await resolveShortLink(input);
  return { provider: 'weibo', canonical: wb.canonical, fid: wb.fid, videoId: null };
}

function queueSourceUrl(item) {
  const url = item.source_url || item.page_url;
  if (url) return url;
  if (item.fid) return `https://weibo.com/tv/show/${item.fid}`;
  throw new Error('队列项缺少 source_url/page_url/fid');
}

/* ---------- 工具 ---------- */
function sanitize(name) {
  return (name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled';
}
const r3 = n => Math.round(n * 1000) / 1000;

/* ---------- Supabase ---------- */
async function supabaseFetch(pathname, opts) {
  const key = opts && opts.key ? opts.key : (SERVICE_KEY || PUBLISHABLE_KEY);
  if (!key) throw new Error('缺少 Supabase 密钥：请把 SUPABASE_SERVICE_ROLE_KEY 填进 .env');
  const res = await fetch(SUPABASE_URL + pathname, {
    method: (opts && opts.method) || 'GET',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      ...(opts && opts.headers ? opts.headers : {})
    },
    ...(opts && opts.body ? { body: JSON.stringify(opts.body) } : {})
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Supabase HTTP ' + res.status + '：' + t.slice(0, 200));
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function fetchPending() {
  return supabaseFetch('/rest/v1/pending_imports?status=eq.pending&order=created_at.asc');
}

async function markDone(id) {
  if (!SERVICE_KEY) throw new Error('缺少 SUPABASE_SERVICE_ROLE_KEY（PATCH 是写操作，publishable key 不行）');
  return supabaseFetch('/rest/v1/pending_imports?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', key: SERVICE_KEY, body: { status: 'done', consumed_at: new Date().toISOString() }
  });
}

async function markFailed(id, msg) {
  if (!SERVICE_KEY) return; // 没有写权限就保持 pending，本地会跳过已处理的
  return supabaseFetch('/rest/v1/pending_imports?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH', key: SERVICE_KEY, body: { status: 'failed' }
  });
}

/* 本地台账：没 service key 时防止重复下载；填了 key 后重跑会补标记 done */
const LEDGER_PATH = path.join(__dirname, '.import-ledger.json');
function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch (_) { return {}; }
}
function writeLedger(l) { fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2)); }

/* ---------- 下载片段（--download-sections 按需裁剪） ---------- */
function downloadSection(ytDlp, ffmpegDir, canonical, start, end, quality, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--download-sections', `*${r3(start)}-${r3(end)}`,
      '--force-keyframes-at-cuts',
      '-f', quality,
      '--merge-output-format', 'mp4',
      ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
      '--downloader-args', 'ffmpeg:-movflags +faststart',
      '--no-playlist',
      '--newline',
      '-o', outPath,
      canonical
    ];
    const child = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    child.stdout.on('data', d => {
      tail = (tail + d.toString()).split(/\r?\n/).slice(-2).join('\n');
      const m = tail.match(/(\d+(?:\.\d+)?)%/);
      if (m) process.stdout.write('\r  下载 ' + m[1] + '%');
    });
    child.on('close', code => {
      process.stdout.write('\n');
      if (code === 0) resolve();
      else reject(new Error('yt-dlp 退出码 ' + code));
    });
  });
}

/* ---------- 把队列项落盘成 sync.js 认的 clips 结构 ---------- */
function writeClip(item, videoPath) {
  const folder = item.id; // 用队列 id 作为文件夹名，保证唯一
  const folderPath = path.join(CLIPS_DIR, folder);
  fs.mkdirSync(folderPath, { recursive: true });
  const finalName = item.id + '.mp4';
  const finalPath = path.join(folderPath, finalName);
  fs.renameSync(videoPath, finalPath);

  const provider = item.provider || (item.fid ? 'weibo' : 'unknown');
  const sourceUrl = item.source_url || item.page_url || '';
  const sourceId = item.fid || item.video_id || item.id;
  const src = {
    matchId: provider + '-' + sourceId,
    matchTitle: item.title || '',
    url: sourceUrl,
    provider,
    fid: item.fid || null,
    videoId: item.video_id || null,
    start: r3(item.start_sec),
    end: r3(item.end_sec)
  };
  const meta = {
    app: 'tactic-lab', version: 2, id: item.id,
    folder: folder, videoFile: finalName,
    source: src,
    tags: item.tags || [],
    note: item.note || '',
    duration: r3(item.end_sec - item.start_sec),
    createdAt: Date.now(), updatedAt: Date.now()
  };
  fs.writeFileSync(path.join(folderPath, 'meta.json'), JSON.stringify(meta, null, 2));
  return { folder, meta };
}

/* ---------- 模式一：直接下载整条 ---------- */
async function modeDirect(input, qualityArg) {
  const quality = qualityArg === '480' ? 'mp4_hd' : qualityArg === '1080' ? 'mp4_1080p' : 'mp4_720p';
  console.log('[1/3] 解析视频来源…');
  const { provider, fid, videoId, canonical } = await resolveInput(input);
  console.log('      来源 =', provider, fid ? `· fid = ${fid}` : (videoId ? `· videoId = ${videoId}` : ''));

  const ytDlp = findYtDlp();
  const ffmpegDir = findFfmpegDir();
  console.log('[2/3] 获取视频信息…');
  const json = execFileSync(ytDlp, ['--dump-json', '--no-warnings', canonical], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  const info = JSON.parse(json);
  console.log(`      「${info.title}」 ${Math.round((info.duration || 0) / 60)} 分钟 · 上传者 ${info.uploader || '未知'}`);

  const hasFormat = (info.formats || []).some(f => f.format_id === quality);
  const formatSel = hasFormat ? quality : 'bestvideo*+bestaudio/best';

  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const base = sanitize(info.title || fid.replace(':', '_'));
  const outTemplate = path.join(VIDEOS_DIR, `${base}.%(ext)s`);

  console.log(`[3/3] 下载（清晰度 ${hasFormat ? qualityArg || '720' : '最佳'}）→ ${VIDEOS_DIR}`);
  console.log('      开始下载，大文件请耐心等待…\n');
  const child = spawn(ytDlp, [
    '-f', formatSel,
    '--merge-output-format', 'mp4',
    ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
    '-o', outTemplate,
    '--no-playlist',
    '--newline',
    canonical
  ], { stdio: 'inherit' });
  await new Promise((res, rej) => child.on('close', c => c === 0 ? res() : rej(new Error('退出码 ' + c))));

  const found = fs.readdirSync(VIDEOS_DIR).filter(f => f.startsWith(base) && /\.(mp4|mkv|webm)$/i.test(f));
  if (!found.length) throw new Error('下载完成但找不到输出文件');
  const file = found.sort((a, b) => fs.statSync(path.join(VIDEOS_DIR, b)).size - fs.statSync(path.join(VIDEOS_DIR, a)).size)[0];
  const full = path.join(VIDEOS_DIR, file);
  const sizeMB = (fs.statSync(full).size / 1024 / 1024).toFixed(1);
  const metaPath = full.replace(/\.(mp4|mkv|webm)$/i, '') + '.meta.json';
  fs.writeFileSync(metaPath, JSON.stringify({
    source: provider, fid: fid || null, videoId: videoId || null,
    url: info.webpage_url || canonical, originalUrl: input, originalShortLink: input,
    title: info.title, uploader: info.uploader, duration: info.duration,
    importedAt: new Date().toISOString()
  }, null, 2));
  console.log(`\n完成：${full}（${sizeMB} MB）`);
  console.log(`来源记录：${metaPath}`);
  console.log('\n下一步：在本地 tactic-lab 里打开这个视频标注 → node sync.js 上线');
}

/* ---------- 模式三：命令行直接传起止时间裁剪（路线 A） ---------- */
async function modeClip(input, startSec, endSec) {
  const start = parseFloat(startSec), end = parseFloat(endSec);
  if (!isFinite(start) || !isFinite(end) || end <= start) {
    console.error('起止时间无效：请用「node import.js <链接> <起秒> <止秒>」，例如 52.23 65');
    process.exit(1);
  }
  console.log(`[1/3] 解析视频来源…`);
  const { provider, canonical } = await resolveInput(input);
  console.log('      来源 =', provider);

  const ytDlp = findYtDlp();
  const ffmpegDir = findFfmpegDir();

  // 腾讯是 m3u8（每段 12s）：起止点落在同一分段内时，yt-dlp 只下一个 ts 分段，重编码切不出正确区间。
  const SEG = 12;
  const span = end - start;
  if (provider === 'tencent' && span < SEG) {
    console.warn(`  ⚠ 腾讯 m3u8 每段 ${SEG}s，起止点间隔 ${span.toFixed(2)}s < ${SEG}s，可能裁不准。`);
    console.warn('    建议放宽到跨分段（>12s），或手动把终点扩大。继续尝试…\n');
  }

  console.log(`[2/3] 裁剪区间 ${r3(start)}s → ${r3(end)}s（${span.toFixed(2)}s）…`);
  const formatSel = provider === 'tencent'
    ? 'best[height<=720]/bestvideo[height<=720]+bestaudio/best'
    : 'mp4_720p';

  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const stamp = Date.now().toString(36);
  const outName = 'clip-' + stamp + '.mp4';
  const outPath = path.join(CLIPS_DIR, outName);

  await downloadSection(ytDlp, ffmpegDir, canonical, start, end, formatSel, outPath);

  const sizeMB = (fs.statSync(outPath).size / 1048576).toFixed(2);
  console.log(`\n[3/3] 完成：${outPath}（${sizeMB} MB）`);
  console.log('下一步：在本地 tactic-lab 里打开这个片段标注 → node sync.js 上线');
  console.log('（或直接跑 node sync.js，把片段按 meta.json 入库）');
}

/* ---------- 模式二：消费队列 ---------- */
async function modeQueue(qualityArg, dry) {
  const quality = qualityArg === '480' ? 'mp4_hd' : qualityArg === '1080' ? 'mp4_1080p' : 'mp4_720p';
  console.log(dry ? '=== 队列预演（不下载不写） ===' : '=== 消费待导入队列 ===');

  const pending = await fetchPending();
  if (!pending || !pending.length) {
    console.log('队列为空，没有待处理的微博片段。');
    return;
  }
  console.log('待处理 ' + pending.length + ' 条：\n');
  pending.forEach((it, i) => {
    console.log(`  ${i + 1}. [${it.id}] ${it.title || '(无标题)'}  ${r3(it.start_sec)}s→${r3(it.end_sec)}s  ${(it.tags || []).map(t => t.value).join(' ')}`);
  });

  if (dry) {
    console.log('\n这是预演，未下载任何内容。去掉 --dry-run 正式消费。');
    return;
  }

  const ytDlp = findYtDlp();
  const ffmpegDir = findFfmpegDir();
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const ledger = readLedger();

  let ok = 0, fail = 0, skipped = 0;
  for (const item of pending) {
    const label = item.id + '（' + r3(item.start_sec) + 's→' + r3(item.end_sec) + 's）';
    const provider = item.provider || (item.fid ? 'weibo' : 'unknown');
    // 腾讯 vqq 的 format_id 不是微博的 mp4_720p，而是动态的 m3u8 格式；
    // 用分辨率选择器避免把腾讯队列误传给微博专用 format_id。
    const formatSel = provider === 'tencent'
      ? 'best[height<=720]/bestvideo[height<=720]+bestaudio/best'
      : quality;

    /* 台账里已有且文件在盘上：跳过下载，只补云端标记 */
    const rec = ledger[item.id];
    if (rec && fs.existsSync(path.join(CLIPS_DIR, rec.folder, item.id + '.mp4'))) {
      console.log('\n跳过（本地已处理）：' + label + ' → ' + rec.folder);
      if (SERVICE_KEY) {
        try { await markDone(item.id); console.log('  ✓ 已补标记 done'); } catch (e) { console.log('  （补标记失败：' + e.message + '）'); }
      }
      skipped++;
      continue;
    }

    console.log('\n处理：' + label);
    let produced = null;
    try {
      const sourceUrl = queueSourceUrl(item);
      const tmpOut = path.join(CLIPS_DIR, item.id + '.tmp.mp4');
      await downloadSection(ytDlp, ffmpegDir, sourceUrl, item.start_sec, item.end_sec, formatSel, tmpOut);
      produced = writeClip(item, tmpOut);
      ledger[item.id] = { folder: produced.folder, at: new Date().toISOString() };
      writeLedger(ledger);
      const sizeMB = (fs.statSync(path.join(CLIPS_DIR, produced.folder, item.id + '.mp4')).size / 1048576).toFixed(2);
      console.log('  ✓ 片段已落盘 ' + produced.folder + '（' + sizeMB + ' MB）');
      ok++;
    } catch (e) {
      console.log('  ✗ 失败：' + e.message);
      try { await markFailed(item.id, e.message); } catch (_) {}
      fail++;
      continue;
    }
    /* 裁剪成功后再标记 done；标记失败不影响成果（台账保证不重复下载） */
    if (SERVICE_KEY) {
      try { await markDone(item.id); } catch (e) { console.log('  （警告：云端标记 done 失败：' + e.message + '）'); }
    } else {
      console.log('  （提示：未填 service key，队列状态保持 pending；本地台账已记录，不会重复下载。填好 key 后重跑 --queue 会补标记）');
    }
  }

  console.log('\n=== 队列消费结束：成功 ' + ok + ' · 跳过 ' + skipped + ' · 失败 ' + fail + ' ===');
  if (ok || skipped) console.log('片段在 ' + CLIPS_DIR + '，接着跑 node sync.js 上线。');
}

/* ---------- 入口 ---------- */
async function main() {
  const args = process.argv.slice(2);
  const queueIdx = args.indexOf('--queue');
  if (queueIdx >= 0) {
    const dry = args.includes('--dry-run');
    const qualityArg = args.find(a => /^(480|720|1080)$/.test(a));
    await modeQueue(qualityArg, dry);
    return;
  }
  const input = args[0];
  if (!input) {
    console.log('用法:');
    console.log('  node import.js <微博/腾讯视频页链接> [480|720|1080]          下载整条视频');
    console.log('  node import.js <链接> <起秒> <止秒>                           直接裁剪区间（腾讯推荐）');
    console.log('  node import.js --queue [480|720|1080] [--dry-run]             消费待导入队列');
    process.exit(1);
  }
  // 第二个参数是数字 = 命令行裁剪模式（路线 A）
  if (args[1] && /^\d+(\.\d+)?$/.test(args[1])) {
    await modeClip(input, args[1], args[2]);
    return;
  }
  await modeDirect(input, args[1]);
}

main().catch(e => { console.error('\n出错：' + e.message); process.exit(1); });
