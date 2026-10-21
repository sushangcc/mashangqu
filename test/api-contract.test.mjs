'use strict';

/**
 * Android App 接口契约测试
 * 逐条复刻 android/.../ApiClient.kt 的实际请求（路径、查询串、请求头、JSON 体），
 * 确保 App 与服务端的对接契约稳定，防止服务端改动破坏 App。
 *
 * 前置：服务已启动且数据为空（同 api.test.mjs）。
 * 环境变量：KDC_API_BASE / KDC_API_TOKEN
 * 用法：node test/api-contract.test.mjs
 */

const BASE = process.env.KDC_API_BASE || 'http://127.0.0.1:8123';
const TOKEN = process.env.KDC_API_TOKEN || 'test-token-123';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log('  ✔', name);
  } else {
    failed++;
    failures.push(name + (detail ? ' —— ' + detail : ''));
    console.log('  ✘', name, detail ? '—— ' + detail : '');
  }
}

// ===== 与 ApiClient.kt 完全一致的请求构造 =====
async function ktRequest(method, path, body) {
  const headers = { 'X-Auth-Token': TOKEN };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (res.status === 401) throw new Error('口令不正确');
  if (res.status < 200 || res.status >= 300) throw new Error(data.message || `服务返回 ${res.status}`);
  return data;
}

// ===== 与 ApiClient.kt 相同的查询串构造 =====
function q(name, value) { return `${name}=${encodeURIComponent(value)}`; }

async function fetchList(status, searchQ, store, sort) {
  const params = [];
  if (status && status !== 'all') params.push(q('status', status));
  if (searchQ) params.push(q('q', searchQ));
  if (store) params.push(q('store', store));
  params.push(q('sort', sort));
  return ktRequest('GET', '/api/packages?' + params.join('&'));
}

console.log('[App 契约测试] ' + BASE);

try {
  // 准备：两条数据（与 App 手动录入字段一致）
  const a = await ktRequest('POST', '/api/packages', {
    store: '契约测试A', code: 'C001', carrier: '中通',
    tracking: 'ZT000000000C01', platform: '手动测试', expiresDays: 3,
  });
  const b = await ktRequest('POST', '/api/packages', {
    store: '契约测试B', code: 'C002', carrier: '顺丰', platform: '短信',
  });
  check('addPackage 全字段', a.item.store === '契约测试A' && a.item.code === 'C001' &&
    Math.abs((new Date(a.item.expiresAt).getTime() - new Date(a.item.arrivedAt).getTime()) / 86400000 - 3) < 0.01,
    JSON.stringify(a));
  check('addPackage 最小字段', b.item && b.item.code === 'C002' && b.item.status === 'pending');

  // fetchList：默认（pending + arrivedAt 排序）
  let r = await fetchList('pending', '', '', 'arrivedAt');
  check('fetchList 默认待取', r.items.length === 2 && r.items.every((i) => i.status === 'pending'));
  check('fetchList 附带 stores/stats', Array.isArray(r.stores) && r.stats && typeof r.stats.pending === 'number');

  // fetchList：已取
  await ktRequest('PATCH', '/api/packages/' + a.item.id, { status: 'picked' });
  r = await fetchList('picked', '', '', 'arrivedAt');
  check('fetchList 已取', r.items.length === 1 && r.items[0].id === a.item.id);

  // fetchList：搜索 q
  r = await fetchList('all', 'C002', '', 'arrivedAt');
  check('fetchList 搜索', r.items.length === 1 && r.items[0].code === 'C002');

  // fetchList：门店筛选 + 到期排序
  r = await fetchList('all', '', '契约测试B', 'expiresAt');
  check('fetchList 门店+排序', r.items.length === 1 && r.items[0].store === '契约测试B');

  // patchStatus 恢复待取
  await ktRequest('PATCH', '/api/packages/' + a.item.id, { status: 'pending' });
  r = await fetchList('pending', '', '', 'arrivedAt');
  check('patchStatus 恢复', r.items.length === 2);

  // smsAutoAdd（App 短信自动入库的请求形态）
  const sms = await ktRequest('POST', '/api/sms', {
    text: '【菜鸟驿站】您的包裹已到 契约短信驿站，取件码：7777，请及时取件。',
    from: '1069xxxx',
    time: String(Date.now()),
  });
  check('smsAutoAdd 入库', sms.ok === true && sms.item && sms.item.code === '7777' && sms.item.source === 'sms', JSON.stringify(sms));
  const dup = await ktRequest('POST', '/api/sms', {
    text: '【菜鸟驿站】您的包裹已到 契约短信驿站，取件码：7777，请及时取件。',
    from: '1069xxxx',
    time: String(Date.now()),
  });
  check('smsAutoAdd 去重', dup.duplicate === true, JSON.stringify(dup));

  // testConnection（App 测试连接 = GET pending 统计）
  r = await fetchList('pending', '', '', 'arrivedAt');
  check('testConnection 统计', r.stats.pending >= 2);

  // deletePackage
  await ktRequest('DELETE', '/api/packages/' + a.item.id);
  await ktRequest('DELETE', '/api/packages/' + b.item.id);
  const smsItemId = sms.item.id;
  await ktRequest('DELETE', '/api/packages/' + smsItemId);
  r = await fetchList('all', '', '', 'arrivedAt');
  check('deletePackage 清空', r.items.length === 0, '实际: ' + r.items.length);
} catch (e) {
  check('契约请求未抛异常', false, e.message);
}

console.log('\n========================================');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
} else {
  console.log('全部通过 ✔');
}
