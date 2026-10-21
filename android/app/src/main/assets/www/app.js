'use strict';

/* 码上取 —— 前端逻辑（零依赖） */

const $ = (sel) => document.querySelector(sel);

const state = {
  token: localStorage.getItem('msq_token') || '',
  items: [],
  stores: [],
  stats: { pending: 0, picked: 0, expiring: 0, expired: 0 },
  filter: { status: 'pending', store: '', q: '', sort: 'arrivedAt' },
  page: 'pickup',
  selected: null,
  batchResults: [],
  seenIds: new Set(),
  settings: { defaultExpiryDays: 3 },
};

const DAY = 24 * 60 * 60 * 1000;

/* ---------- 工具 ---------- */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2600) {
  const wrap = $('#toastWrap');
  // 相同内容的提示先移除，避免连续操作时堆叠
  [...wrap.children].forEach((el) => { if (el.textContent === msg) el.remove(); });
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  return ok;
}

async function copyWithToast(text, label) {
  const ok = await copyText(text);
  toast(ok ? (label + '已复制') : '复制失败，请长按手动复制');
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function expiryInfo(p) {
  if (p.status === 'picked') return { text: '已取', cls: 'ok' };
  const t = new Date(p.expiresAt).getTime() - Date.now();
  if (isNaN(t)) return { text: '', cls: '' };
  if (t < 0) return { text: '已过期', cls: 'danger' };
  const days = Math.ceil(t / DAY);
  if (days <= 1) return { text: '今日到期', cls: 'warn' };
  if (days <= 3) return { text: '剩' + days + '天', cls: 'warn' };
  return { text: '剩' + days + '天', cls: '' };
}

/* ---------- API ---------- */
/**
 * API 基地址。
 * 浏览器访问时页面与 API 同源，返回空串（相对路径即可）。
 * WebView 以 file:///android_asset/www/ 加载页面时，页面自身没有源，
 * 必须用配置的服务地址拼出完整 URL，否则 /api 会解析到文件系统根而失败。
 */
function apiBase() {
  if (location.protocol !== 'file:') return '';
  const base = localStorage.getItem('msq_server') || '';
  return base ? base.replace(/\/+$/, '') : '';
}

/** 当前是否运行在 App 的 WebView 里（file:// 协议） */
function isNativeShell() {
  return location.protocol === 'file:';
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  headers['X-Auth-Token'] = state.token;

  // file:// 下没有服务端地址就直接抛错，交给离线逻辑处理，不必发无谓请求
  const base = apiBase();
  if (isNativeShell() && !base) {
    const err = new Error('尚未配置服务地址');
    err.noServer = true;
    throw err;
  }

  const res = await fetch(base + '/api' + path, { ...opts, headers, body });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (res.status === 401) {
    const err = new Error(data.message || 'unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data.message || data.error || '请求失败');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- 主题（自动 / 浅色 / 深色） ---------- */
const THEME_KEY = 'msq_theme';
const THEMES = ['auto', 'light', 'dark'];

function currentTheme() {
  const t = localStorage.getItem(THEME_KEY);
  return THEMES.includes(t) ? t : 'auto';
}

function applyTheme(t) {
  const theme = THEMES.includes(t) ? t : 'auto';
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('#themeTabsProfile .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeOpt === theme);
  });
  // 地址栏配色取实际计算值，避免在 JS 里硬编码色号
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  }
}

function setTheme(t) {
  localStorage.setItem(THEME_KEY, t);
  applyTheme(t);
}

/* ---------- 离线缓存与待同步队列 ---------- */
const OFFLINE_KEY = 'msq_cache_v1';
const QUEUE_KEY = 'msq_queue_v1';
let offlineMode = false;

function isOffline() { return offlineMode; }

function setOffline(v) {
  if (offlineMode === v) return;
  offlineMode = v;
  renderOfflineBar();
}

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeQueue(arr) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(arr)); } catch (e) { /* ignore */ }
}

function queueLength() { return readQueue().length; }

/** 入队一个待同步操作（同一条记录的状态改动只保留最后一次） */
function enqueue(entry) {
  const q = readQueue();
  const idx = q.findIndex((e) => e.path === entry.path && (e.op === 'patch' || e.op === 'delete'));
  if ((entry.op === 'patch') && idx >= 0) q[idx] = { ...entry, at: Date.now() };
  else q.push({ ...entry, at: Date.now() });
  writeQueue(q);
  renderOfflineBar();
}

/** 重放队列：串行执行，失败则保留该条及之后的，等下次联网重试 */
async function flushQueue() {
  const q = readQueue();
  if (q.length === 0) { setOffline(false); return { ok: 0, failed: 0 }; }
  let ok = 0;
  const remain = [];
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    try {
      await api(e.path, { method: e.method, body: e.body });
      ok += 1;
    } catch (err) {
      if (err.unauthorized) { remain.push(...q.slice(i)); break; }
      // 记录已在服务端消失：丢弃该操作，避免卡死队列
      if (err.status === 404) { ok += 1; continue; }
      remain.push(...q.slice(i));
      break;
    }
  }
  writeQueue(remain);
  renderOfflineBar();
  return { ok, failed: remain.length };
}

function saveCache(items, stores, stats) {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify({ items, stores, stats, savedAt: Date.now() }));
  } catch (e) { /* 配额满忽略 */ }
}

function readCache() {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && Array.isArray(d.items) ? d : null;
  } catch (e) { return null; }
}

/** 顶栏连接状态指示器 */
function renderConnState() {
  const wrap = $('#connState');
  const txt = $('#connText');
  if (!wrap || !txt) return;
  const pending = queueLength();
  wrap.classList.remove('online', 'offline', 'pending');
  if (offlineMode) {
    wrap.classList.add('offline');
    txt.textContent = pending > 0 ? '离线 · ' + pending : '离线';
    wrap.title = '未连接服务器' + (pending > 0 ? '，' + pending + ' 项待同步' : '');
  } else if (pending > 0) {
    wrap.classList.add('pending');
    txt.textContent = '同步中 · ' + pending;
    wrap.title = pending + ' 项待上传';
  } else {
    wrap.classList.add('online');
    txt.textContent = '在线';
    wrap.title = '已连接服务器';
  }
}

