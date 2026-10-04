'use strict';

/* =========================================================
 * 战术片段库 · V2
 * 文件夹即数据库：
 *   <库根目录>/
 *     001_20260927-1015_挡拆-下顺/
 *       {id}.mp4（或 {id}.webm，文件名取自 meta.json 的 id）
 *       meta.json（来源视频、起止时间、标签、备注）
 * 每次启动扫描全部子文件夹重建索引；片段视频用 MediaRecorder 录制
 * ========================================================= */

/* ---------- 常量 ---------- */
const FRAME = 1 / 30;                 // 「约一帧」的步长，可按视频实际帧率改
const DB_NAME = 'tactic-lab';
const DB_VERSION = 3;
const DRAFT_KEY = 'tactic-lab:draft';

/* ---------- 本地 bridge 服务（入队/撤回/下载统一入口） ---------- */
const BRIDGE = 'http://127.0.0.1:8321';

/* 预登记的本机比赛（首次启动自动写入数据库，选一次文件即可关联） */
const PRESEED_MATCHES = [
  {
    id: 'match-preseed-1',
    title: '@花查章 的个人主页',
    fileName: '@花查章 的个人主页.mp4',
    fileSize: 1324596308,
    lastModified: 1790472232000,
    duration: 0,
    createdAt: 1790472232000
  }
];

/* ---------- 全局状态 ---------- */
const state = {
  matches: [],
  clips: [],                  // 扫描库文件夹得到的片段记录
  currentMatchId: null,
  currentFile: null,          // 源视频 File，仅内存
  A: null,
  B: null,
  loop: true,
  rate: 1,
  draftTags: [],
  editingClipId: null,
  results: [],
  resultIndex: -1,
  playingClipId: null,
  pendingClip: null,
  library: null,              // 库根目录 DirectoryHandle
  reviewMode: false,          // true = 正在播放已保存的片段文件
  lastQueuedId: null,          // 最近一次入队的 id，供「撤回」
  liveRec: { active: false, valid: false, blob: null, start: null, recorder: null }
};

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const video = $('video');
const els = {
  matchSelect: $('matchSelect'),
  btnImportMatch: $('btnImportMatch'),
  btnPickFile: $('btnPickFile'),
  fileStatus: $('fileStatus'),
  btnPickLibrary: $('btnPickLibrary'),
  btnRescan: $('btnRescan'),
  libraryStatus: $('libraryStatus'),
  searchInput: $('searchInput'),
  resultCount: $('resultCount'),
  hotTags: $('hotTags'),
  placeholder: $('videoPlaceholder'),
  timeNow: $('timeNow'),
  btnSetA: $('btnSetA'),
  btnSetB: $('btnSetB'),
  labelA: $('labelA'),
  labelB: $('labelB'),
  btnClearAB: $('btnClearAB'),
  btnSave: $('btnSave'),
  btnQueue: $('btnQueue'),
  btnUndoQueue: $('btnUndoQueue'),
  btnBack5s: $('btnBack5s'),
  btnFwd5s: $('btnFwd5s'),
  btnLoop: $('btnLoop'),
  tagInput: $('tagInput'),
  tagValueList: $('tagValueList'),
  draftTags: $('draftTags'),
  noteInput: $('noteInput'),
  editingHint: $('editingHint'),
  resultsTitle: $('resultsTitle'),
  results: $('results'),
  videoFileInput: $('videoFileInput'),
  toast: $('toast'),
  playerWrap: $('playerWrap'),
  markerPanel: $('markerPanel'),
  btnFullscreen: $('btnFullscreen'),
  btnPanelToggle: $('btnPanelToggle')
};

/* ---------- 小工具 ---------- */
const r3 = n => Math.round(n * 1000) / 1000;
function fmt(t) {
  if (t == null || !isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
}
function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2200);
}
function once(target, name) {
  return new Promise(res => target.addEventListener(name, res, { once: true }));
}

