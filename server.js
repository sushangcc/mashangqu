'use strict';

/**
 * 码上取 —— 自托管服务端
 * 零依赖：仅使用 Node.js 内置模块
 *
 * 配置（环境变量或 config.json，环境变量优先）：
 *   PORT            监听端口，默认 8000
 *   HOST            监听地址，默认 ::（双栈，同时接受 IPv4 与 IPv6）
 *   TOKEN           访问口令；未配置时自动生成并保存到 data/token.txt
 *   EXPIRY_DAYS     取件码默认有效天数，默认 3
 *   DATA_DIR        数据目录，默认 ./data
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './lib/store.js';
import { parseSms, parseTextLines, buildCustomRule, applyCustomRules } from './lib/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 配置 ----------
const configFile = path.join(__dirname, 'config.json');
let fileConfig = {};
if (fs.existsSync(configFile)) {
  try { fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch (e) { console.error('[config] config.json 解析失败:', e.message); }
}
const env = process.env;
const PORT = Number(env.PORT || fileConfig.port || 8000);
/*
 * 默认监听 ::（IPv6 通配）。Node 在支持双栈的系统上会同时接受 IPv4 连接，
 * 这样局域网 IPv4 与外网 IPv6 都能访问。若系统不支持双栈导致启动失败，
 * 下面的 server.on('error') 会回退到 0.0.0.0。
 */
const HOST = env.HOST || fileConfig.host || '::';
const TOKEN = env.TOKEN || fileConfig.token || '';
const DEFAULT_EXPIRY_DAYS = Number(env.EXPIRY_DAYS || fileConfig.expiryDays || 3);
const DATA_DIR = env.DATA_DIR || fileConfig.dataDir || path.join(__dirname, 'data');

const store = new JsonStore(DATA_DIR).load();

// 启动自动备份：每天最多一次，保留最近 7 份
(function startupBackup() {
  const file = path.join(DATA_DIR, 'db.json');
  if (!fs.existsSync(file)) return;
  const today = new Date().toISOString().slice(0, 10);
  const backup = path.join(DATA_DIR, 'backup-startup-' + today + '.json');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(backup)) {
      fs.copyFileSync(file, backup);
      console.log('[backup] 启动备份 ->', path.basename(backup));
    }
    const backups = fs.readdirSync(DATA_DIR)
      .filter((f) => f.startsWith('backup-startup-'))
      .sort();
    while (backups.length > 7) {
      fs.unlinkSync(path.join(DATA_DIR, backups.shift()));
    }
  } catch (e) {
    console.error('[backup] 自动备份失败:', e.message);
  }
})();

// 初始化默认有效期设置
if (DEFAULT_EXPIRY_DAYS >= 1 && DEFAULT_EXPIRY_DAYS <= 30) {
  store.updateSettings({ defaultExpiryDays: Math.round(DEFAULT_EXPIRY_DAYS) });
}

// ---------- 访问口令 ----------
const tokenFile = path.join(DATA_DIR, 'token.txt');
let activeToken = TOKEN;
if (!activeToken && fs.existsSync(tokenFile)) {
  activeToken = fs.readFileSync(tokenFile, 'utf8').trim();
}
if (!activeToken) {
  activeToken = crypto.randomBytes(5).toString('hex').slice(0, 6);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tokenFile, activeToken, { mode: 0o600 });
}
const tokenHash = crypto.createHash('sha256').update(activeToken).digest('hex');

function tokenMatches(candidate) {
  if (!candidate) return false;
  const h = crypto.createHash('sha256').update(String(candidate)).digest('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(tokenHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  }
  return { _raw: raw, text: raw };
}

// ---------- 认证 ----------
function getRequestToken(req, body) {
  const header = req.headers['x-auth-token'];
  if (header) return header;
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token')) return url.searchParams.get('token');
  if (body && typeof body.token === 'string' && body.token) return body.token;
  return '';
}

function checkAuth(req, body) {
  if (!tokenMatches(getRequestToken(req, body))) {
    sendJSON(req.__res, 401, { error: 'unauthorized', message: '访问口令不正确，请重新输入' });
    return false;
  }
  return true;
}

// ---------- 业务 ----------
function applyFilters(items, query) {
  let list = [...items];
  const status = query.get('status');
  if (status && status !== 'all') list = list.filter((p) => p.status === status);
  const store = query.get('store');
  if (store) list = list.filter((p) => (p.store || '未指定门店') === store);
  const q = (query.get('q') || '').trim().toLowerCase();
  if (q) {
    list = list.filter((p) =>
      [p.tracking, p.code, p.store, p.carrier, p.platform, p.raw]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(q))
    );
  }
  const sort = query.get('sort') || 'arrivedAt';
  list.sort((a, b) => {
    if (sort === 'expiresAt') {
      return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
    }
    return new Date(b.arrivedAt || b.createdAt).getTime() - new Date(a.arrivedAt || a.createdAt).getTime();
  });
  return list;
}

