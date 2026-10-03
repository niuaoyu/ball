#!/usr/bin/env node
/*
 * bridge.js — 本地常驻服务：接收油猴脚本的「下载完整视频」请求，调 yt-dlp 下载到本地。
 *
 * 用途：油猴脚本「下载完整视频」按钮 → POST 到本服务 → 本服务调 yt-dlp 下载整条视频
 *       到 Downloads/videos（不写 Supabase 队列、不推 R2，纯本地下载）。
 *
 * 启动：node bridge.js            （默认监听 http://127.0.0.1:8321）
 *       node bridge.js 9000       （自定义端口）
 *
 * 接口：POST /download  body: { url: string, title?: string }
 *       返回：{ ok: true, file, sizeMB } 或 { ok: false, error }
 *
 * 安全：仅监听 127.0.0.1（本机），不做鉴权；任何本地程序/页面都能调用，属于本机信任边界。
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

/* ---------- .env ---------- */
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
})();

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(process.env.USERPROFILE || '', 'Downloads', 'videos');
const PORT = parseInt(process.argv[2] || '8321', 10);

/* ---------- 找 yt-dlp / ffmpeg（与 import.js 同一套逻辑） ---------- */
function findYtDlp() {
  const localAppData = process.env.LOCALAPPDATA || '';
  try {
    const pkgDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(pkgDir)) {
      if (/^yt-dlp\.yt-dlp/i.test(d)) {
        const exe = path.join(pkgDir, d, 'yt-dlp.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (_) {}
  try {
    const link = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe');
    if (fs.existsSync(link) && fs.statSync(link).size > 0) return link;
  } catch (_) {}
  try {
    if (require('child_process').execSync('where yt-dlp', { stdio: 'pipe' }).toString().trim()) return 'yt-dlp';
  } catch (_) {}
  throw new Error('找不到 yt-dlp，请先安装：winget install yt-dlp.yt-dlp');
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

function sanitize(name) {
  return (name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled';
}

/* ---------- 来源解析（微博 / 腾讯） ---------- */
async function resolveSource(url) {
  if (/^https?:\/\/v\.qq\.com\/x\/(?:cover|page)\//i.test(url)) {
    return { provider: 'tencent', canonical: url };
  }
  // 微博：直接拿原链接（含 fid 或 t.cn 短链都交给 yt-dlp 处理）
  return { provider: 'weibo', canonical: url };
}

/* ---------- 下载完整视频到 VIDEOS_DIR ---------- */
function download(url, title) {
  return new Promise(async (resolve, reject) => {
    try {
      const ytDlp = findYtDlp();
      const ffmpegDir = findFfmpegDir();
      const { provider, canonical } = await resolveSource(url);

      const json = execFileSync(ytDlp, ['--dump-json', '--no-warnings', canonical], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
      });
      const info = JSON.parse(json);

      // 腾讯用分辨率选择器；微博用 mp4_720p（不存在则回退最佳）
      let formatSel;
      if (provider === 'tencent') {
        formatSel = 'best[height<=720]/bestvideo[height<=720]+bestaudio/best';
      } else {
        const hasFormat = (info.formats || []).some(f => f.format_id === 'mp4_720p');
        formatSel = hasFormat ? 'mp4_720p' : 'bestvideo*+bestaudio/best';
      }

      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
      const base = sanitize(title || info.title || provider);
      const outTemplate = path.join(VIDEOS_DIR, `${base}.%(ext)s`);

      const child = spawn(ytDlp, [
        '-f', formatSel,
        '--merge-output-format', 'mp4',
        ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
        '-o', outTemplate,
        '--no-playlist',
        '--newline',
        canonical
      ], { stdio: 'inherit' });

      child.on('close', code => {
        if (code !== 0) return reject(new Error('yt-dlp 退出码 ' + code));
        try {
          const found = fs.readdirSync(VIDEOS_DIR).filter(f => f.startsWith(base) && /\.(mp4|mkv|webm)$/i.test(f));
          if (!found.length) return reject(new Error('下载完成但找不到输出文件'));
          const file = found.sort((a, b) => fs.statSync(path.join(VIDEOS_DIR, b)).size - fs.statSync(path.join(VIDEOS_DIR, a)).size)[0];
          const full = path.join(VIDEOS_DIR, file);
          const sizeMB = (fs.statSync(full).size / 1024 / 1024).toFixed(1);
          const metaPath = full.replace(/\.(mp4|mkv|webm)$/i, '') + '.meta.json';
          fs.writeFileSync(metaPath, JSON.stringify({
            source: provider, fid: null,
            url: info.webpage_url || canonical,
            title: info.title, uploader: info.uploader, duration: info.duration,
            importedAt: new Date().toISOString()
          }, null, 2));
          resolve({ file: full, sizeMB, metaPath, title: info.title, duration: info.duration });
        } catch (e) { reject(e); }
      });
      child.on('error', reject);
    } catch (e) { reject(e); }
  });
}

/* ---------- HTTP 服务 ---------- */
const server = http.createServer((req, res) => {
  // CORS：允许任意来源（油猴 GM_xmlhttpRequest / fetch 需要）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'ball-bridge', videosDir: VIDEOS_DIR }));
    return;
  }

  if (req.method === 'POST' && req.url === '/download') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (_) { return reply(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

      const url = (parsed.url || '').trim();
      if (!url) return reply(res, 400, { ok: false, error: '缺少 url 字段' });

      // 立即返回「已接收」，下载在后台进行（大文件耗时久，避免前端一直等待）
      reply(res, 200, { ok: true, accepted: true, message: '已开始下载，见终端进度' });

      download(url, parsed.title)
        .then(r => console.log('\n[bridge] ✅ 下载完成：' + r.file + '（' + r.sizeMB + ' MB）'))
        .catch(e => console.error('\n[bridge] ❌ 下载失败：' + e.message));
    });
    return;
  }

  reply(res, 404, { ok: false, error: '未知路径' });
});

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('==========================================');
  console.log('  ball-bridge 本地下载服务已启动');
  console.log('  监听：http://127.0.0.1:' + PORT);
  console.log('  下载目录：' + VIDEOS_DIR);
  console.log('  健康检查：http://127.0.0.1:' + PORT + '/ping');
  console.log('  关闭：Ctrl+C');
  console.log('==========================================');
});