/* ---------- IndexedDB 薄封装 ---------- */
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('matches')) {
        d.createObjectStore('matches', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('clips')) {
        const store = d.createObjectStore('clips', { keyPath: 'id' });
        store.createIndex('byMatch', 'matchId', { unique: false });
      }
      if (!d.objectStoreNames.contains('kv')) {
        d.createObjectStore('kv');      // 存放库根目录句柄
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const idbPut = (store, val) => idbReq(db.transaction(store, 'readwrite').objectStore(store).put(val));
const idbDel = (store, key) => idbReq(db.transaction(store, 'readwrite').objectStore(store).delete(key));
const idbAll = store => idbReq(db.transaction(store, 'readonly').objectStore(store).getAll());
const kvGet = key => idbReq(db.transaction('kv', 'readonly').objectStore('kv').get(key));
const kvPut = (key, val) => idbReq(db.transaction('kv', 'readwrite').objectStore('kv').put(val, key));

/* =========================================================
 * 片段库文件夹：选择 / 恢复 / 扫描
 * ========================================================= */
const hasDirPicker = typeof window.showDirectoryPicker === 'function';

function setLibraryStatus(text, cls) {
  els.libraryStatus.textContent = text;
  els.libraryStatus.className = 'status' + (cls ? ' ' + cls : '');
}

async function pickLibrary() {
  if (!hasDirPicker) return toast('需要 Chrome / Edge，当前浏览器不支持选择文件夹');
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.library = h;
    await kvPut('library', h);
    await scanLibrary();
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('选择失败：' + err.message);
  }
}

/* 已有句柄、重开网页后需要用户手势授权 */
async function requestLibrary() {
  if (!state.library) return pickLibrary();
  try {
    let p = await state.library.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') p = await state.library.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') await scanLibrary();
  } catch (err) { toast('授权失败：' + err.message); }
}

/* 扫描库根目录：每个子文件夹 = 一个片段（视频 + meta.json） */
async function scanLibrary() {
  if (!state.library) return;
  let p;
  try { p = await state.library.queryPermission({ mode: 'readwrite' }); }
  catch (err) { return; }
  if (p !== 'granted') {
    setLibraryStatus('点击授权片段库「' + state.library.name + '」', 'warn');
    return;
  }
  const clips = [];
  for await (const [name, dir] of state.library.entries()) {
    if (dir.kind !== 'directory') continue;
    let meta = null;
    const videoCandidates = [];
    for await (const [fn, fh] of dir.entries()) {
      if (fn.toLowerCase() === 'meta.json') {
        try {
          const f = await fh.getFile();
          meta = JSON.parse(await f.text());
        } catch (err) { /* 损坏的 meta 跳过 */ }
      } else if (/\.(mp4|webm|mov|m4v|mkv)$/i.test(fn)) {
        videoCandidates.push(fn);
      }
    }
    if (meta && videoCandidates.length) {
      /* 优先取以 meta.id 命名的视频，兼容旧版 clip.mp4 */
      const escId = String(meta.id || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const videoName = (meta.id &&
        videoCandidates.find(fn => new RegExp('^' + escId + '\\.', 'i').test(fn))) ||
        videoCandidates[0];
      clips.push(Object.assign({}, meta, { dirHandle: dir, videoName }));
    }
  }
  clips.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  state.clips = clips;
  setLibraryStatus('库：' + state.library.name + ' · ' + clips.length + ' 个片段', 'ok');
  renderResults();
  renderHotTags();
  renderTagValueList();
}

/* =========================================================
 * 片段录制（MediaRecorder，优先 MP4，不支持则 WebM）
 * ========================================================= */
function pickRecMime() {
  const cands = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  for (const c of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}
const REC_MIME = pickRecMime();
const REC_EXT = REC_MIME.indexOf('mp4') >= 0 ? 'mp4' : 'webm';

function recBitrates() {
  const h = video.videoHeight || 720;
  return { v: h >= 1080 ? 8e6 : h >= 720 ? 5e6 : 2.5e6, a: 128e3 };
}
function makeRecorder(stream) {
  const { v, a } = recBitrates();
  const chunks = [];
  const rec = new MediaRecorder(stream, {
    mimeType: REC_MIME, videoBitsPerSecond: v, audioBitsPerSecond: a
  });
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  return { rec, chunks };
}

/* 边看边录：按 I 即开录，按 O 停止；中途 seek 则标记失效，保存时改走渲染补录 */
function startLiveCapture() {
  if (!REC_MIME || state.liveRec.active) return;
  try {
    const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    const { rec, chunks } = makeRecorder(stream);
    rec.onstop = () => {
      state.liveRec.blob = new Blob(chunks, { type: REC_MIME });
      state.liveRec.active = false;
    };
    rec.start(200);
    state.liveRec = { active: true, valid: true, blob: null, start: state.A, recorder: rec };
    video.addEventListener('seeking',
      () => { if (state.liveRec.active) state.liveRec.valid = false; }, { once: true });
  } catch (e) {
    state.liveRec.active = false;
  }
}
function stopLiveCapture() {
  const r = state.liveRec.recorder;
  if (state.liveRec.active && r && r.state !== 'inactive') r.stop();
}
function liveBlobReady() {
  return new Promise(res => {
    const check = () => {
      if (!state.liveRec.active && state.liveRec.blob) return res(state.liveRec.blob);
      setTimeout(check, 60);
    };
    check();
  });
}
function resetLiveRec() {
  if (state.liveRec.active) { try { state.liveRec.recorder.stop(); } catch (e) {} }
  state.liveRec = { active: false, valid: false, blob: null, start: null, recorder: null };
}

/* 补录：实时播放一遍 A→B 区间录制（暂停时标记 / 回看标记的情况） */
function renderPass(start, end) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const fail = e => { if (!settled) { settled = true; reject(e); } };
    const guard = setTimeout(() => fail(new Error('录制超时')), (end - start + 15) * 1000);
    try {
      const stream = video.captureStream();
      const { rec, chunks } = makeRecorder(stream);
      rec.onstop = () => {
        clearTimeout(guard);
        if (!settled) { settled = true; resolve(new Blob(chunks, { type: REC_MIME })); }
      };
      video.playbackRate = 1;
      video.currentTime = start;
      await once(video, 'seeked');
      rec.start(200);
      video.play().catch(fail);
      const check = () => {
        if (video.currentTime >= end) {
          video.pause();
          if (rec.state !== 'inactive') rec.stop();
        } else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    } catch (e) { fail(e); }
  });
}