function packageDTO(p) {
  return {
    id: p.id,
    store: p.store,
    code: p.code,
    carrier: p.carrier,
    tracking: p.tracking,
    platform: p.platform,
    note: p.note || '',
    photo: p.photo || '',
    status: p.status,
    arrivedAt: p.arrivedAt,
    expiresAt: p.expiresAt,
    pickedAt: p.pickedAt,
    createdAt: p.createdAt,
    source: p.source,
    raw: p.raw,
  };
}

/** 图片 base64 大小校验（约 200KB 上限，前端已压缩，双保险防撑爆 db） */
function validPhoto(photo) {
  if (!photo) return true;
  if (typeof photo !== 'string') return false;
  const m = photo.match(/^data:image\/(png|jpeg|webp);base64,/);
  if (!m) return false;
  return photo.length <= 260 * 1024;
}

// ---------- 路由 ----------
const routes = [];

function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.pattern);
    if (m) return { handler: r.handler, params: m.slice(1) };
  }
  return null;
}

// 健康检查（无需口令）
route('GET', /^\/api\/health$/, async (req, res, params, body) => {
  sendJSON(res, 200, { ok: true, name: '码上取', version: '0.1.0', time: new Date().toISOString() });
});

// 客户端基础信息
route('GET', /^\/api\/config$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  // 附带服务端可达地址：手机等外部设备要用局域网 IP，localhost 对它们无效
  const addr = listAddresses();
  const lanUrls = addr.v4.map((ip) => 'http://' + ip + ':' + PORT);
  sendJSON(res, 200, {
    name: '码上取',
    version: '0.1.0',
    settings: store.getSettings(),
    authRequired: true,
    lanUrls,                                  // 局域网可访问地址（可能多个，如虚拟网卡）
    ipv6Urls: addr.v6.map((ip) => 'http://[' + ip + ']:' + PORT),
  });
});

// 校验口令
route('POST', /^\/api\/auth$/, async (req, res, params, body) => {
  if (tokenMatches(body.token || body.password)) {
    sendJSON(res, 200, { ok: true });
  } else {
    sendJSON(res, 401, { ok: false, message: '口令不正确' });
  }
});

// 包裹列表 + 门店 + 统计（一次拿全）
route('GET', /^\/api\/packages$/, async (req, res, params, body, query) => {
  if (!checkAuth(req, body)) return;
  const items = applyFilters(store.list(), query).map(packageDTO);
  sendJSON(res, 200, {
    items,
    stores: store.stores(),
    stats: store.stats(),
  });
});

// 手动新增
route('POST', /^\/api\/packages$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const code = String(body.code || '').trim();
  if (!code) return sendJSON(res, 400, { error: '取件码不能为空' });
  const item = {
    store: body.store,
    code,
    carrier: body.carrier,
    tracking: body.tracking,
    platform: body.platform,
    note: body.note,
    photo: body.photo,
    arrivedAt: body.arrivedAt,
    expiresDays: body.expiresDays,
    source: 'manual',
  };
  if (!validPhoto(item.photo)) {
    return sendJSON(res, 400, { error: '图片格式或大小不正确（需 data:image/ 开头的 base64，≤260KB）' });
  }
  const dup = store.findDuplicate(item);
  if (dup) {
    return sendJSON(res, 409, { error: 'duplicate', message: '与已有记录重复（' + (dup.store || dup.tracking || dup.code) + '）' });
  }
  const pkg = store.addPackage(item);
  sendJSON(res, 200, { ok: true, item: packageDTO(pkg) });
});

// 解析文本（批量粘贴预览，支持自定义规则）
route('POST', /^\/api\/parse$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const text = body.text !== undefined ? String(body.text) : (body._raw || '');
  const rules = store.listCustomRules();
  const results = parseTextLines(text, rules).map((r) => ({
    ok: r.ok,
    reason: r.reason,
    platform: r.platform,
    carrier: r.carrier,
    tracking: r.tracking,
    code: r.code,
    store: r.store,
    arrivedAt: r.arrivedAt,
    ruleId: r.ruleId,
    line: r.line,
  }));
  sendJSON(res, 200, { results });
});

// 自定义识别规则（AI 模板学习）
route('GET', /^\/api\/rules$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  sendJSON(res, 200, { rules: store.listCustomRules() });
});

