'use strict';
/* =========================================================
 * tactic-lab sync · 本地片段库 → 云端 一键同步
 *
 * 流程：扫描 CLIPS_DIR（豆包版工具落盘的 文件夹/视频+meta.json）
 *   → 与 Supabase 现有记录按 clip id 比对
 *   → 新片段 / 起止时间变了：上传视频到 R2 + upsert 数据库
 *   → 只是标签或备注变了：只 upsert 数据库（视频不动）
 *   → 完全没变：跳过
 *
 * 用法：
 *   node sync.js --dry-run   预演：只读云端和本地，不写任何东西（不需要密钥）
 *   node sync.js             正式同步（需要 .env 里的 R2 密钥 + service_role key）
 * ========================================================= */

const fs = require('fs');
const path = require('path');

/* ---------- 读取 .env（极简解析，避免额外依赖） ---------- */
function loadEnv(file) {
  const p = path.resolve(__dirname, file);
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env) || process.env[key] === '') process.env[key] = val;
  }
}
loadEnv('.env');
loadEnv('.env.local');

const DRY = process.argv.includes('--dry-run');

const CFG = {
  clipsDir: process.env.CLIPS_DIR || 'C:\\Users\\rdp\\Downloads\\clips',
  accountId: process.env.R2_ACCOUNT_ID || '',
  bucket: process.env.R2_BUCKET || '',
  publicBase: (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, ''),
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ''
};

/* ---------- 找 ffmpeg（WinGet Packages 里的真身，与 import.js 一致） ---------- */
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

/* 抽一帧当缩略图：0.5s 处、宽 480px（等比），输出 JPG */
function extractThumb(clip, outPath) {
  const ffmpegDir = findFfmpegDir();
  const ffmpeg = ffmpegDir ? path.join(ffmpegDir, 'ffmpeg.exe') : 'ffmpeg';
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(ffmpeg, [
      '-ss', '0.5',
      '-i', clip._videoPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '3',
      '-y', outPath
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-1500); });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 抽帧失败（退出码 ' + code + '）：' + err.slice(-200)));
    });
  });
}

/* ---------- 小工具 ---------- */
const enc = encodeURIComponent;
const pad2 = n => String(n).padStart(2, '0');
function ts(ms) {
  if (!ms) return new Date().toISOString();
  return new Date(Number(ms)).toISOString();
}
function fmtLocalPath(p) { return p; }
function log(...a) { console.log(...a); }
function rowLine(action, clip, extra) {
  const tags = (clip.tags || []).map(t => t.dimension + ':' + t.value).join(' ') || '无标签';
  log('  [' + action + '] ' + clip.folder + '  ' + tags + (extra ? '  ' + extra : ''));
}