/* =========================================================
 * 源视频文件关联（比赛）
 * ========================================================= */
const hasFSAPI = typeof window.showOpenFilePicker === 'function';

function matchById(id) {
  return state.matches.find(m => m.id === id) || null;
}

function verifyFile(file, match) {
  const problems = [];
  if (match.fileName && file.name !== match.fileName) problems.push('文件名不同');
  if (match.fileSize && file.size !== match.fileSize) problems.push('文件大小不同');
  if (problems.length) {
    return confirm('所选文件与记录不匹配（' + problems.join('、') + '）。\n仍要关联到「' + match.title + '」吗？');
  }
  return true;
}

function attachFile(file, match) {
  if (!verifyFile(file, match)) return false;
  if (video.src) URL.revokeObjectURL(video.src);
  state.reviewMode = false;
  state.currentFile = file;
  video.src = URL.createObjectURL(file);
  els.placeholder.classList.add('hidden');
  setStatus('已关联：' + file.name, 'ok');
  els.btnPickFile.classList.add('hidden');
  if (state.pendingClip) {
    const clip = state.pendingClip;
    state.pendingClip = null;
    video.addEventListener('loadedmetadata', () => playClip(clip), { once: true });
  }
  return true;
}

function setStatus(text, cls) {
  els.fileStatus.textContent = text;
  els.fileStatus.className = 'status' + (cls ? ' ' + cls : '');
}

async function pickFileForMatch(match) {
  if (hasFSAPI) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: '视频文件', accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.avi'] } }],
        multiple: false
      });
      const file = await handle.getFile();
      if (attachFile(file, match)) {
        match.handle = handle;
        await idbPut('matches', match);
      }
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  els.videoFileInput.click();
}