route('POST', /^\/api\/rules$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const sample = String(body.sample || '');
  const code = String(body.code || '').trim();
  const storeVal = body.store !== undefined ? String(body.store).trim() : '';
  if (!sample || !code) return sendJSON(res, 400, { error: '教学样本与取件码不能为空' });
  const rule = buildCustomRule(sample, code, storeVal);
  if (!rule) return sendJSON(res, 400, { error: '无法在样本中定位取件码，请确认取件码与短信原文一致' });
  // 自测：该规则必须能从样本中重新提取出取件码
  const test = applyCustomRules(sample, [{ id: 'test', ...rule }]);
  if (!test || test.code !== code) return sendJSON(res, 400, { error: '规则自测失败，无法生成' });
  const saved = store.addCustomRule({ ...rule, sample });
  console.log('[rules] 新增识别规则:', saved.codeBefore + '<取件码>' + saved.codeAfter);
  sendJSON(res, 200, { ok: true, rule: saved });
});

route('DELETE', /^\/api\/rules\/([^/]+)$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const ok = store.deleteCustomRule(decodeURIComponent(params[0]));
  sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
});

// 批量新增（已解析条目 或 原文）
route('POST', /^\/api\/packages\/batch$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  let items = [];
  if (Array.isArray(body.items)) {
    items = body.items;
  } else if (typeof body.text === 'string' && body.text.trim()) {
    const rules = store.listCustomRules();
    items = parseTextLines(body.text, rules)
      .filter((r) => r.ok)
      .map((r) => {
        if (r.ruleId) store.bumpCustomRule(r.ruleId);
        return {
          store: r.store, code: r.code, carrier: r.carrier,
          tracking: r.tracking, platform: r.platform,
          arrivedAt: r.arrivedAt, source: 'sms-paste', raw: r.line,
        };
      });
  }
  const { added, skipped } = store.addBatch(items);
  sendJSON(res, 200, {
    ok: true,
    added: added.map(packageDTO),
    skipped: skipped.map((s) => ({ reason: s.reason, code: s.item.code, store: s.item.store, tracking: s.item.tracking })),
  });
});

// 更新（状态 / 字段）
route('PATCH', /^\/api\/packages\/([^/]+)$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  if (body.photo !== undefined && !validPhoto(body.photo)) {
    return sendJSON(res, 400, { error: '图片格式或大小不正确（需 data:image/ 开头的 base64，≤260KB）' });
  }
  const pkg = store.updatePackage(decodeURIComponent(params[0]), body);
  if (!pkg) return sendJSON(res, 404, { error: 'not found' });
  sendJSON(res, 200, { ok: true, item: packageDTO(pkg) });
});

// 删除
route('DELETE', /^\/api\/packages\/([^/]+)$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const ok = store.deletePackage(decodeURIComponent(params[0]));
  sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
});

// ---------- 驿站管理 ----------

// 列出所有驿站（含每个驿站的包裹数、待取数）
route('GET', /^\/api\/stores$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  sendJSON(res, 200, { stores: store.stores() });
});

// 删除某驿站下的全部包裹（长按 chips → 删除）
route('DELETE', /^\/api\/stores$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const name = String(body.store || '').trim();
  if (!name) return sendJSON(res, 400, { error: '门店名不能为空' });
  const { deleted } = store.deleteStorePackages(name);
  sendJSON(res, 200, { ok: true, deleted });
});

// 驿站改名（合并到新名：所有旧名包裹改到新名）
route('POST', /^\/api\/stores\/rename$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const from = String(body.from || '').trim();
  const to = String(body.to || '').trim();
  if (!from || !to) return sendJSON(res, 400, { error: '旧名与新名都不能为空' });
  const { updated } = store.renameStore(from, to);
  sendJSON(res, 200, { ok: true, updated });
});

// 导出备份
route('GET', /^\/api\/export$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const data = store.exportData();
  sendJSON(res, 200, data);
});

// 导入恢复
route('POST', /^\/api\/import$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  try {
    const result = store.importData(body.data || body);
    sendJSON(res, 200, { ok: true, ...result });
  } catch (e) {
    sendJSON(res, 400, { error: 'import failed', message: e.message });
  }
});

// 设置
route('POST', /^\/api\/settings$/, async (req, res, params, body) => {
  if (!checkAuth(req, body)) return;
  const settings = store.updateSettings({
    defaultExpiryDays: body.defaultExpiryDays !== undefined ? Number(body.defaultExpiryDays) : undefined,
  });
  sendJSON(res, 200, { ok: true, settings });
});

