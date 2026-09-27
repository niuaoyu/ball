'use strict';

/* =========================================================
 * 战术片段库 · V1
 * 本地优先：视频留本机，片段 = 比赛 + 起止时间 + 多维度标签
 * 存储：IndexedDB（只存元数据，绝不存视频 Blob）
 * ========================================================= */

/* ---------- 常量 ---------- */
const FRAME = 1 / 30;                 // 「约一帧」的步长，可按视频实际帧率改
const DB_NAME = 'tactic-lab';
const DB_VERSION = 1;
const DRAFT_KEY = 'tactic-lab:draft';
const BACKUP_KEY = 'tactic-lab:last-backup';
const RATES = [0.25, 0.5, 1];
const DEFAULT_DIMS = ['战术', '掩护人', '持球人结果', '掩护人结果', '防守', '进攻区域', '球队', '球员'];

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
  clips: [],
  currentMatchId: null,
  currentFile: null,        // File 对象，仅内存
  A: null,
  B: null,
  loop: true,
  rate: 1,
  draftTags: [],            // [{dimension, value}]
  editingClipId: null,
  results: [],
  resultIndex: -1,
  playingClipId: null,
  pendingClip: null         // 等待文件关联后再播放的片段
};

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const video = $('video');
const els = {
  matchSelect: $('matchSelect'),
  btnImportMatch: $('btnImportMatch'),
  btnPickFile: $('btnPickFile'),
  fileStatus: $('fileStatus'),
  btnExport: $('btnExport'),
  btnImportJson: $('btnImportJson'),
  jsonFileInput: $('jsonFileInput'),
  backupHint: $('backupHint'),
  searchInput: $('searchInput'),
  resultCount: $('resultCount'),
  hotTags: $('hotTags'),
  placeholder: $('videoPlaceholder'),
  timeNow: $('timeNow'),
  timeTotal: $('timeTotal'),
  timeline: $('timeline'),
  abRange: $('abRange'),
  playhead: $('playhead'),
  btnSetA: $('btnSetA'),
  btnSetB: $('btnSetB'),
  labelA: $('labelA'),
  labelB: $('labelB'),
  btnClearAB: $('btnClearAB'),
  btnSave: $('btnSave'),
  btnPrevFrame: $('btnPrevFrame'),
  btnBack1s: $('btnBack1s'),
  btnPlay: $('btnPlay'),
  btnFwd1s: $('btnFwd1s'),
  btnNextFrame: $('btnNextFrame'),
  btnLoop: $('btnLoop'),
  speedBtns: Array.from(document.querySelectorAll('.speed')),
  btnPrevClip: $('btnPrevClip'),
  btnNextClip: $('btnNextClip'),
  dimSelect: $('dimSelect'),
  tagInput: $('tagInput'),
  tagValueList: $('tagValueList'),
  draftTags: $('draftTags'),
  noteInput: $('noteInput'),
  editingHint: $('editingHint'),
  resultsTitle: $('resultsTitle'),
  results: $('results'),
  videoFileInput: $('videoFileInput'),
  toast: $('toast')
};

/* ---------- 小工具 ---------- */
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

/* ---------- IndexedDB 薄封装（仅存元数据） ---------- */
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

/* ---------- 文件关联 ---------- */
const hasFSAPI = typeof window.showOpenFilePicker === 'function';

function matchById(id) {
  return state.matches.find(m => m.id === id) || null;
}

function verifyFile(file, match) {
  const problems = [];
  if (match.fileName && file.name !== match.fileName) problems.push('文件名不同');
  if (match.fileSize && file.size !== match.fileSize) problems.push('文件大小不同');
  if (match.lastModified && Math.abs(file.lastModified - match.lastModified) > 2000) {
    // 修改时间容差 2 秒，仅提示不阻止
  }
  if (problems.length) {
    return confirm('所选文件与记录不匹配（' + problems.join('、') + '）。\n仍要关联到「' + match.title + '」吗？');
  }
  return true;
}

function attachFile(file, match) {
  if (!verifyFile(file, match)) return false;
  if (video.src) URL.revokeObjectURL(video.src);
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
        match.handle = handle;          // 句柄随比赛记录持久化，下次自动恢复
        await idbPut('matches', match);
      }
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;   // 用户取消
      // 不支持或出错时降级到 input
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
    return false;   // 句柄失效（文件被移动/删除等）
  }
}