async function restoreFromHandle(match, allowRequest) {
  if (!match.handle) return false;
  try {
    let perm = await match.handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && allowRequest) {
      perm = await match.handle.requestPermission({ mode: 'read' });
    }
    if (perm !== 'granted') return false;
    const file = await match.handle.getFile();
    if (!verifyFile(file, match)) return false;
    attachFile(file, match);
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureFile(match, allowRequest) {
  if (state.currentFile) return true;
  setStatus('正在恢复视频文件…');
  const ok = await restoreFromHandle(match, allowRequest);
  if (ok) return true;
  setStatus('待关联：' + (match.fileName || '点击右侧按钮选择视频'), 'warn');
  els.btnPickFile.classList.remove('hidden');
  return false;
}

/* =========================================================
 * A / B 标记（与录制联动）
 * ========================================================= */
function setA() {
  if (state.reviewMode) return toast('正在回看片段，切回源视频才能标记');
  if (!state.currentFile) return toast('请先关联视频文件');
  state.A = video.currentTime;
  if (state.B != null && state.B <= state.A) state.B = null;
  if (!video.paused) startLiveCapture();
  renderAB();
  saveDraft();
}

function setB() {
  if (state.reviewMode) return toast('正在回看片段，切回源视频才能标记');
  if (!state.currentFile) return toast('请先关联视频文件');
  if (state.A == null) return toast('先按 I 标记开始点');
  state.B = video.currentTime;
  if (state.B <= state.A) {
    const t = state.A; state.A = state.B; state.B = t;
  }
  stopLiveCapture();
  renderAB();
  saveDraft();
  els.tagInput.focus();
}

function clearPoints() {
  resetLiveRec();
  state.A = null;
  state.B = null;
  renderAB();
  saveDraft();
}

function renderAB() {
  els.labelA.textContent = state.A != null ? fmt(state.A) : '--:--.---';
  els.labelB.textContent = state.B != null ? fmt(state.B) : '--:--.---';
  els.labelA.classList.toggle('set', state.A != null);
  els.labelB.classList.toggle('set', state.B != null);
}

/* =========================================================
 * 播放控制（源视频 / 回看片段通用）
 * ========================================================= */
function togglePlay() {
  if (!video.src) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function step(dt) {
  if (!video.src) return;
  video.pause();
  const t = Math.min(Math.max(video.currentTime + dt, 0), video.duration || 0);
  video.currentTime = t;
}

function setRate(r) {
  state.rate = r;
  video.playbackRate = r;
}

function toggleLoop() {
  state.loop = !state.loop;
  els.btnLoop.classList.toggle('on', state.loop);
  toast(state.loop ? '循环：开' : '循环：关');
  saveDraft();
}

/* 全屏：对播放器容器（含标记面板）全屏，面板是其后代所以全屏中仍然可见可点 */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (els.playerWrap && els.playerWrap.requestFullscreen) {
    els.playerWrap.requestFullscreen().catch(() => toast('浏览器拒绝了全屏请求'));
  }
}

function togglePanel() {
  const collapsed = els.markerPanel.classList.toggle('collapsed');
  els.btnPanelToggle.textContent = collapsed ? '展开' : '收起';
}

/* A-B 循环 + 时间显示：requestAnimationFrame 判定 */
function rafTick() {
  if (state.loop && state.A != null && state.B != null && !video.paused && !video.seeking) {
    if (video.currentTime >= state.B) video.currentTime = state.A;
  }
  els.timeNow.textContent = fmt(video.currentTime);
  requestAnimationFrame(rafTick);
}

/* =========================================================
 * 标签编辑
 * ========================================================= */
function renderTagValueList() {
  const set = new Set();
  state.clips.forEach(c => (c.tags || []).forEach(t => set.add(t.value)));
  els.tagValueList.innerHTML = '';
  Array.from(set).sort().forEach(v => {
    const op = document.createElement('option');
    op.value = v; els.tagValueList.appendChild(op);
  });
}

function addTagsFromInput() {
  const raw = els.tagInput.value.trim();
  if (!raw) return false;
  raw.split(/[\s,，、]+/).filter(Boolean).forEach(word => {
    let d = '战术', v = word;
    const m = word.match(/^([^:：]+)[:：](.+)$/);
    if (m) { d = m[1].trim(); v = m[2].trim(); }
    if (v && !state.draftTags.some(t => t.dimension === d && t.value === v)) {
      state.draftTags.push({ dimension: d, value: v });
    }
  });
  els.tagInput.value = '';
  renderDraftTags();
  renderTagValueList();
  saveDraft();
  return true;
}

function renderDraftTags() {
  els.draftTags.innerHTML = '';
  state.draftTags.forEach((t, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dim = document.createElement('span');
    dim.className = 'dim'; dim.textContent = t.dimension + ':';
    const val = document.createElement('span');
    val.textContent = t.value;
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×'; x.title = '移除';
    x.addEventListener('click', () => {
      state.draftTags.splice(i, 1);
      renderDraftTags(); saveDraft();
    });
    chip.append(dim, val, x);
    els.draftTags.appendChild(chip);
  });
}

/* =========================================================
 * 保存片段：录制 → 建子文件夹 → 写视频 + meta.json
 * ========================================================= */
async function writeFileTo(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
function sanitize(s) {
  return (s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '').slice(0, 20);
}
function buildFolderName(seq, tags, note) {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes());
  let slug = tags.slice(0, 3).map(t => sanitize(t.value)).join('-');
  if (!slug && note) slug = sanitize(note).slice(0, 14);
  if (!slug) slug = '片段';
  return String(seq).padStart(3, '0') + '_' + stamp + '_' + slug;
}

async function saveClip() {
  if (els.tagInput.value.trim()) addTagsFromInput();
  if (!state.library) return toast('请先选择片段库文件夹');
  if (!state.currentMatchId) return toast('请先选择一场比赛');
  if (state.A == null || state.B == null) return toast('先用 I / O 标记开始和结束');
  const start = Math.min(state.A, state.B);
  const end = Math.max(state.A, state.B);
  const note = els.noteInput.value.trim();
  const tags = state.draftTags.map(t => ({ ...t }));

  /* 编辑已有片段：只重写 meta.json，视频不动 */
  if (state.editingClipId) {
    const clip = state.clips.find(c => c.id === state.editingClipId);
    if (clip) {
      clip.tags = tags; clip.note = note; clip.updatedAt = Date.now();
      const o = Object.assign({}, clip);
      delete o.dirHandle; delete o.videoName;
      await writeFileTo(clip.dirHandle, 'meta.json',
        new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }));
      toast('已更新标签（视频不变）');
    }
    state.editingClipId = null; els.editingHint.textContent = '';
    resetDraftForm();
    await scanLibrary();
    return;
  }

  /* 新片段：优先用边看边录的 Blob，否则实时补录 */
  let blob;
  const wasPlaying = !video.paused;
  if (state.liveRec.blob && state.liveRec.valid &&
      Math.abs((state.liveRec.start || 0) - start) < 0.1) {
    blob = await liveBlobReady();
  } else {
    toast('正在生成片段视频，约 ' + r3(end - start).toFixed(1) + ' 秒');
    try { blob = await renderPass(start, end); }
    catch (e) { return toast('片段生成失败：' + e.message); }
  }

  const id = uid('clip');
  const seq = state.clips.length + 1;
  const folderName = buildFolderName(seq, tags, note);
  const dir = await state.library.getDirectoryHandle(folderName, { create: true });
  const videoFileName = id + '.' + REC_EXT;
  await writeFileTo(dir, videoFileName, blob);

  const now = Date.now();
  const meta = {
    app: 'tactic-lab', version: 2, id,
    folder: folderName, videoFile: videoFileName,
    source: {
      matchId: state.currentMatchId,
      matchTitle: (matchById(state.currentMatchId) || { title: '' }).title,
      fileName: state.currentFile ? state.currentFile.name : '',
      start: r3(start), end: r3(end)
    },
    tags, note,
    duration: r3(end - start),
    createdAt: now, updatedAt: now
  };
  await writeFileTo(dir, 'meta.json',
    new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }));

  /* 回到源视频 B 点继续看，下一段标记不中断 */
  video.playbackRate = state.rate;
  video.currentTime = end;
  if (wasPlaying) video.play().catch(() => {});
  resetDraftForm();
  toast('已保存：' + folderName);
  await scanLibrary();
}

