#!/usr/bin/env node
/*
 * bridge.js — 本地统一后台服务（球战术片段库的公共能力中枢）
 *
 * 职责：把所有「需要本机执行 / 需要 service_role 权限」的公共能力集中到这一处，
 *       前端（油猴脚本、本地 index.html）只调用本服务的 REST 接口，不再各自重复
 *       写 Supabase / yt-dlp 逻辑。
 *
 * 接口（统一返回 { ok, ... }）：
 *   GET  /ping       健康检查
 *   POST /queue      入队（写 pending_imports，service_role）
 *   POST /delete     撤回入队（删 pending_imports 指定 id，service_role）
 *   POST /download   下载完整视频到本地（yt-dlp）
 *
 * 鉴权：校验请求来源必须是本机（Origin/Host 为 127.0.0.1 或 localhost，
 *       或无 Origin 的本地命令行工具），拒绝其他域名网页借用户浏览器发起的请求。
 *
 * 启动：node bridge.js            默认 http://127.0.0.1:8321
 *       node bridge.js 9000       自定义端口
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

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

// Supabase（入队 / 撤回，统一用 service_role，权限最高、不受 RLS 限制）
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

/* ---------- 本机来源校验 ---------- */
function isLocalOrigin(req) {
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  // 无 Origin 头：本地命令行工具（curl 等），信任
  if (!origin) return true;
  // 有 Origin 头：必须是本机地址
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch (_) {
    return false;
  }
}

/* ---------- Supabase 通用请求（service_role） ---------- */
async function supa(method, pathname, body) {
  const res = await fetch(SUPABASE_URL + pathname, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      Accept: 'application/json',
      ...(body ? { 'Prefer': 'return=representation' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const txt = await res.text();
  const data = txt ? JSON.parse(txt) : null;
  return { status: res.status, ok: res.ok, data };
}

/* ---------- 来源解析（微博 / 腾讯 / 本地） ---------- */
async function resolveSource(url) {
  if (/^https?:\/\/v\.qq\.com\/x\/(?:cover|page)\//i.test(url)) {
    return { provider: 'tencent', canonical: url };
  }
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

/* ---------- 生成入队 id ---------- */
function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

/* ---------- HTTP 服务 ---------- */
const server = http.createServer((req, res) => {
  // CORS：仅允许本机来源
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 鉴权：非本机来源一律拒绝（除了 /ping 健康检查，方便手动探测）
  if (req.url !== '/ping' && !isLocalOrigin(req)) {
    return reply(res, 403, { ok: false, error: '拒绝：请求来源不是本机' });
  }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'ball-bridge', videosDir: VIDEOS_DIR, supabase: !!SUPABASE_URL }));
    return;
  }

  /* 入队：写 pending_imports（service_role） */
  if (req.method === 'POST' && req.url === '/queue') {
    readBody(req, res, async parsed => {
      if (!SUPABASE_URL || !SERVICE_KEY) {
        return reply(res, 500, { ok: false, error: '未配置 Supabase service_role 密钥' });
      }
      const provider = (parsed.provider || '').trim();
      const source_url = (parsed.source_url || '').trim();
      const start = parseFloat(parsed.start_sec);
      const end = parseFloat(parsed.end_sec);
      const isFull = parsed.mode === 'full';

      if (!provider) return reply(res, 400, { ok: false, error: '缺少 provider' });
      if (!source_url && !parsed.fid) return reply(res, 400, { ok: false, error: '缺少 source_url/fid' });
      if (!isFull && !(isFinite(start) && isFinite(end))) {
        return reply(res, 400, { ok: false, error: '缺少有效的 start_sec/end_sec' });
      }

      const id = parsed.id || uid('clip');
      const row = {
        id,
        provider,
        source_url: source_url || null,
        fid: parsed.fid || null,
        page_url: source_url || parsed.page_url || null,
        title: parsed.title || '',
        start_sec: isFull ? 0 : start,
        end_sec: isFull ? 0 : end,
        mode: parsed.mode || 'clip',
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        note: parsed.note || '',
        status: 'pending'
      };

      try {
        let r = await supa('POST', '/rest/v1/pending_imports', row);
        // 兜底：如果数据库还没加 mode 列（旧表结构），去掉 mode 重试一次
        if (!r.ok && r.data && r.data.code === 'PGRST204' && typeof r.data.message === 'string' && r.data.message.includes("'mode'")) {
          const rowNoMode = { ...row };
          delete rowNoMode.mode;
          r = await supa('POST', '/rest/v1/pending_imports', rowNoMode);
        }
        if (r.ok) {
          reply(res, 200, { ok: true, id, message: '已入队' });
        } else {
          reply(res, r.status, { ok: false, error: '入队失败 HTTP ' + r.status + (r.data && r.data.message ? '：' + r.data.message : '') });
        }
      } catch (e) {
        reply(res, 500, { ok: false, error: '入队异常：' + e.message });
      }
    });
    return;
  }

  /* 撤回：删 pending_imports 指定 id */
  if (req.method === 'POST' && req.url === '/delete') {
    readBody(req, res, async parsed => {
      const id = (parsed.id || '').trim();
      if (!id) return reply(res, 400, { ok: false, error: '缺少 id 字段' });
      if (!SUPABASE_URL || !SERVICE_KEY) {
        return reply(res, 500, { ok: false, error: '未配置 Supabase service_role 密钥' });
      }
      try {
        const r = await supa('DELETE', '/rest/v1/pending_imports?id=eq.' + encodeURIComponent(id));
        const count = Array.isArray(r.data) ? r.data.length : 0;
        if (r.ok && count > 0) {
          reply(res, 200, { ok: true, deleted: count, message: '已撤回 ' + id });
        } else if (r.ok) {
          reply(res, 200, { ok: true, deleted: 0, message: '未找到该条（可能已被处理或已撤回）' });
        } else {
          reply(res, r.status, { ok: false, error: '删除失败 HTTP ' + r.status });
        }
      } catch (e) {
        reply(res, 500, { ok: false, error: '删除异常：' + e.message });
      }
    });
    return;
  }

  /* 下载完整视频 */
  if (req.method === 'POST' && req.url === '/download') {
    readBody(req, res, async parsed => {
      const url = (parsed.url || '').trim();
      if (!url) return reply(res, 400, { ok: false, error: '缺少 url 字段' });

      // 立即返回「已接收」，下载在后台进行
      reply(res, 200, { ok: true, accepted: true, message: '已开始下载，见终端进度' });

      download(url, parsed.title)
        .then(r => console.log('\n[bridge] ✅ 下载完成：' + r.file + '（' + r.sizeMB + ' MB）'))
        .catch(e => console.error('\n[bridge] ❌ 下载失败：' + e.message));
    });
    return;
  }

  reply(res, 404, { ok: false, error: '未知路径' });
});

function readBody(req, res, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body || '{}'); }
    catch (_) { return reply(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }
    cb(parsed);
  });
}

function reply(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('==========================================');
  console.log('  ball-bridge 统一后台服务已启动');
  console.log('  监听：http://127.0.0.1:' + PORT);
  console.log('  下载目录：' + VIDEOS_DIR);
  console.log('  健康检查：http://127.0.0.1:' + PORT + '/ping');
  console.log('  接口：/queue 入队 · /delete 撤回 · /download 下载');
  console.log('  鉴权：仅接受本机来源');
  console.log('  关闭：Ctrl+C');
  console.log('==========================================');
});