/** 离线提示条 */
function renderOfflineBar() {
  renderConnState();
  const el = $('#offlineBar');
  if (!el) return;
  const pending = queueLength();
  if (!offlineMode && pending === 0) { el.hidden = true; return; }
  el.hidden = false;
  if (offlineMode) {
    // 局域网 http 下 SW 不可用，刷新页面就进不来，明确提示用户别关页面
    const warn = swAvailable() ? '' : '（勿关闭或刷新本页）';
    el.textContent = pending > 0
      ? '📴 离线模式 · ' + pending + ' 项待同步，联网后自动上传' + warn
      : '📴 离线模式 · 正在显示本地缓存' + warn;
    el.className = 'offline-bar warn';
  } else {
    el.textContent = '🔄 正在同步 ' + pending + ' 项…';
    el.className = 'offline-bar sync';
  }
}

/**
 * 写操作统一入口：联网时直接发；断网时入队并返回 { queued: true }。
 * 调用方据此决定是否乐观更新界面。
 */
async function mutate(path, method, body, op) {
  try {
    const data = await api(path, { method, body });
    return { ok: true, data };
  } catch (err) {
    if (err.unauthorized) throw err;
    // 网络层失败（无 status 说明没到服务端）→ 入队
    if (!err.status) {
      enqueue({ op: op || method.toLowerCase(), path, method, body });
      setOffline(true);
      return { ok: true, queued: true };
    }
    throw err;
  }
}

/** 本地重算统计（离线乐观更新后调用，避免数字不准） */
function recalcStats() {
  let pending = 0, picked = 0;
  for (const p of state.items) {
    if (p.status === 'picked') { picked += 1; continue; }
    pending += 1;
  }
  state.stats.pending = pending;
  state.stats.picked = picked;
}

/**
 * 服务器连通性探测。
 * 用 /api/health（无需口令、服务端不缓存）判断，比「请求没抛错」可靠：
 * 断网时 fetch 会抛 TypeError；服务端挂了也会抛。只有真正拿到响应才算在线。
 */
async function probeServer() {
  const base = apiBase();
  if (isNativeShell() && !base) return false;   // WebView 未配置地址时视为离线
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(base + '/api/health?_=' + Date.now(), {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    return res.ok;
  } catch (e) {
    return false;
  }
}

/* ---------- 数据加载 ---------- */
async function loadAll({ silent = false } = {}) {
  const params = new URLSearchParams();
  if (state.filter.status) params.set('status', state.filter.status);
  if (state.filter.store) params.set('store', state.filter.store);
  if (state.filter.q) params.set('q', state.filter.q);
  params.set('sort', state.filter.sort);

  // 有积压的离线操作：先上传，再拉取，避免把旧数据覆盖回去
  if (queueLength() > 0) {
    try { await flushQueue(); } catch (e) { /* 失败则继续走离线分支 */ }
  }

  let data;
  try {
    data = await api('/packages?' + params.toString());
    setOffline(false);
    saveCache(data.items || [], data.stores || [], data.stats || {});
  } catch (err) {
    if (err.unauthorized) throw err;  // 口令问题交给上层处理
    // 网络不可用：先用缓存渲染
    setOffline(true);
    const cached = readCache();
    if (cached) {
      state.items = cached.items || [];
      state.stores = cached.stores || [];
      state.stats = cached.stats || state.stats;
      renderAll();
      if (!silent) toast('📴 已断网，显示本地缓存');
    } else {
      renderAll();
      if (!silent) toast('📴 已断网，且无本地缓存');
    }
    return;
  }

  const before = new Set(state.items.map((i) => i.id));
  state.items = data.items || [];
  state.stores = data.stores || [];
  state.stats = data.stats || state.stats;
  const fresh = data.items.filter((i) => !before.has(i.id) && i.status === 'pending');
  renderAll();
  // 「新到 N 个取件码」的屏幕提示会遮挡卡片，已按要求移除。
  // 系统通知（手机通知栏）不遮挡界面，保留。
  if (fresh.length && !silent) {
    notifySystem(fresh);
  }
}

function notifySystem(items) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && window.isSecureContext) {
      const names = items.slice(0, 2).map((i) => (i.store || '驿站') + ' ' + i.code).join('，');
      new Notification('码上取：新到取件码', { body: names, icon: './icons/icon-192.png' });
    }
  } catch (e) { /* ignore */ }
}

/* ---------- 渲染 ---------- */
function renderAll() {
  renderStats();
  renderTabs();
  renderSort();
  renderBanner();
  renderStores();
  renderList();
  renderPage();
  renderProfile();
}

/* ---------- 页面路由（底栏：取件 / 全部 / 我的） ---------- */
const PAGES = ['pickup', 'all', 'mine'];

/*
 * 三个页面共用同一个 #list，任何时刻 DOM 里只有一份卡片。
 * 「取件」页用顶栏的 待取/已取 标签切换；「全部」页把 status 设为 all；
 * 「我的」页隐藏列表与顶栏，只显示个人页内容。
 */
function renderPage() {
  const page = PAGES.includes(state.page) ? state.page : 'pickup';
  state.page = page;
  const isMine = page === 'mine';
  $('#appHeader').hidden = isMine;
  $('#listWrap').hidden = isMine;
  $('#profilePage').hidden = !isMine;
  $('#fab').hidden = isMine;
  $('#statusTabs').hidden = page === 'all';
  $('#pageTitle').textContent = isMine ? '我的' : (page === 'all' ? '全部包裹' : '📦 码上取');
  document.querySelectorAll('#bottomNav .nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page);
  });
  const blob = $('#navBlob');
  if (blob) blob.style.setProperty('--blob-x', Math.max(0, PAGES.indexOf(page)) * 100 + '%');
}

function renderProfile() {
  const s = state.stats || {};
  $('#pfPending').textContent = s.pending || 0;
  $('#pfPicked').textContent = s.picked || 0;
  $('#pfTotal').textContent = (s.pending || 0) + (s.picked || 0);
  $('#pfUrl').textContent = state.lanUrl || location.origin;
  // 复用 applyTheme 同步选中态，避免两处逻辑不一致
  applyTheme(currentTheme());
  // 局域网地址按需拉取一次（手机要用它登录，localhost 对它无效）
  if (!state.lanUrl) {
    api('/config').then((cfg) => {
      state.lanUrl = pickLanUrl(cfg);
      const el = $('#pfUrl');
      if (el) el.textContent = state.lanUrl;
    }).catch(() => { /* 离线时保持 origin */ });
  }
}