function resetDraftForm() {
  state.draftTags = [];
  els.noteInput.value = '';
  state.A = null; state.B = null;
  resetLiveRec();
  renderDraftTags(); renderAB(); saveDraft();
}

/* =========================================================
 * 入队上传：把当前 A/B 片段写入远端 pending_imports 队列，
 * 供电脑端 node import.js --queue 下载裁剪 + node sync.js 上线
 * 统一走本地 bridge 服务（/queue），前端不再直连 Supabase。
 * ========================================================= */
async function queueClip() {
  if (els.tagInput.value.trim()) addTagsFromInput();
  if (state.A == null || state.B == null) return toast('先用 I / O 标记开始和结束');
  const start = r3(Math.min(state.A, state.B));
  const end = r3(Math.max(state.A, state.B));
  const match = matchById(state.currentMatchId) || {};
  const title = match.title || (state.currentFile ? state.currentFile.name.replace(/\.[^.]+$/, '') : '');
  const note = els.noteInput.value.trim();
  const tags = state.draftTags.map(t => ({ dimension: t.dimension, value: t.value }));

  // 本页面是「本地文件」场景，没有可下载的在线 URL；
  // 用本地文件名做 source_url 占位，供 import.js 识别为「本地文件」来源。
  const source_url = state.currentFile ? ('local://' + state.currentFile.name) : '';

  els.btnQueue.disabled = true;
  els.btnQueue.textContent = '入队中…';
  try {
    const res = await bridge('/queue', {
      provider: 'local',
      source_url,
      title,
      start_sec: start, end_sec: end,
      mode: 'clip',
      tags, note
    });
    if (!res || !res.ok) throw new Error((res && res.error) || '入队失败');
    state.lastQueuedId = res.id;
    toast('已入队 ✓ 回电脑跑 node import.js --queue 下载裁剪，再 node sync.js 上线');
    resetDraftForm();
  } catch (err) {
    toast('入队失败：' + err.message + '（请确认已启动 bridge 服务）');
  } finally {
    els.btnQueue.disabled = false;
    els.btnQueue.textContent = '入队上传';
  }
}

/* 撤回刚入队的那一条（走本地 bridge /delete） */
async function undoQueue() {
  if (!state.lastQueuedId) return toast('没有可撤回的入队记录');
  try {
    const res = await bridge('/delete', { id: state.lastQueuedId });
    if (!res || !res.ok) throw new Error((res && res.error) || '撤回失败');
    toast(res.deleted > 0 ? '已撤回 ✓ 该条已从队列移除' : '未找到该条（可能已处理）');
    state.lastQueuedId = null;
  } catch (err) {
    toast('撤回失败：' + err.message);
  }
}