/* 选中一场比赛后的文件恢复流程 */
async function ensureFile(match, allowRequest) {
  if (state.currentFile) return true;
  setStatus('正在恢复视频文件…');
  const ok = await restoreFromHandle(match, allowRequest);
  if (ok) return true;
  setStatus('待关联：' + (match.fileName || '点击右侧按钮选择视频'), 'warn');
  els.btnPickFile.classList.remove('hidden');
  return false;
}

/* ---------- A / B 标记 ---------- */
function setA() {
  if (!state.currentFile) return toast('请先关联视频文件');
  state.A = video.currentTime;
  if (state.B != null && state.B <= state.A) state.B = null;
  renderAB();
  saveDraft();
}

function setB() {
  if (!state.currentFile) return toast('请先关联视频文件');
  if (state.A == null) return toast('先按 I 标记开始点');
  state.B = video.currentTime;
  if (state.B <= state.A) { const t = state.A; state.A = state.B; state.B = t; }
  renderAB();
  saveDraft();
  els.tagInput.focus();     // 标完结束点直接进标签输入，支撑 10 秒流程
}

function clearPoints() {
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
  const dur = video.duration || 0;
  if (state.A != null && state.B != null && dur > 0) {
    els.abRange.style.display = 'block';
    els.abRange.style.left = (state.A / dur * 100) + '%';
    els.abRange.style.width = ((state.B - state.A) / dur * 100) + '%';
  } else {
    els.abRange.style.display = 'none';
  }
}