/* 从「我的」页的统计卡跳转到对应列表 */
function jumpToStatus(status) {
  // 清掉可能残留的筛选，避免跳过去是空的
  state.filter.store = '';
  state.filter.q = '';
  const si = $('#searchInput');
  if (si) si.value = '';

  if (status === 'all') {
    state.page = 'all';
    state.filter.status = 'all';
  } else {
    state.page = 'pickup';
    state.filter.status = status === 'picked' ? 'picked' : 'pending';
  }
  renderPage();
  const blob = $('#navBlob');
  if (blob) {
    blob.classList.remove('squash');
    void blob.offsetWidth;
    blob.classList.add('squash');
  }
  loadAll().catch((err) => toast('加载失败：' + err.message));
}

/* 底栏切页：更新指示块（水滴动画由 .squash 触发）并按需加载数据 */
function navTo(page) {  if (!PAGES.includes(page) || page === state.page) return;
  state.page = page;
  if (page === 'all') state.filter.status = 'all';
  else if (page === 'pickup' && state.filter.status === 'all') state.filter.status = 'pending';
  renderPage();
  const blob = $('#navBlob');
  if (blob) {
    blob.classList.remove('squash');
    void blob.offsetWidth; // 强制重排，让动画可重复触发
    blob.classList.add('squash');
  }
  if (page === 'mine') { renderProfile(); return; }
  loadAll().catch((err) => toast('加载失败：' + err.message));
}

/* 到期提醒横幅：今日到期 / 已过期 的待取包裹 */
function renderBanner() {
  const el = $('#expiryBanner');
  const { expiring, expired } = state.stats;
  if (!expiring && !expired) {
    el.hidden = true;
    el.className = 'expiry-banner';
    return;
  }
  const parts = [];
  if (expired) parts.push('🔴 ' + expired + ' 个取件码已过期');
  if (expiring) parts.push('⏰ ' + expiring + ' 个今日到期');
  el.textContent = parts.join('，') + '（点击查看）';
  el.className = 'expiry-banner ' + (expired ? 'danger' : 'warn');
  el.hidden = false;
}

function renderSort() {
  document.querySelectorAll('#sortRow .sort-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === state.filter.sort);
  });
}

function renderStats() {
  $('#statBadge').textContent = '待取 ' + state.stats.pending;
  document.title = (state.stats.pending ? '(' + state.stats.pending + ') ' : '') + '码上取';
  $('#tabPending').textContent = state.stats.pending ? ' ' + state.stats.pending : '';
}

function renderTabs() {
  document.querySelectorAll('#statusTabs .tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === state.filter.status);
  });
}

function renderStores() {
  const wrap = $('#storeChips');
  const chips = [];
  chips.push(`<button class="chip${state.filter.store ? '' : ' active'}" data-store="">全部门店</button>`);
  for (const s of state.stores) {
    const active = state.filter.store === s.store;
    chips.push(`<button class="chip${active ? ' active' : ''}" data-store="${esc(s.store)}">${esc(s.store)}${s.pending ? ' (' + s.pending + ')' : ''}</button>`);
  }
  wrap.innerHTML = chips.join('');
}

function renderList() {
  const list = $('#list');
  const empty = $('#emptyState');
  if (!state.items.length) {
    list.innerHTML = '';
    empty.hidden = false;
    const q = state.filter.q, st = state.filter.store;
    if (q) {
      empty.innerHTML = '<div class="big">🔍</div>没有找到匹配「' + esc(q) + '」的记录<br>试试快递单号、取件码或门店名称';
    } else if (st) {
      empty.innerHTML = '<div class="big">📭</div>「' + esc(st) + '」暂无记录';
    } else if (state.filter.status === 'pending') {
      empty.innerHTML = '<div class="big">🎉</div>没有待取的包裹<br>点击右下角 ＋ 添加，或开启短信自动提取';
    } else {
      empty.innerHTML = '<div class="big">📭</div>暂无记录';
    }
    return;
  }
  empty.hidden = true;
  list.innerHTML = '';
  for (const p of state.items) {
    const el = document.createElement('div');
    el.className = 'card ' + (p.status === 'picked' ? 'picked' : 'pending');
    el.dataset.id = p.id;
    el.innerHTML = cardInnerHTML(p);
    if (p.status === 'pending') {
      // 待取卡片支持左滑标记已取
      enableSwipe(el, () => pickPackage(p), () => openDetail(p.id));
    } else {
      el.addEventListener('click', () => openDetail(p.id));
    }
    list.appendChild(el);
  }
}

function cardInnerHTML(p) {
  const exp = expiryInfo(p);
  return `<div class="swipe-hint">已取 ✓</div>
    <div class="card-top">
      <span class="store">${esc(p.store || '未指定门店')}</span>
      <span class="expiry ${exp.cls}">${exp.text}</span>
    </div>
    <div class="card-code-row">
      <span class="code">${esc(p.code)}</span>
      <button class="btn-copy" data-copy="code" data-id="${esc(p.id)}" data-label="取件码">复制</button>
    </div>
    <div class="card-meta">
      ${p.carrier ? `<span class="chip-mini">${esc(p.carrier)}</span>` : ''}
      ${p.tracking ? `<span class="tracking" data-copy="tracking" data-id="${esc(p.id)}" data-label="单号">${esc(p.tracking)}</span>` : ''}
      <span class="time">${fmtTime(p.arrivedAt)} 到</span>
    </div>
    ${p.note ? `<div class="card-note">📝 ${esc(p.note)}</div>` : ''}`;
}

/* 左滑标记已取（触屏 + 鼠标统一用 Pointer Events） */
function enableSwipe(el, onPick, onClick) {
  let startX = null;
  let startY = null;
  let dx = 0;
  let moved = false;
  const hint = el.querySelector('.swipe-hint');
  const setHint = (v) => { if (hint) hint.style.opacity = String(v); };

  el.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    moved = false;
    el.style.transition = 'none';
    if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
  });
  el.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    // 纵向滚动优先：手势以纵向为主则放弃，交给页面滚动
    if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > 10) {
      startX = null;
      el.style.transform = '';
      setHint(0);
      return;
    }
    dx = Math.max(-220, Math.min(80, mx)); // 只允许左滑
    if (Math.abs(dx) > 8) moved = true;
    el.style.transform = 'translateX(' + dx + 'px)';
    setHint(dx < 0 ? Math.min(1, -dx / 120) : 0);
  });
  const end = () => {
    if (startX === null) return;
    startX = null;
    if (dx < -80) {
      el.style.transition = 'transform .25s ease';
      el.style.transform = 'translateX(-120%)';
      setHint(0);
      onPick();
    } else {
      el.style.transition = 'transform .2s ease';
      el.style.transform = '';
      setHint(0);
      setTimeout(() => { el.style.transition = ''; }, 220);
    }
    dx = 0;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => {
    startX = null;
    dx = 0;
    moved = false;
    el.style.transition = 'transform .2s ease';
    el.style.transform = '';
    setHint(0);
  });
  el.addEventListener('click', (e) => {
    if (moved) { moved = false; return; }
    if (e.target.closest('[data-copy]')) return; // 复制按钮交给委托处理
    onClick();
  });
}