/* 调用本地 bridge 服务（127.0.0.1:8321） */
function bridge(endpoint, body) {
  return fetch('http://127.0.0.1:8321' + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(r => r.json()).catch(err => { throw err; });
}

/* =========================================================
 * 搜索与结果
 * ========================================================= */
function parseTerms(q) {
  return q.trim().split(/\s+/).filter(Boolean);
}

function clipMatchesTerms(clip, terms) {
  return terms.every(term => {
    const m = term.match(/^([^:：]+)[:：](.+)$/);
    if (m) {
      const d = m[1].trim(), v = m[2].trim();
      return (clip.tags || []).some(t => t.dimension === d && t.value.includes(v));
    }
    return (clip.tags || []).some(t => t.value.includes(term)) ||
           (clip.note || '').includes(term);
  });
}

function currentResults() {
  const terms = parseTerms(els.searchInput.value);
  let list = state.clips.slice();
  if (terms.length) list = list.filter(c => clipMatchesTerms(c, terms));
  list.sort((a, b) => {
    const sa = a.source || {}, sb = b.source || {};
    const ta = sa.matchTitle || '', tb = sb.matchTitle || '';
    return ta === tb ? (sa.start || 0) - (sb.start || 0) : ta.localeCompare(tb, 'zh');
  });
  return { list, terms };
}

function renderResults() {
  const { list, terms } = currentResults();
  state.results = list;
  els.resultCount.textContent = list.length + ' 个案例';
  els.resultsTitle.textContent = terms.length ? '搜索：' + terms.join(' ') : '全部片段';
  els.results.innerHTML = '';

  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty-tip';
    li.textContent = state.clips.length
      ? '没有匹配的片段，换个标签试试'
      : '还没有片段。播放视频时按 I 标记开始、O 标记结束，输入标签后 Enter 保存。';
    els.results.appendChild(li);
    return;
  }

  list.forEach((clip, idx) => {
    const src = clip.source || {};
    const li = document.createElement('li');
    li.className = 'result-item' + (clip.id === state.playingClipId ? ' playing' : '');

    const main = document.createElement('div');
    main.className = 'result-main';
    const title = document.createElement('div');
    title.className = 'result-title';
    const idxSpan = document.createElement('span');
    idxSpan.className = 'idx';
    idxSpan.textContent = String(idx + 1).padStart(2, '0');
    title.appendChild(idxSpan);
    title.appendChild(document.createTextNode(src.matchTitle || '未知来源'));
    const mt = document.createElement('span');
    mt.className = 'mtime';
    mt.textContent = fmt(src.start) + ' → ' + fmt(src.end);
    title.appendChild(mt);

    const sub = document.createElement('div');
    sub.className = 'result-sub';
    (clip.tags || []).forEach(t => {
      const c = document.createElement('span');
      c.className = 'mini-chip';
      c.textContent = t.dimension + ':' + t.value;
      sub.appendChild(c);
    });
    if (clip.note) sub.appendChild(document.createTextNode(clip.note));

    main.append(title, sub);
    main.addEventListener('click', () => { state.resultIndex = idx; playClip(clip); });

    const actions = document.createElement('div');
    actions.className = 'result-actions';
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => editClip(clip));
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => deleteClip(clip));
    actions.append(editBtn, delBtn);

    li.append(main, actions);
    els.results.appendChild(li);
  });
}

function renderHotTags() {
  const freq = new Map();
  state.clips.forEach(c => (c.tags || []).forEach(t => {
    freq.set(t.value, (freq.get(t.value) || 0) + 1);
  }));
  const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
  els.hotTags.innerHTML = '';
  if (!top.length) return;
  top.forEach(([value]) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = value + ' · ' + freq.get(value);
    chip.title = '点击加入搜索';
    chip.addEventListener('click', () => {
      const q = els.searchInput.value.trim();
      els.searchInput.value = q ? q + ' ' + value : value;
      renderResults();
    });
    els.hotTags.appendChild(chip);
  });
}

/* =========================================================
 * 回看片段：直接读取文件夹里的片段视频文件播放循环
 * ========================================================= */
async function playClip(clip) {
  state.playingClipId = clip.id;
  if (state.editingClipId && state.editingClipId !== clip.id) {
    state.editingClipId = null; els.editingHint.textContent = '';
  }
  renderResults();
  try {
    let perm = await clip.dirHandle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await clip.dirHandle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return toast('未授权读取片段文件');
    const fh = await clip.dirHandle.getFileHandle(clip.videoName);
    const file = await fh.getFile();
    loadReviewFile(file);
  } catch (err) {
    toast('片段读取失败，试试重新扫描');
  }
}