// 短信自动提取 Webhook（手机短信转发 App 推送入口）
// 支持 JSON: {text, from, time}；也支持表单: sms_text / sms_from / sms_time
// dryRun=1 时只解析不入库（网页端"发送测试短信"按钮使用）
route('POST', /^\/api\/sms$/, async (req, res, params, body, query) => {
  const authed = checkAuth(req, body);
  if (!authed) return;
  const text = body.text || body.sms_text || body._raw || '';
  const from = body.from || body.sms_from || body.sender || '';
  const time = body.time || body.sms_time || body.timestamp || '';
  const parsed = parseSms(text, { from, time }, store.listCustomRules());
  if (!parsed.ok) {
    // 返回 200 避免短信转发 App 反复重试；reason 供排查
    return sendJSON(res, 200, { ok: false, reason: parsed.reason, platform: parsed.platform });
  }
  if (parsed.ruleId) store.bumpCustomRule(parsed.ruleId);
  if (query.get('dryRun') === '1') {
    return sendJSON(res, 200, {
      ok: true, dryRun: true,
      parsed: {
        code: parsed.code, store: parsed.store, carrier: parsed.carrier,
        tracking: parsed.tracking, platform: parsed.platform,
      },
    });
  }
  const dup = store.findDuplicate(parsed);
  if (dup) {
    return sendJSON(res, 200, { ok: true, duplicate: true, item: packageDTO(dup) });
  }
  const pkg = store.addPackage({ ...parsed, source: 'sms' });
  console.log('[sms] 已收录取件码', pkg.code, '@', pkg.store || '未指定门店', 'from', parsed.platform || from);
  sendJSON(res, 200, { ok: true, item: packageDTO(pkg) });
});

// ---------- 静态文件 ----------
function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  } else {
    filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    // 严格限定在 public 目录内（防止 %2e%2e 等路径穿越）
    const rel = path.relative(PUBLIC_DIR, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return sendText(res, 403, 'Forbidden');
    }
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendText(res, 404, 'Not Found');
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  // ETag 由「大小 + 修改时间」生成：文件一改 ETag 就变，浏览器必然拿到新版本。
  // 静态资源一律 no-cache（每次带 ETag 回源校验，未变则 304，既省流量又永不发旧文件）。
  const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': content.length,
    'Cache-Control': 'no-cache',
    'ETag': etag,
  });
  res.end(content);
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (e) {
      return sendText(res, 400, 'Bad Request');
    }
    req.__res = res;

    // API
    if (pathname.startsWith('/api/')) {
      const body = (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE')
        ? await parseBody(req)
        : {};
      const matched = matchRoute(req.method, pathname);
      if (!matched) return sendJSON(res, 404, { error: 'not found', path: pathname });
      return await matched.handler(req, res, matched.params, body, url.searchParams);
    }

    // 静态资源
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }
    return sendText(res, 405, 'Method Not Allowed');
  } catch (e) {
    console.error('[server] 处理请求出错:', e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'internal error', message: e.message });
    else res.end();
  }
});

/** 列出本机可用的局域网 IPv4 与外网 IPv6 地址（用于启动日志提示） */
function listAddresses() {
  const out = { v4: [], v6: [] };
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.internal) continue;
        if (ni.family === 'IPv4' || ni.family === 4) out.v4.push(ni.address);
        else if (ni.family === 'IPv6' || ni.family === 6) {
          // 只要公网可路由的（排除链路本地 fe80）
          if (!/^fe80/i.test(ni.address)) out.v6.push(ni.address);
        }
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

server.listen(PORT, HOST, () => {
  const addr = listAddresses();
  console.log('=============================================');
  console.log('  码上取 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  if (addr.v4.length) {
    console.log('  局域网访问: ' + addr.v4.map((ip) => 'http://' + ip + ':' + PORT).join('  '));
  }
  if (addr.v6.length) {
    console.log('  外网 IPv6:  ' + addr.v6.map((ip) => 'http://[' + ip + ']:' + PORT).join('  '));
  }
  console.log('  访问口令:   ' + activeToken);
  console.log('  数据目录:   ' + DATA_DIR);
  console.log('  SMS Webhook: POST /api/sms?token=' + activeToken);
  console.log('=============================================');
});

server.on('error', (e) => {
  // 双栈监听不被支持时回退到 IPv4
  if (e.code === 'EAFNOSUPPORT' && HOST === '::') {
    console.warn('[server] 系统不支持 IPv6 双栈，回退到 0.0.0.0');
    server.listen(PORT, '0.0.0.0');
    return;
  }
  console.error('[server] 启动失败:', e.message);
  process.exit(1);
});

// 优雅退出
let saving = false;
function shutdown() {
  if (saving) return;
  saving = true;
  try { store.save(); } catch (e) { console.error('保存数据失败:', e.message); }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