async function pickPackage(p) {
  try {
    const r = await mutate('/packages/' + p.id, 'PATCH', { status: 'picked' }, 'patch');
    toast(r.queued ? '已取走 🎉（离线，联网后同步）' : '已取走 🎉');
    if (r.queued) {
      // 离线：本地先行更新，界面立即反映
      const it = state.items.find((x) => x.id === p.id);
      if (it) { it.status = 'picked'; it.pickedAt = new Date().toISOString(); }
      state.stats.pending = Math.max(0, (state.stats.pending || 1) - 1);
      state.stats.picked = (state.stats.picked || 0) + 1;
      renderAll();
      saveCache(state.items, state.stores, state.stats);
      return;
    }
    await loadAll();
  } catch (e) {
    toast('操作失败：' + e.message);
    const el = document.querySelector('.card[data-id="' + p.id + '"]');
    if (el) {
      el.style.transition = 'transform .2s ease';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 220);
    }
  }
}

function getItem(id) {
  return state.items.find((i) => i.id === id) || null;
}

/* ---------- 面板 ---------- */
function openSheet(id) {
  $('#backdrop').hidden = false;
  $('#' + id).hidden = false;
}
function closeSheets() {
  document.querySelectorAll('.sheet-panel').forEach((s) => (s.hidden = true));
  $('#backdrop').hidden = true;
}

/* ---------- 登录 ---------- */
function showLogin(msg) {
  $('#loginOverlay').hidden = false;
  if (msg) { $('#loginError').textContent = msg; $('#loginError').hidden = false; }
  setTimeout(() => $('#loginToken').focus(), 60);
}
function hideLogin() {
  $('#loginOverlay').hidden = true;
  $('#loginError').hidden = true;
}

async function tryLogin(t) {
  state.token = t;
  try {
    const cfg = await api('/config');
    state.settings = cfg.settings || state.settings;
    localStorage.setItem('msq_token', t);
    hideLogin();
    await loadAll();
    toast('登录成功，数据已同步');
    return true;
  } catch (e) {
    state.token = '';
    showLogin(e.unauthorized ? '口令不正确，请重试' : '无法连接服务端：' + e.message);
    return false;
  }
}