/* ---------- 播放控制 ---------- */
function togglePlay() {
  if (!state.currentFile) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function step(dt) {
  if (!state.currentFile) return;
  video.pause();
  const t = Math.min(Math.max(video.currentTime + dt, 0), video.duration || 0);
  video.currentTime = t;
}

function setRate(r) {
  state.rate = r;
  video.playbackRate = r;   // 循环回跳不影响速率
  els.speedBtns.forEach(b => b.classList.toggle('active', parseFloat(b.dataset.rate) === r));
}

function toggleLoop() {
  state.loop = !state.loop;
  els.btnLoop.classList.toggle('on', state.loop);
  toast(state.loop ? '循环：开' : '循环：关');
  saveDraft();
}

/* A-B 循环 + 时间显示：requestAnimationFrame 判定（timeupdate 粒度太粗） */
let lastPaused = null;
function rafTick() {
  if (state.loop && state.A != null && state.B != null && !video.paused && !video.seeking) {
    if (video.currentTime >= state.B) {
      video.currentTime = state.A;
    }
  }
  els.timeNow.textContent = fmt(video.currentTime);
  const dur = video.duration || 0;
  if (dur > 0) {
    els.playhead.style.left = (video.currentTime / dur * 100) + '%';
  }
  /* 只在播放状态变化时更新按钮文字——每帧重绘会打断按钮激活态，导致 Space 失效 */
  if (lastPaused !== video.paused) {
    lastPaused = video.paused;
    els.btnPlay.innerHTML = (video.paused ? '播放' : '暂停') + ' <kbd>Space</kbd>';
  }
  requestAnimationFrame(rafTick);
}

/* ---------- 标签编辑 ---------- */
function allDimensions() {
  const set = new Set(DEFAULT_DIMS);
  state.clips.forEach(c => (c.tags || []).forEach(t => set.add(t.dimension)));
  return Array.from(set);
}

function renderDimSelect() {
  const cur = els.dimSelect.value;
  els.dimSelect.innerHTML = '';
  allDimensions().forEach(d => {
    const op = document.createElement('option');
    op.value = d;
    op.textContent = d;
    els.dimSelect.appendChild(op);
  });
  const custom = document.createElement('option');
  custom.value = '__new__';
  custom.textContent = '+ 新维度…';
  els.dimSelect.appendChild(custom);
  if (cur && allDimensions().includes(cur)) els.dimSelect.value = cur;
}

function renderTagValueList() {
  const dim = els.dimSelect.value;
  const set = new Set();
  state.clips.forEach(c => (c.tags || []).forEach(t => {
    if (!dim || dim === '__new__' || t.dimension === dim) set.add(t.value);
  }));
  els.tagValueList.innerHTML = '';
  Array.from(set).sort().forEach(v => {
    const op = document.createElement('option');
    op.value = v;
    els.tagValueList.appendChild(op);
  });
}

function addTagsFromInput() {
  const raw = els.tagInput.value.trim();
  if (!raw) return false;
  const dim = els.dimSelect.value === '__new__' ? '战术' : els.dimSelect.value;
  raw.split(/[\s,，、]+/).filter(Boolean).forEach(word => {
    let d = dim, v = word;
    const m = word.match(/^([^:：]+)[:：](.+)$/);   // 支持「维度:值」内联写法
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
    dim.className = 'dim';
    dim.textContent = t.dimension + ':';
    const val = document.createElement('span');
    val.textContent = t.value;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = '移除';
    x.addEventListener('click', () => {
      state.draftTags.splice(i, 1);
      renderDraftTags();
      saveDraft();
    });
    chip.append(dim, val, x);
    els.draftTags.appendChild(chip);
  });
}

/* ---------- 保存片段 ---------- */
async function saveClip() {
  if (els.tagInput.value.trim()) addTagsFromInput();   // 输入框里还有内容就先收进标签
  if (!state.currentMatchId) return toast('请先选择一场比赛');
  if (state.A == null || state.B == null) return toast('先用 I / O 标记开始和结束');
  const start = Math.min(state.A, state.B);
  const end = Math.max(state.A, state.B);
  const note = els.noteInput.value.trim();

  if (state.editingClipId) {
    const clip = state.clips.find(c => c.id === state.editingClipId);
    if (clip) {
      Object.assign(clip, {
        start, end, note,
        tags: state.draftTags.map(t => ({ ...t })),
        updatedAt: Date.now()
      });
      await idbPut('clips', clip);
      toast('已更新片段');
    }
    state.editingClipId = null;
    els.editingHint.textContent = '';
  } else {
    const clip = {
      id: uid('clip'),
      matchId: state.currentMatchId,
      start, end, note,
      tags: state.draftTags.map(t => ({ ...t })),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await idbPut('clips', clip);
    state.clips.push(clip);
    toast('已保存（' + clip.tags.length + ' 个标签）');
  }

  /* 保存后清空草稿、留在原位继续播放——标记下一段不中断 */
  state.draftTags = [];
  els.noteInput.value = '';
  clearPoints();
  renderDraftTags();
  saveDraft();
  renderResults();
  renderHotTags();
}

/* ---------- 搜索与结果 ---------- */
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
    const ma = matchById(a.matchId), mb = matchById(b.matchId);
    const ta = ma ? ma.title : '', tb = mb ? mb.title : '';
    return ta === tb ? a.start - b.start : ta.localeCompare(tb, 'zh');
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
    const match = matchById(clip.matchId);
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
    title.appendChild(document.createTextNode((match ? match.title : '未知比赛')));
    const mt = document.createElement('span');
    mt.className = 'mtime';
    mt.textContent = fmt(clip.start) + ' → ' + fmt(clip.end);
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
  top.forEach(([value, count]) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = value + ' · ' + count;
    chip.title = '点击加入搜索';
    chip.addEventListener('click', () => {
      const q = els.searchInput.value.trim();
      els.searchInput.value = q ? q + ' ' + value : value;
      renderResults();
    });
    els.hotTags.appendChild(chip);
  });
}

/* ---------- 播放指定片段 ---------- */
async function playClip(clip) {
  state.playingClipId = clip.id;
  if (state.editingClipId && state.editingClipId !== clip.id) {
    state.editingClipId = null;
    els.editingHint.textContent = '';
  }
  renderResults();

  if (clip.matchId !== state.currentMatchId) {
    await selectMatch(clip.matchId, true);
  }
  if (!state.currentFile) {
    state.pendingClip = clip;   // 文件关联成功后自动续播
    toast('请先关联「' + (matchById(clip.matchId) || {}).title + '」的视频文件');
    return;
  }

  state.A = clip.start;
  state.B = clip.end;
  if (!state.loop) toggleLoop();
  renderAB();
  video.playbackRate = state.rate;
  video.currentTime = clip.start;
  video.play().catch(() => {});
}