/* ---------- 扫描本地片段库 ---------- */
function scanLocal() {
  const dir = CFG.clipsDir;
  if (!fs.existsSync(dir)) {
    log('找不到片段库目录：' + dir + '（检查 .env 的 CLIPS_DIR）');
    process.exit(1);
  }
  const clips = [];
  for (const name of fs.readdirSync(dir)) {
    const folder = path.join(dir, name);
    if (!fs.statSync(folder).isDirectory()) continue;
    const metaPath = path.join(folder, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      log('  [跳过] ' + name + '：meta.json 解析失败（' + e.message + '）');
      continue;
    }
    if (!meta.id) continue;
    const videoPath = path.join(folder, meta.videoFile || '');
    if (!fs.existsSync(videoPath)) {
      log('  [跳过] ' + name + '：视频文件缺失 ' + meta.videoFile);
      continue;
    }
    meta.folder = name;
    meta._videoPath = videoPath;
    clips.push(meta);
  }
  /* 同一 id 出现在多个文件夹时取 updatedAt 最新的（防御性处理） */
  const byId = new Map();
  for (const c of clips) {
    const old = byId.get(c.id);
    if (!old || (c.updatedAt || 0) >= (old.updatedAt || 0)) byId.set(c.id, c);
  }
  return Array.from(byId.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/* ---------- 构造与 gen_sql.py 完全一致的数据库行 ---------- */
function toRow(clip) {
  const src = clip.source || {};
  const title = clip.note || src.matchTitle || clip.folder || '';
  return {
    id: clip.id,
    title: title,
    video_url: CFG.publicBase + '/clips/' + enc(clip.folder) + '/' + enc(clip.videoFile),
    thumbnail_url: CFG.publicBase + '/clips/' + enc(clip.folder) + '/' + enc(clip.id) + '.jpg',
    tags: clip.tags || [],
    note: clip.note || '',
    memo: clip.memo || '',   // 思考笔记（网页端播放浮层写入，与油猴「备注=标题」分开）
    duration: clip.duration || 0,
    source: src,
    created_at: ts(clip.createdAt),
    updated_at: ts(clip.updatedAt)
  };
}

function r2KeyOf(clip) {
  return 'clips/' + clip.folder + '/' + clip.videoFile;
}

function r2ThumbKeyOf(clip) {
  return 'clips/' + clip.folder + '/' + clip.id + '.jpg';
}

/* 标签语义化比较：Postgres jsonb 不保留键顺序，不能直接比字符串 */
function normTags(tags) {
  return (tags || []).map(t => t.dimension + '\u0000' + t.value).sort().join('');
}

/* 元数据是否与云端行一致（不含 updated_at） */
function sameMeta(row, clip) {
  const src = clip.source || {};
  const rowSrc = row.source || {};
  return row.title === (clip.note || src.matchTitle || clip.folder || '')
    && (row.note || '') === (clip.note || '')
    && (row.memo || '') === (clip.memo || '')
    && Math.abs((row.duration || 0) - (clip.duration || 0)) < 0.001
    && Math.abs((rowSrc.start || 0) - (src.start || 0)) < 0.001
    && Math.abs((rowSrc.end || 0) - (src.end || 0)) < 0.001
    && normTags(row.tags) === normTags(clip.tags);
}

/* 起止时间是否变了（决定要不要重新上传视频） */
function videoChanged(row, clip) {
  const src = clip.source || {};
  const rowSrc = row.source || {};
  return Math.abs((rowSrc.start || 0) - (src.start || 0)) >= 0.001
    || Math.abs((rowSrc.end || 0) - (src.end || 0)) >= 0.001
    || Math.abs((row.duration || 0) - (clip.duration || 0)) >= 0.001;
}

/* ---------- Supabase（REST，fetch 即可，无需 SDK） ---------- */
async function fetchAllRows() {
  const key = DRY ? CFG.publishableKey : CFG.serviceKey;
  if (!key) throw new Error(DRY
    ? '缺少 SUPABASE_PUBLISHABLE_KEY（预演模式用它做只读查询）'
    : '缺少 SUPABASE_SERVICE_ROLE_KEY（填到 .env，位置：Supabase → Settings → API）');
  const res = await fetch(CFG.supabaseUrl + '/rest/v1/clips?select=*', {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error('Supabase 读取失败 HTTP ' + res.status + '：' + (await res.text()).slice(0, 200));
  return res.json();
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const res = await fetch(CFG.supabaseUrl + '/rest/v1/clips', {
    method: 'POST',
    headers: {
      apikey: CFG.serviceKey,
      Authorization: 'Bearer ' + CFG.serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error('Supabase 写入失败 HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));
}

/* ---------- R2（S3 兼容 API） ---------- */
let s3 = null;
function getS3() {
  if (s3) return s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  if (!CFG.accountId || !CFG.accessKeyId || !CFG.secretAccessKey) {
    throw new Error('缺少 R2 密钥：请把 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 填进 .env');
  }
  s3 = new S3Client({
    region: 'auto',
    endpoint: 'https://' + CFG.accountId + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey },
    forcePathStyle: true
  });
  return s3;
}

async function r2Exists(key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  try {
    await getS3().send(new HeadObjectCommand({ Bucket: CFG.bucket, Key: key }));
    return true;
  } catch (e) {
    if (e && (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)) return false;
    throw e;
  }
}

async function r2Upload(clip) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const buf = fs.readFileSync(clip._videoPath);
  const ext = path.extname(clip.videoFile || '').toLowerCase();
  const contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
  await getS3().send(new PutObjectCommand({
    Bucket: CFG.bucket,
    Key: r2KeyOf(clip),
    Body: buf,
    ContentType: contentType
  }));
}

async function r2UploadThumb(clip, thumbPath) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const buf = fs.readFileSync(thumbPath);
  await getS3().send(new PutObjectCommand({
    Bucket: CFG.bucket,
    Key: r2ThumbKeyOf(clip),
    Body: buf,
    ContentType: 'image/jpeg'
  }));
}

/* ---------- 主流程 ---------- */
async function main() {
  log(DRY ? '=== 预演模式（不写任何数据） ===' : '=== 正式同步 ===');
  log('片段库：' + fmtLocalPath(CFG.clipsDir));
  log('');

  const local = scanLocal();
  log('本地片段：' + local.length + ' 个');

  const rows = await fetchAllRows();
  const dbById = new Map(rows.map(r => [r.id, r]));
  log('云端记录：' + rows.length + ' 个');
  log('');

  const toUpload = [];   // 需要上传视频的片段
  const toUpsert = [];   // 需要写入数据库的行
  let unchanged = 0;

  for (const clip of local) {
    const row = dbById.get(clip.id);
    if (!row) {
      toUpload.push(clip);
      toUpsert.push(toRow(clip));
      rowLine('新增', clip, '→ 上传视频 + 写数据库');
    } else if (videoChanged(row, clip)) {
      toUpload.push(clip);
      toUpsert.push(toRow(clip));
      rowLine('重切', clip, '→ 重新上传视频 + 更新数据库');
    } else if (!sameMeta(row, clip)) {
      toUpsert.push(toRow(clip));
      rowLine('更新', clip, '→ 只更新数据库（视频不动）');
    } else if (!row.thumbnail_url) {
      /* 元数据没变，但缺缩略图（历史老片段）→ 只补缩略图 + 补写 thumbnail_url 字段 */
      toUpsert.push(toRow(clip));
      rowLine('补缩略图', clip, '→ 生成缩略图 + 补写 thumbnail_url');
    } else {
      unchanged++;
    }
  }

  /* 云端有、本地没有 → 只提示不删（防误删） */
  const localIds = new Set(local.map(c => c.id));
  const orphan = rows.filter(r => !localIds.has(r.id));
  if (orphan.length) {
    log('注意：云端有 ' + orphan.length + ' 条本地不存在的记录（不处理）：');
    orphan.forEach(r => log('  - ' + r.id + ' ' + (r.title || '')));
  }
  log('');
  log('计划：上传视频 ' + toUpload.length + ' 个 · 更新数据库 ' + toUpsert.length + ' 条 · 无变化 ' + unchanged + ' 个');

  if (DRY) {
    log('');
    log('这是预演结果，没有任何数据被修改。去掉 --dry-run 正式执行。');
    return;
  }

  /* --- 执行 --- */
  /* 1) 上传视频（仅新增/重切） */
  for (const clip of toUpload) {
    const key = r2KeyOf(clip);
    if (await r2Exists(key)) {
      log('R2 已存在，跳过上传：' + key);
    } else {
      process.stdout.write('上传中：' + clip.folder + ' ... ');
      await r2Upload(clip);
      log('完成');
    }
  }
  /* 2) 生成缩略图：遍历所有本地片段，R2 上缺缩略图就抽帧补（覆盖新增/重切/补缩略图三种情况） */
  for (const clip of local) {
    const thumbKey = r2ThumbKeyOf(clip);
    if (await r2Exists(thumbKey)) continue;
    const tmpThumb = path.join(__dirname, '.thumb-' + clip.id + '.jpg');
    try {
      await extractThumb(clip, tmpThumb);
      await r2UploadThumb(clip, tmpThumb);
      log('缩略图已生成：' + thumbKey);
    } catch (e) {
      log('（警告）缩略图生成失败，卡片将回退占位图：' + e.message);
    } finally {
      try { if (fs.existsSync(tmpThumb)) fs.unlinkSync(tmpThumb); } catch (_) {}
    }
  }
  if (toUpsert.length) {
    process.stdout.write('写入 Supabase ... ');
    await upsertRows(toUpsert);
    log('完成');
  }

  log('');
  log('同步完成：新增/更新 ' + toUpsert.length + ' 条，上传视频 ' + toUpload.length + ' 个。');
  log('在线库刷新即可看到最新内容。');
}

main().catch(err => {
  console.error('');
  console.error('同步失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