function loadReviewFile(file) {
  if (video.src) URL.revokeObjectURL(video.src);
  state.reviewMode = true;
  state.currentFile = null;
  video.src = URL.createObjectURL(file);
  els.placeholder.classList.add('hidden');
  state.A = 0; state.B = null; state.loop = true;
  video.addEventListener('loadedmetadata', () => {
    state.B = video.duration;
    renderAB();
    video.play().catch(() => {});
  }, { once: true });
}

function editClip(clip) {
  state.editingClipId = clip.id;
  state.draftTags = (clip.tags || []).map(t => ({ ...t }));
  els.noteInput.value = clip.note || '';
  els.editingHint.textContent = '编辑模式：改标签/备注后 Enter 保存（视频不变）';
  renderDraftTags(); saveDraft();
  playClip(clip);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function cancelEdit() {
  state.editingClipId = null;
  els.editingHint.textContent = '';
  state.draftTags = [];
  els.noteInput.value = '';
  renderDraftTags();
}

async function deleteClip(clip) {
  if (!confirm('删除文件夹「' + (clip.folder || '') + '」？\n视频和标签文件都会被删除')) return;
  try {
    await clip.dirHandle.remove({ recursive: true });
  } catch (err) {
    return toast('删除失败：' + err.message);
  }
  if (state.playingClipId === clip.id) state.playingClipId = null;
  toast('已删除');
  await scanLibrary();
}

function navClip(delta) {
  const list = state.results.length ? state.results : state.clips;
  if (!list.length) return;
  let idx = list.findIndex(c => c.id === state.playingClipId);
  idx = (idx + delta + list.length) % list.length;
  state.resultIndex = idx;
  playClip(list[idx]);
}

/* =========================================================
 * 比赛管理（源视频）
 * ========================================================= */
function renderMatchSelect() {
  els.matchSelect.innerHTML = '';
  state.matches.forEach(m => {
    const op = document.createElement('option');
    op.value = m.id;
    op.textContent = m.title + (m.fileSize ? '（' + (m.fileSize / 1073741824).toFixed(1) + ' GB）' : '');
    els.matchSelect.appendChild(op);
  });
  if (state.currentMatchId) els.matchSelect.value = state.currentMatchId;
}

async function selectMatch(id, allowRequest) {
  const match = matchById(id);
  if (!match) return;
  state.reviewMode = false;
  if (state.currentMatchId !== id) {
    state.currentFile = null;
    if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
    els.placeholder.classList.remove('hidden');
    clearPoints();
  }
  state.currentMatchId = id;
  els.matchSelect.value = id;
  setStatus('');
  els.btnPickFile.classList.add('hidden');
  await ensureFile(match, allowRequest);
  saveDraft();
}

async function importMatch() {
  if (hasFSAPI) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: '视频文件', accept: { 'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.avi'] } }],
        multiple: false
      });
      const file = await handle.getFile();
      await addMatchFromFile(file, handle);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  els.videoFileInput.dataset.mode = 'import';
  els.videoFileInput.click();
}

async function addMatchFromFile(file, handle) {
  let match = state.matches.find(m => m.fileName === file.name && m.fileSize === file.size);
  if (!match) {
    match = {
      id: uid('match'),
      title: file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name,
      fileSize: file.size,
      lastModified: file.lastModified,
      duration: 0,
      createdAt: Date.now()
    };
    state.matches.push(match);
  }
  if (handle) match.handle = handle;
  await idbPut('matches', match);
  renderMatchSelect();
  await selectMatch(match.id, false);
  attachFile(file, match);
  toast('已导入：' + match.title);
}

/* =========================================================
 * 草稿暂存
 * ========================================================= */
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      matchId: state.currentMatchId,
      A: state.A, B: state.B,
      loop: state.loop, rate: state.rate,
      tags: state.draftTags,
      note: els.noteInput.value
    }));
  } catch (err) {}
}

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (err) { return; }
  if (!d) return;
  if (d.matchId) state.currentMatchId = d.matchId;
  state.A = d.A != null ? d.A : null;
  state.B = d.B != null ? d.B : null;
  state.loop = d.loop !== false;
  state.rate = d.rate || 1;
  state.draftTags = Array.isArray(d.tags) ? d.tags : [];
  els.noteInput.value = d.note || '';
  els.btnLoop.classList.toggle('on', state.loop);
  setRate(state.rate);
  renderDraftTags(); renderAB();
}

/* =========================================================
 * 事件绑定
 * ========================================================= */