function editClip(clip) {
  state.editingClipId = clip.id;
  state.A = clip.start;
  state.B = clip.end;
  state.draftTags = (clip.tags || []).map(t => ({ ...t }));
  els.noteInput.value = clip.note || '';
  els.editingHint.textContent = '正在编辑已有片段，修改后按 Enter 保存；点其他片段可取消编辑';
  renderAB();
  renderDraftTags();
  saveDraft();
  if (clip.matchId === state.currentMatchId && state.currentFile) {
    video.currentTime = clip.start;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteClip(clip) {
  if (!confirm('删除这个片段？（' + fmt(clip.start) + ' → ' + fmt(clip.end) + '）')) return;
  await idbDel('clips', clip.id);
  state.clips = state.clips.filter(c => c.id !== clip.id);
  if (state.playingClipId === clip.id) state.playingClipId = null;
  renderResults();
  renderHotTags();
  renderTagValueList();
  toast('已删除');
}

function navClip(delta) {
  const list = state.results.length ? state.results : state.clips;
  if (!list.length) return;
  let idx = state.resultIndex;
  if (idx < 0 || idx >= list.length || list[idx].id !== state.playingClipId) {
    idx = list.findIndex(c => c.id === state.playingClipId);
  }
  idx = (idx + delta + list.length) % list.length;
  state.resultIndex = idx;
  playClip(list[idx]);
}

/* ---------- 比赛管理 ---------- */
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
  /* 同名同大小则视为已存在，直接切换 */
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

/* ---------- JSON 导出 / 导入 ---------- */
function exportJSON() {
  const data = {
    app: 'tactic-lab',
    version: 1,
    exportedAt: new Date().toISOString(),
    matches: state.matches.map(m => {
      const { handle, ...rest } = m;   // 句柄不可序列化，导出时剔除
      return rest;
    }),
    clips: state.clips
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = 'tactic-lab-backup-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  localStorage.setItem(BACKUP_KEY, String(Date.now()));
  renderBackupHint();
  toast('已导出 ' + state.clips.length + ' 个片段');
}

async function importJSON(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    return toast('文件不是有效的 JSON');
  }
  if (!data || data.app !== 'tactic-lab' || !Array.isArray(data.clips)) {
    return toast('不是本工具导出的备份文件');
  }
  let nm = 0, nc = 0;
  for (const m of data.matches || []) {
    if (!m.id) continue;
    const old = matchById(m.id);
    await idbPut('matches', old ? Object.assign(old, m, { handle: old.handle }) : m);
    nm++;
  }
  for (const c of data.clips) {
    if (!c.id || !c.matchId) continue;
    await idbPut('clips', c);
    nc++;
  }
  state.matches = await idbAll('matches');
  state.clips = await idbAll('clips');
  renderMatchSelect();
  renderResults();
  renderHotTags();
  renderDimSelect();
  renderTagValueList();
  toast('导入完成：' + nm + ' 场比赛，' + nc + ' 个片段');
}

function renderBackupHint() {
  const last = parseInt(localStorage.getItem(BACKUP_KEY) || '0', 10);
  if (!state.clips.length) { els.backupHint.textContent = ''; return; }
  if (!last) {
    els.backupHint.textContent = '尚未备份过';
    return;
  }
  const days = Math.floor((Date.now() - last) / 86400000);
  els.backupHint.textContent = days >= 7 ? '已 ' + days + ' 天未备份' : (days === 0 ? '今天已备份' : days + ' 天前备份');
}

/* ---------- 草稿（未保存的 A/B 点与标签） ---------- */
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      matchId: state.currentMatchId,
      A: state.A, B: state.B,
      loop: state.loop,
      rate: state.rate,
      tags: state.draftTags,
      note: els.noteInput.value
    }));
  } catch (err) { /* 忽略配额错误 */ }
}