/* ---------- 详情 ---------- */
function openDetail(id) {
  const p = getItem(id);
  if (!p) return;
  state.selected = p;
  $('#dCode').textContent = p.code;
  const rows = [
    ['门店', p.store || '未指定门店'],
    ['快递公司', p.carrier || '—'],
    ['快递单号', p.tracking || '—'],
    ['来源', p.platform || '—'],
    ['到达时间', fmtTime(p.arrivedAt) || '—'],
    ['到期时间', fmtTime(p.expiresAt) || '—'],
  ];
  $('#dGrid').innerHTML = rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${esc(v)}</div>`).join('');
  const note = $('#dNote');
  if (p.note) {
    note.hidden = false;
    note.textContent = '📝 ' + p.note;
  } else {
    note.hidden = true;
  }
  const photo = $('#dPhoto');
  if (p.photo) {
    photo.hidden = false;
    photo.src = p.photo;
  } else {
    photo.hidden = true;
    photo.removeAttribute('src');
  }
  const raw = $('#dRaw');
  if (p.raw) {
    raw.hidden = false;
    raw.textContent = '原始短信：' + p.raw;
  } else {
    raw.hidden = true;
  }
  $('#dToggle').textContent = p.status === 'picked' ? '恢复待取' : '标记已取 ✓';
  openSheet('sheetDetail');
}

/* ---------- 编辑取件信息 ---------- */
/** ISO 字符串 → datetime-local 输入框所需格式（本地时区，YYYY-MM-DDTHH:mm） */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function openEditInfo() {
  const p = state.selected;
  if (!p) return;
  $('#eiStore').value = p.store || '';
  $('#eiCode').value = p.code || '';
  $('#eiCarrier').value = p.carrier || '';
  $('#eiTracking').value = p.tracking || '';
  $('#eiPlatform').value = p.platform || '';
  $('#eiExpiresAt').value = toLocalInput(p.expiresAt);
  openSheet('sheetEditInfo');
}

async function saveEditInfo() {
  const p = state.selected;
  if (!p) return;
  const code = $('#eiCode').value.trim();
  if (!code) { toast('取件码不能为空'); return; }

  const patch = {
    store: $('#eiStore').value.trim(),
    code,
    carrier: $('#eiCarrier').value.trim(),
    tracking: $('#eiTracking').value.trim(),
    platform: $('#eiPlatform').value.trim(),
  };

  // 到期时间：仅在用户确实填写时提交（转回 ISO）
  const exp = $('#eiExpiresAt').value;
  if (exp) {
    const d = new Date(exp);
    if (isNaN(d.getTime())) { toast('到期时间格式不正确'); return; }
    patch.expiresAt = d.toISOString();
  }

  const r = await mutate('/packages/' + p.id, 'PATCH', patch, 'patch');
  if (r.queued) {
    Object.assign(p, patch);
    saveCache(state.items, state.stores, state.stats);
    toast('已保存修改（离线，联网后同步）');
  } else {
    Object.assign(p, r.data.item);
    toast('已保存修改');
  }
  closeSheets();
  openDetail(p.id);
  if (!r.queued) await loadAll({ silent: true });
}

/* ---------- 备注编辑 ---------- */
let editPhotoData = '';

function openEditNote() {
  const p = state.selected;
  if (!p) return;
  $('#editNote').value = p.note || '';
  editPhotoData = p.photo || '';
  renderEditPhotoPreview();
  openSheet('sheetEditNote');
}

function renderEditPhotoPreview() {
  const img = $('#editPhotoPreview');
  const rm = $('#btnEditPhotoRemove');
  if (editPhotoData) {
    img.src = editPhotoData;
    img.hidden = false;
    rm.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    rm.hidden = true;
  }
}

/** 图片压缩：最长边 600px、JPEG、质量逐级降低直到 ≤150KB */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const maxSide = 600;
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          const scale = maxSide / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.7;
        let data = canvas.toDataURL('image/jpeg', quality);
        while (data.length > 155 * 1024 && quality > 0.3) {
          quality -= 0.15;
          data = canvas.toDataURL('image/jpeg', quality);
        }
        if (data.length > 200 * 1024) {
          // 极限压缩仍超限则拒绝
          const c2 = document.createElement('canvas');
          c2.width = Math.round(width * 0.6);
          c2.height = Math.round(height * 0.6);
          c2.getContext('2d').drawImage(img, 0, 0, c2.width, c2.height);
          data = c2.toDataURL('image/jpeg', 0.6);
        }
        resolve(data);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function saveEditNote() {
  const p = state.selected;
  if (!p) return;
  const note = $('#editNote').value.trim();
  try {
    const r = await mutate('/packages/' + p.id, 'PATCH', { note, photo: editPhotoData }, 'patch');
    if (r.queued) {
      p.note = note;
      p.photo = editPhotoData;
      saveCache(state.items, state.stores, state.stats);
      toast('备注已保存（离线，联网后同步）');
    } else {
      toast('备注已保存');
    }
    closeSheets();
    if (!r.queued) await loadAll();
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}

/* ---------- 手动添加 ---------- */
function resetManualForm() {
  $('#fStore').value = '';
  $('#fCode').value = '';
  $('#fCarrier').value = '';
  $('#fTracking').value = '';
  $('#fPlatform').value = '';
  $('#fNote').value = '';
  $('#fExpiry').value = state.settings.defaultExpiryDays || 3;
}

async function saveManual() {
  const body = {
    store: $('#fStore').value.trim(),
    code: $('#fCode').value.trim(),
    carrier: $('#fCarrier').value.trim(),
    tracking: $('#fTracking').value.trim(),
    platform: $('#fPlatform').value.trim(),
    note: $('#fNote').value.trim(),
    expiresDays: Number($('#fExpiry').value) || undefined,
  };
  if (!body.code) { toast('请填写取件码'); return; }
  try {
    const r = await mutate('/packages', 'POST', body, 'add');
    if (r.queued) {
      // 离线：本地插入一条临时记录（pendingId 标记，联网重放后由服务端记录取代）
      const now = new Date().toISOString();
      const days = body.expiresDays || state.settings.defaultExpiryDays || 3;
      state.items.unshift({
        id: 'local_' + Date.now().toString(36),
        store: body.store, code: body.code, carrier: body.carrier,
        tracking: body.tracking, platform: body.platform, note: body.note,
        photo: '', status: 'pending', createdAt: now, arrivedAt: now,
        expiresAt: new Date(Date.now() + days * DAY).toISOString(),
        source: 'manual-offline', raw: '', pendingId: true,
      });
      state.stats.pending = (state.stats.pending || 0) + 1;
      renderAll();
      saveCache(state.items, state.stores, state.stats);
      toast('✅ 已添加（离线，联网后同步）：' + body.code);
    } else {
      toast('✅ 已添加：' + body.code);
    }
    closeSheets();
    resetManualForm();
    if (!r.queued) await loadAll();
  } catch (e) {
    toast(e.message === 'duplicate' ? '⚠️ ' + e.message.replace('duplicate', '该记录已存在') : '⚠️ ' + e.message);
  }
}

/* ---------- 批量粘贴 ---------- */
async function parseBatch() {
  const text = $('#batchText').value;
  if (!text.trim()) { toast('请先粘贴短信内容'); return; }
  // 解析依赖服务端规则库，断网时无法预览
  if (isOffline()) { toast('📴 离线状态无法解析，请先联网'); return; }
  const data = await api('/parse', { method: 'POST', body: { text } });
  state.batchResults = data.results || [];
  const okCount = state.batchResults.filter((r) => r.ok).length;
  const wrap = $('#batchPreview');
  wrap.innerHTML = state.batchResults.map((r, i) => {
    if (r.ok) {
      return `<div class="preview-row"><span class="pc">${esc(r.code)}</span><span class="ps">${esc(r.store || '未指定门店')}${r.carrier ? ' · ' + esc(r.carrier) : ''}${r.tracking ? ' · ' + esc(r.tracking) : ''}</span><span style="color:var(--ok)">✓</span></div>`;
    }
    return `<div class="preview-row fail"><span class="pc">—</span><span class="ps">${esc(r.line || '')}</span><button class="btn-copy" data-teach="${i}">教学</button></div>`;
  }).join('');
  $('#btnBatchAdd').hidden = okCount === 0;
  $('#btnBatchAdd').textContent = '确认添加 ' + okCount + ' 条';
  toast('解析完成：成功 ' + okCount + ' 条' + (state.batchResults.length - okCount ? '，失败 ' + (state.batchResults.length - okCount) + ' 条' : ''));
}

async function confirmBatch() {
  const items = state.batchResults
    .filter((r) => r.ok)
    .map((r) => ({
      store: r.store, code: r.code, carrier: r.carrier,
      tracking: r.tracking, platform: r.platform || '短信粘贴',
      arrivedAt: r.arrivedAt, source: 'sms-paste', raw: r.line,
    }));
  if (!items.length) return;
  const r0 = await mutate('/packages/batch', 'POST', { items }, 'batch');
  closeSheets();
  $('#batchText').value = '';
  $('#batchPreview').innerHTML = '';
  $('#btnBatchAdd').hidden = true;
  if (r0.queued) {
    // 离线：本地先插入，联网后由服务端查重合并
    const now = new Date().toISOString();
    const days = state.settings.defaultExpiryDays || 3;
    for (const it of items) {
      state.items.unshift({
        id: 'local_' + Math.random().toString(36).slice(2),
        store: it.store || '', code: it.code, carrier: it.carrier || '',
        tracking: it.tracking || '', platform: it.platform || '', note: '',
        photo: '', status: 'pending', createdAt: now,
        arrivedAt: it.arrivedAt || now,
        expiresAt: new Date(Date.now() + days * DAY).toISOString(),
        source: it.source || 'sms-paste', raw: it.raw || '', pendingId: true,
      });
    }
    recalcStats();
    renderAll();
    saveCache(state.items, state.stores, state.stats);
    toast('✅ 已添加 ' + items.length + ' 条（离线，联网后同步）');
    return;
  }
  const data = r0.data;
  const skipCount = (data.skipped || []).length;
  toast('✅ 已添加 ' + data.added.length + ' 条' + (skipCount ? '，跳过重复 ' + skipCount + ' 条' : ''));
  await loadAll();
}

/* ---------- AI 教学（自定义识别规则） ---------- */
function openTeach(line) {
  $('#teachSample').value = line || '';
  $('#teachCode').value = '';
  $('#teachStore').value = '';
  $('#teachResult').textContent = '';
  openSheet('sheetTeach');
}

async function teachSave() {
  const sample = $('#teachSample').value.trim();
  const code = $('#teachCode').value.trim();
  const store = $('#teachStore').value.trim();
  if (!sample || !code) { $('#teachResult').textContent = '请填写取件码'; return; }
  $('#teachResult').textContent = '验证中…';
  try {
    const data = await api('/rules', { method: 'POST', body: { sample, code, store } });
    $('#teachResult').textContent = '✅ 已记住：' + (data.rule.codeBefore || '开头') + '『取件码』' + (data.rule.codeAfter || '结尾');
    toast('已记住这类短信格式 🎓');
  } catch (e) {
    $('#teachResult').textContent = '❌ ' + e.message;
  }
}

async function renderRules() {
  const wrap = $('#rulesList');
  let rules = [];
  try { rules = (await api('/rules')).rules || []; } catch (e) { wrap.innerHTML = ''; return; }
  if (!rules.length) {
    wrap.innerHTML = '<span class="muted">暂无自定义规则</span>';
    return;
  }
  wrap.innerHTML = rules.map((r) =>
    `<div class="rule-item">
       <span class="rule-pat">${esc(r.codeBefore || '')}<b>取件码</b>${esc(r.codeAfter || '')}</span>
       <span class="muted">命中 ${r.matched} 次</span>
       <button class="btn-outline small" data-delrule="${esc(r.id)}">删除</button>
     </div>`
  ).join('');
}

/* ---------- 驿站管理 ---------- */
async function openStoresManage() {
  renderStoresManage();
  openSheet('sheetStores');
}

function renderStoresManage() {
  const wrap = $('#storesManageList');
  const stores = state.stores || [];
  if (!stores.length) {
    wrap.innerHTML = '<p class="muted">暂无驿站分类。</p>';
    return;
  }
  wrap.innerHTML = stores.map((s) => `
    <div class="rule-item store-mgr" data-store="${esc(s.store)}">
      <span class="rule-pat">${esc(s.store)}</span>
      <span class="muted">${s.pending ? s.pending + ' 待取 / ' : ''}${s.total} 条</span>
      <button class="btn-outline small" data-act="rename">改名</button>
      <button class="btn-danger small" data-act="delete">删除</button>
    </div>`
  ).join('');
}

async function deleteStoreByName(name) {
  if (isOffline()) { toast('📴 驿站管理需要联网，请先连接服务器'); return; }
  const n = (state.stores || []).find((s) => s.store === name);
  const count = n ? n.total : 0;
  if (!confirm('确定删除驿站「' + name + '」及其全部 ' + count + ' 条包裹记录吗？此操作不可恢复。')) return;
  await api('/stores', { method: 'DELETE', body: { store: name } });
  toast('已删除「' + name + '」' + count + ' 条包裹');
  await loadAll();
  renderStoresManage();
}

async function renameStorePrompt(oldName) {
  if (isOffline()) { toast('📴 驿站管理需要联网，请先连接服务器'); return; }
  const newName = prompt('把「' + oldName + '」改名为（同名包裹会合并）：', oldName);
  if (!newName || newName.trim() === '' || newName.trim() === oldName) return;
  await api('/stores/rename', { method: 'POST', body: { from: oldName, to: newName.trim() } });
  toast('已改名并合并');
  await loadAll();
  renderStoresManage();
}

/* ---------- 设置 ---------- */
/** 选出最适合「其他设备访问」的地址：排除虚拟网卡，优先真实局域网 IPv4 */
function pickLanUrl(cfg) {
  const urls = (cfg && cfg.lanUrls) || [];
  // 虚拟网卡常见网段：VMware(192.168.62/117/137/138)、VirtualBox(192.168.56)
  const virtual = /^http:\/\/192\.168\.(56|62|117|137|138)\./;
  const real = urls.find((u) => !virtual.test(u));
  return real || urls[0] || location.origin;
}

async function openSettings() {
  const cfg = await api('/config').catch(() => ({ settings: {} }));
  state.settings = cfg.settings || state.settings;
  state.lanUrl = pickLanUrl(cfg);
  $('#setUrl').textContent = state.lanUrl;
  $('#setToken').textContent = state.token;
  $('#setExpiry').value = state.settings.defaultExpiryDays || 3;
  renderRules();
  openSheet('sheetSettings');
}

async function saveSettings() {
  const v = Number($('#setExpiry').value);
  if (!(v >= 1 && v <= 30)) { toast('有效天数需在 1~30 之间'); return; }
  const data = await api('/settings', { method: 'POST', body: { defaultExpiryDays: v } });
  state.settings = data.settings;
  toast('设置已保存');
  await loadAll();
}

function exportData() {
  api('/export').then((data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mashangqu-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('备份已导出');
  }).catch((e) => toast('导出失败：' + e.message));
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.packages)) throw new Error('格式不正确');
    if (!confirm('导入将替换当前全部数据（原数据会自动备份到服务端 data 目录），确定继续？')) return;
    const result = await api('/import', { method: 'POST', body: { data } });
    toast('✅ 已导入 ' + result.count + ' 条记录');
    await loadAll();
  } catch (e) {
    toast('导入失败：' + e.message);
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 登录
  $('#btnLogin').addEventListener('click', () => tryLogin($('#loginToken').value.trim()));
  $('#loginToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(e.target.value.trim()); });
  $('#btnTogglePwd').addEventListener('click', () => {
    const input = $('#loginToken');
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    $('#btnTogglePwd').textContent = showing ? '显示' : '隐藏';
    input.focus();
  });

  // 顶栏
  // 同步按钮：先上传积压的离线操作，再拉取最新数据
  $('#btnRefresh').addEventListener('click', async () => {
    const btn = $('#btnRefresh');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    const pending = queueLength();
    try {
      if (pending > 0) {
        const r = await flushQueue();
        if (r.failed > 0) {
          toast('已同步 ' + r.ok + ' 项，' + r.failed + ' 项待重试');
        } else {
          toast('已同步 ' + r.ok + ' 项离线操作');
        }
      }
      await loadAll();
      if (pending === 0) toast('已同步最新数据');
    } catch (e) {
      toast('同步失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  });
  $('#btnSettings').addEventListener('click', () => openSettings().catch((e) => toast(e.message)));
  $('#btnStoresManage').addEventListener('click', () => openStoresManage().catch((e) => toast(e.message)));
  $('#btnCopyUrlProfile').addEventListener('click', () => copyWithToast(state.lanUrl || location.origin, '服务地址'));

  // 「我的」页统计卡：点击跳转到对应列表
  $('#profilePage').addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) jumpToStatus(b.dataset.goto);
  });

  // 驿站管理列表：改名 / 删除
  $('#storesManageList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.store-mgr');
    if (!row) return;
    const name = row.dataset.store;
    if (btn.dataset.act === 'rename') renameStorePrompt(name).catch((e) => toast(e.message));
    else if (btn.dataset.act === 'delete') deleteStoreByName(name).catch((e) => toast(e.message));
  });

  // 底部导航：取件 / 全部 / 我的
  $('#bottomNav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b) navTo(b.dataset.page);
  });
  $('#btnSearch').addEventListener('click', doSearch);
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // 主题切换（我的页）
  $('#themeTabsProfile').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (b && b.dataset.themeOpt) setTheme(b.dataset.themeOpt);
  });

  // 标签页 / 门店
  $('#statusTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.filter.status = b.dataset.status;
    state.page = b.dataset.status === 'all' ? 'all' : 'pickup';
    loadAll().catch((err) => toast(err.message));
  });
  // 门店 chips：单击筛选，长按弹删除确认（「全部门店」不可删）
  let chipPressTimer = null;
  let chipPressTarget = null;
  let chipLongPressed = false;
  $('#storeChips').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.chip');
    if (!b || !b.dataset.store) return; // 空 data-store = 「全部门店」
    chipPressTarget = b;
    chipLongPressed = false;
    chipPressTimer = setTimeout(() => {
      chipPressTimer = null;
      chipLongPressed = true;
      const name = chipPressTarget.dataset.store;
      chipPressTarget = null;
      const entry = (state.stores || []).find((s) => s.store === name);
      const count = entry ? entry.total : 0;
      if (confirm('删除驿站「' + name + '」及其 ' + count + ' 条包裹记录？此操作不可恢复。')) {
        deleteStoreByName(name).catch((err) => toast(err.message));
      }
    }, 550);
  });
  $('#storeChips').addEventListener('pointerup', () => { if (chipPressTimer) { clearTimeout(chipPressTimer); chipPressTimer = null; } chipPressTarget = null; });
  $('#storeChips').addEventListener('pointerleave', () => { if (chipPressTimer) { clearTimeout(chipPressTimer); chipPressTimer = null; } chipPressTarget = null; });
  $('#storeChips').addEventListener('click', (e) => {
    if (chipLongPressed) { chipLongPressed = false; return; } // 长按松手后不触发筛选
    const b = e.target.closest('.chip');
    if (!b) return;
    state.filter.store = b.dataset.store;
    loadAll().catch((err) => toast(err.message));
  });

  // 排序切换
  $('#sortRow').addEventListener('click', (e) => {
    const b = e.target.closest('.sort-btn');
    if (!b || b.dataset.sort === state.filter.sort) return;
    state.filter.sort = b.dataset.sort;
    loadAll().catch((err) => toast(err.message));
  });

  // 到期横幅：点击回到待取视图
  $('#expiryBanner').addEventListener('click', () => {
    state.filter.status = 'pending';
    state.page = 'pickup';
    state.filter.store = '';
    state.filter.q = '';
    $('#searchInput').value = '';
    loadAll().catch((err) => toast(err.message));
  });

  // 列表：复制按钮（卡片点击/滑动已由卡片自身绑定）
  $('#list').addEventListener('click', async (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      const p = getItem(copyBtn.dataset.id);
      if (p) copyWithToast(p[copyBtn.dataset.copy], copyBtn.dataset.label || '');
      e.stopPropagation();
      return;
    }
  });

  // 详情操作
  $('#dCopyCode').addEventListener('click', () => state.selected && copyWithToast(state.selected.code, '取件码'));
  $('#dEdit').addEventListener('click', openEditNote);
  $('#btnEditNoteSave').addEventListener('click', () => saveEditNote().catch((e) => toast(e.message)));
  $('#btnEditPhoto').addEventListener('click', () => $('#editPhotoFile').click());
  $('#btnEditPhotoRemove').addEventListener('click', () => { editPhotoData = ''; renderEditPhotoPreview(); });
  $('#editPhotoFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      toast('压缩中…');
      editPhotoData = await compressImage(file);
      renderEditPhotoPreview();
    } catch (err) {
      toast('图片处理失败：' + err.message);
    }
  });
  $('#dToggle').addEventListener('click', async () => {
    const p = state.selected;
    if (!p) return;
    const next = p.status === 'picked' ? 'pending' : 'picked';
    try {
      const r = await mutate('/packages/' + p.id, 'PATCH', { status: next }, 'patch');
      if (r.queued) {
        p.status = next;
        p.pickedAt = next === 'picked' ? new Date().toISOString() : null;
        recalcStats();
        saveCache(state.items, state.stores, state.stats);
        renderAll();
      }
      closeSheets();
      toast((next === 'picked' ? '已标记取走 🎉' : '已恢复待取') + (r.queued ? '（离线，联网后同步）' : ''));
      if (!r.queued) await loadAll();
    } catch (e) {
      toast('操作失败：' + e.message);
    }
  });
  $('#dEditInfo').addEventListener('click', () => openEditInfo());
  $('#btnEditInfoSave').addEventListener('click', () => saveEditInfo().catch((e) => toast('保存失败：' + e.message)));
  $('#dDelete').addEventListener('click', async () => {
    const p = state.selected;
    if (!p) return;
    if (!confirm('确定删除 ' + p.code + ' 这条记录？')) return;
    try {
      const r = await mutate('/packages/' + p.id, 'DELETE', undefined, 'delete');
      if (r.queued) {
        // 离线删除：本地先行移除
        state.items = state.items.filter((x) => x.id !== p.id);
        recalcStats();
        saveCache(state.items, state.stores, state.stats);
        renderAll();
      }
      closeSheets();
      toast('已删除' + (r.queued ? '（离线，联网后同步）' : ''));
      if (!r.queued) await loadAll();
    } catch (e) {
      toast('删除失败：' + e.message);
    }
  });

  // 面板关闭
  document.querySelectorAll('.sheet-close').forEach((b) =>
    b.addEventListener('click', () => closeSheets())
  );
  $('#backdrop').addEventListener('click', closeSheets);

  // FAB + 添加
  $('#fab').addEventListener('click', () => {
    resetManualForm();
    switchAddTab('manual');
    $('#batchText').value = '';
    $('#batchPreview').innerHTML = '';
    $('#btnBatchAdd').hidden = true;
    openSheet('sheetAdd');
  });
  $('#addTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-atab]');
    if (b) switchAddTab(b.dataset.atab);
  });
  function switchAddTab(name) {
    $('#addManual').hidden = name !== 'manual';
    $('#addBatch').hidden = name !== 'batch';
    document.querySelectorAll('#addTabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.atab === name)
    );
  }
  $('#btnAddSave').addEventListener('click', saveManual);
  $('#btnBatchParse').addEventListener('click', () => parseBatch().catch((e) => toast('解析失败：' + e.message)));
  $('#btnBatchAdd').addEventListener('click', () => confirmBatch().catch((e) => toast('添加失败：' + e.message)));

  // AI 教学
  $('#batchPreview').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-teach]');
    if (!btn) return;
    const r = state.batchResults[Number(btn.dataset.teach)];
    if (r) openTeach(r.line || '');
  });
  $('#btnTeachSave').addEventListener('click', () => teachSave().catch((e) => toast('保存失败：' + e.message)));
  $('#rulesList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delrule]');
    if (!btn) return;
    if (!confirm('删除这条识别规则？')) return;
    await api('/rules/' + btn.dataset.delrule, { method: 'DELETE' });
    toast('已删除规则');
    renderRules();
  });

  // 设置
  $('#btnCopyUrl').addEventListener('click', () => copyWithToast(state.lanUrl || location.origin, '服务地址'));
  $('#btnSaveSettings').addEventListener('click', () => saveSettings().catch((e) => toast(e.message)));
  $('#btnExport').addEventListener('click', exportData);
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
}

function doSearch() {
  state.filter.q = $('#searchInput').value.trim();
  loadAll().catch((e) => toast(e.message));
}

/* ---------- 轮询（多手机同步 + 新到提醒） ---------- */
function startPolling() {
  setInterval(() => {
    if (document.hidden) return;
    loadAll({ silent: true }).catch(() => { /* 网络抖动忽略 */ });
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadAll({ silent: true }).catch(() => {});
  });

  // 独立连通性探测：即使 loadAll 因某种原因"看似成功"，
  // 也能在服务器真正不可达时把状态纠正为离线。
  setInterval(async () => {
    if (document.hidden) return;
    const alive = await probeServer();
    if (!alive && !isOffline()) {
      setOffline(true);
    } else if (alive && isOffline() && queueLength() === 0) {
      // 服务器恢复了：自动同步并刷新
      setOffline(false);
      loadAll({ silent: true }).catch(() => {});
    }
  }, 30000);
}

/* ---------- 启动 ---------- */
/*
 * Service Worker 只在「安全上下文」可用：https 协议，或 localhost / 127.0.0.1。
 * 局域网 http://192.168.x.x 属于不安全上下文，浏览器直接拒绝注册（W3C 规范，
 * 服务端无法绕过）。
 *
 * 影响：断网后若刷新或重开页面，浏览器拿不到 HTML/CSS/JS，页面打不开。
 * 已打开的页面不受影响（localStorage 数据缓存与离线队列仍然可用）。
 * 彻底解决需 App（资源打包进 APK）或为服务配置 HTTPS。
 */
function swAvailable() {
  return 'serviceWorker' in navigator && (
    location.protocol === 'https:' ||
    ['localhost', '127.0.0.1'].includes(location.hostname)
  );
}

function registerSW() {
  if (!swAvailable()) return;
  navigator.serviceWorker.register('/sw.js').catch(() => { /* 忽略 */ });
}

(async function init() {
  applyTheme(currentTheme());
  renderOfflineBar();
  bindEvents();

  // 联网恢复时自动重放离线队列
  window.addEventListener('online', async () => {
    if (queueLength() === 0) { setOffline(false); return; }
    try {
      const r = await flushQueue();
      if (r.ok > 0) toast('🔄 已同步 ' + r.ok + ' 项离线操作');
      await loadAll({ silent: true });
    } catch (e) { /* 下次再试 */ }
  });
  window.addEventListener('offline', () => setOffline(true));
  registerSW();

  /*
   * WebView 外壳（file:// 加载）：
   * 原生层会把服务地址与口令放进 URL 查询串或 localStorage，
   * 这里先同步到 state，再走与浏览器一致的登录流程。
   */
  if (isNativeShell()) {
    const server = localStorage.getItem('msq_server') || '';
    if (!server) {
      // 未配置服务地址：本地模式下也要能看界面，走离线渲染
      setOffline(true);
      const cached = readCache();
      if (cached) {
        state.items = cached.items || [];
        state.stores = cached.stores || [];
        state.stats = cached.stats || state.stats;
      }
      renderAll();
      toast('未连接服务器，正在显示本地缓存');
      return;
    }
  }

  if (state.token) {
    try {
      const cfg = await api('/config');
      state.settings = cfg.settings || state.settings;
      await loadAll();
      startPolling();
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
      return;
    } catch (e) {
      if (!e.unauthorized) {
        // 连不上服务端：有缓存就先进离线模式，别把用户挡在登录框外
        const cached = readCache();
        if (cached && state.token) {
          setOffline(true);
          state.items = cached.items || [];
          state.stores = cached.stores || [];
          state.stats = cached.stats || state.stats;
          renderAll();
          startPolling();
          toast('📴 无法连接服务端，显示本地缓存');
          return;
        }
        showLogin('无法连接服务端：' + e.message);
        return;
      }
    }
  }
  showLogin();
})();