function bindEvents() {
  els.matchSelect.addEventListener('change',
    () => selectMatch(els.matchSelect.value, true));
  els.btnPickFile.addEventListener('click', () => {
    const m = matchById(state.currentMatchId);
    if (m) pickFileForMatch(m);
  });
  els.fileStatus.addEventListener('click', () => {
    const m = matchById(state.currentMatchId);
    if (m && els.fileStatus.classList.contains('warn')) pickFileForMatch(m);
  });
  els.btnImportMatch.addEventListener('click', importMatch);

  els.videoFileInput.addEventListener('change', async () => {
    const file = els.videoFileInput.files[0];
    els.videoFileInput.value = '';
    if (!file) return;
    if (els.videoFileInput.dataset.mode === 'import') {
      els.videoFileInput.dataset.mode = '';
      await addMatchFromFile(file, null);
    } else {
      const m = matchById(state.currentMatchId);
      if (m) attachFile(file, m);
    }
  });

  els.btnPickLibrary.addEventListener('click', pickLibrary);
  els.btnRescan.addEventListener('click', () => {
    if (state.library) scanLibrary(); else pickLibrary();
  });
  els.libraryStatus.addEventListener('click', () => {
    if (els.libraryStatus.classList.contains('warn')) requestLibrary();
  });

  els.searchInput.addEventListener('input', renderResults);

  els.btnSetA.addEventListener('click', setA);
  els.btnSetB.addEventListener('click', setB);
  els.btnClearAB.addEventListener('click', clearPoints);
  els.btnSave.addEventListener('click', saveClip);
  els.btnQueue.addEventListener('click', queueClip);
  els.btnUndoQueue.addEventListener('click', undoQueue);
  els.btnBack5s.addEventListener('click', () => step(-5));
  els.btnFwd5s.addEventListener('click', () => step(5));

  document.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) btn.blur();
  }, true);
  els.btnLoop.addEventListener('click', toggleLoop);

  els.btnFullscreen.addEventListener('click', toggleFullscreen);
  els.btnPanelToggle.addEventListener('click', togglePanel);

  video.addEventListener('loadedmetadata', async () => {
    const m = matchById(state.currentMatchId);
    if (m && !m.duration && video.duration) {
      m.duration = video.duration;
      await idbPut('matches', m);
    }
    renderAB();
  });
  video.addEventListener('error', () => {
    if (state.currentFile) setStatus('视频加载失败，请重新选择文件', 'warn');
  });

  els.tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!addTagsFromInput()) saveClip();
    } else if (e.key === 'Escape') els.tagInput.blur();
  });
  els.noteInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveClip(); }
    else if (e.key === 'Escape') els.noteInput.blur();
  });
  els.noteInput.addEventListener('input', saveDraft);

  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (t && t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;

    const k = e.key.toLowerCase();
    switch (k) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'arrowleft': e.preventDefault(); step(e.shiftKey ? -1 : -FRAME); break;
      case 'arrowright': e.preventDefault(); step(e.shiftKey ? 1 : FRAME); break;
      case 'i': setA(); break;
      case 'o': setB(); break;
      case 'q': queueClip(); break;
      case 'enter': e.preventDefault(); saveClip(); break;
      case 'p': toggleLoop(); break;
      case 'f': e.preventDefault(); toggleFullscreen(); break;
      case 'k': togglePlay(); break;
      case 'escape':
        if (document.fullscreenElement) break; // 全屏中：先让浏览器退全屏，不清 A/B
        if (state.editingClipId) cancelEdit();
        else clearPoints();
        break;
    }
  });
}

/* =========================================================
 * 启动
 * ========================================================= */
async function init() {
  db = await openDB();

  state.matches = await idbAll('matches');
  if (!state.matches.length) {
    for (const m of PRESEED_MATCHES) await idbPut('matches', m);
    state.matches = await idbAll('matches');
  }

  renderMatchSelect();
  bindEvents();

  /* 恢复片段库（无手势时只能等用户点击授权） */
  const lib = await kvGet('library');
  if (lib) {
    state.library = lib;
    let p;
    try { p = await lib.queryPermission({ mode: 'readwrite' }); }
    catch (err) { p = 'prompt'; }
    if (p === 'granted') await scanLibrary();
    else setLibraryStatus('点击恢复片段库「' + lib.name + '」', 'warn');
  } else {
    setLibraryStatus('未选择片段库文件夹');
  }

  restoreDraft();
  const first = matchById(state.currentMatchId) || state.matches[0];
  if (first) await selectMatch(first.id, false);

  requestAnimationFrame(rafTick);
}

init().catch(err => {
  console.error(err);
  setStatus('初始化失败：' + err.message, 'warn');
});