function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (err) { return; }
  if (!d) return;
  if (d.matchId) state.currentMatchId = d.matchId;   // 恢复到上次的比赛
  state.A = d.A != null ? d.A : null;
  state.B = d.B != null ? d.B : null;
  state.loop = d.loop !== false;
  state.rate = d.rate || 1;
  state.draftTags = Array.isArray(d.tags) ? d.tags : [];
  els.noteInput.value = d.note || '';
  els.btnLoop.classList.toggle('on', state.loop);
  setRate(state.rate);
  renderDraftTags();
  renderAB();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  els.matchSelect.addEventListener('change', () => selectMatch(els.matchSelect.value, true));
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

  els.btnExport.addEventListener('click', exportJSON);
  els.btnImportJson.addEventListener('click', () => els.jsonFileInput.click());
  els.jsonFileInput.addEventListener('change', () => {
    const f = els.jsonFileInput.files[0];
    els.jsonFileInput.value = '';
    if (f) importJSON(f);
  });

  els.searchInput.addEventListener('input', renderResults);

  els.btnSetA.addEventListener('click', setA);
  els.btnSetB.addEventListener('click', setB);
  els.btnClearAB.addEventListener('click', clearPoints);
  els.btnSave.addEventListener('click', saveClip);

  els.btnPlay.addEventListener('click', togglePlay);
  els.btnPrevFrame.addEventListener('click', () => step(-FRAME));
  els.btnNextFrame.addEventListener('click', () => step(FRAME));
  els.btnBack1s.addEventListener('click', () => step(-1));
  els.btnFwd1s.addEventListener('click', () => step(1));
  video.addEventListener('click', togglePlay);   // 点击画面 = 播放/暂停

  /* 任何按钮点击后自动失焦，保证 Space / I / O 等快捷键始终作用于播放器 */
  document.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) btn.blur();
  }, true);
  els.btnLoop.addEventListener('click', toggleLoop);
  els.speedBtns.forEach(b => b.addEventListener('click', () => setRate(parseFloat(b.dataset.rate))));
  els.btnPrevClip.addEventListener('click', () => navClip(-1));
  els.btnNextClip.addEventListener('click', () => navClip(1));

  els.timeline.addEventListener('pointerdown', e => {
    if (!video.duration) return;
    const rect = els.timeline.getBoundingClientRect();
    const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    video.currentTime = ratio * video.duration;
  });

  video.addEventListener('loadedmetadata', async () => {
    els.timeTotal.textContent = fmt(video.duration);
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

  els.dimSelect.addEventListener('change', () => {
    if (els.dimSelect.value === '__new__') {
      const name = prompt('新维度名称（例如：防守强度）');
      if (name && name.trim()) {
        DEFAULT_DIMS.push(name.trim());
        renderDimSelect();
        els.dimSelect.value = name.trim();
      } else {
        renderDimSelect();
      }
    }
    renderTagValueList();
  });

  els.tagInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!addTagsFromInput()) saveClip();   // 空输入再按 Enter = 保存
    } else if (e.key === 'Escape') {
      els.tagInput.blur();
    }
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
    /* 焦点在按钮上时，Enter/Space 交给原生 click，避免触发两次 */
    if (t && t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;

    const k = e.key.toLowerCase();
    switch (k) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'arrowleft': e.preventDefault(); step(e.shiftKey ? -1 : -FRAME); break;
      case 'arrowright': e.preventDefault(); step(e.shiftKey ? 1 : FRAME); break;
      case 'i': setA(); break;
      case 'o': setB(); break;
      case 'enter': e.preventDefault(); saveClip(); break;
      case 'escape': clearPoints(); break;
      case 'j': {
        const i = RATES.indexOf(state.rate);
        setRate(RATES[Math.max(i - 1, 0)]);
        break;
      }
      case 'k': togglePlay(); break;
      case 'l':
        if (e.shiftKey) toggleLoop();
        else {
          const i = RATES.indexOf(state.rate);
          setRate(RATES[Math.min(i + 1, RATES.length - 1)]);
        }
        break;
      case ',': navClip(-1); break;
      case '.': navClip(1); break;
    }
  });
}

/* ---------- 启动 ---------- */
async function init() {
  db = await openDB();

  state.matches = await idbAll('matches');
  if (!state.matches.length) {
    for (const m of PRESEED_MATCHES) await idbPut('matches', m);
    state.matches = await idbAll('matches');
  }
  state.clips = await idbAll('clips');

  renderMatchSelect();
  renderDimSelect();
  renderTagValueList();
  renderResults();
  renderHotTags();
  renderBackupHint();
  bindEvents();
  restoreDraft();

  const first = matchById(state.currentMatchId) || state.matches[0];
  if (first) await selectMatch(first.id, false);   // 页面加载无手势，只做静默恢复

  requestAnimationFrame(rafTick);
}

init().catch(err => {
  console.error(err);
  setStatus('初始化失败：' + err.message, 'warn');
});
