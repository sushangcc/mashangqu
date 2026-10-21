'use strict';

/**
 * 服务端 API 集成测试（仅 HTTP 请求，不拉起服务）
 * 前置：服务已启动，见 README「运行测试」。
 * 环境变量：
 *   KDC_API_BASE   服务地址，默认 http://127.0.0.1:8123
 *   KDC_API_TOKEN  访问口令，默认 test-token-123
 * 用法：node test/api.test.mjs
 */

import { SAMPLES } from './samples.mjs';
import http from 'node:http';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, pathname, { body, token = TOKEN } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Auth-Token'] = token;
  const res = await fetch(BASE + pathname, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, data };
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch (e) { /* not ready */ }
    await sleep(100);
  }
  return false;
}

console.log('[API 测试] ' + BASE);

const ready = await waitReady();
check('服务可访问', ready);

if (!ready) {
  console.log('\n服务未就绪，请先启动服务（测试数据目录需为空）。');
  process.exit(1);
}

// 鉴权
let r = await req('GET', '/api/packages', { token: '' });
check('无口令访问被拒(401)', r.status === 401, `status=${r.status}`);

r = await req('POST', '/api/auth', { body: { token: TOKEN } });
check('口令校验通过', r.status === 200 && r.data.ok === true);

r = await req('GET', '/api/packages', { token: 'wrong-token' });
check('错误口令被拒(401)', r.status === 401, `status=${r.status}`);

r = await req('GET', '/api/config');
check('config 返回默认设置', r.status === 200 && r.data.settings.defaultExpiryDays === 3, JSON.stringify(r.data));

// 手动新增
r = await req('POST', '/api/packages', {
  body: { store: '测试驿站', code: 'A100', carrier: '中通', tracking: 'ZT202506010001', platform: '手动测试' },
});
check('手动新增', r.status === 200 && r.data.item.code === 'A100' && r.data.item.status === 'pending', JSON.stringify(r.data));

// 查重
r = await req('POST', '/api/packages', {
  body: { store: '测试驿站', code: 'A100', carrier: '中通', tracking: 'ZT202506010001' },
});
check('重复新增被拦截(409)', r.status === 409, `status=${r.status}`);

// 批量粘贴（原文）
const smsText = SAMPLES.slice(0, 4).map((s) => s.text).join('\n');
r = await req('POST', '/api/packages/batch', { body: { text: smsText } });
check('批量粘贴新增 4 条', r.status === 200 && r.data.added.length === 4, JSON.stringify(r.data));

// 再贴一次 → 全部判重跳过
r = await req('POST', '/api/packages/batch', { body: { text: smsText } });
check('重复批量全部跳过', r.status === 200 && r.data.added.length === 0 && r.data.skipped.length === 4, JSON.stringify(r.data));

// 解析接口
r = await req('POST', '/api/parse', { body: { text: SAMPLES[4].text } });
check('解析接口', r.status === 200 && r.data.results[0].ok === true && r.data.results[0].code === '8899');

// 列表 + 筛选
r = await req('GET', '/api/packages');
check('列表返回', r.status === 200 && Array.isArray(r.data.items) && r.data.items.length === 5, JSON.stringify(r.data.items?.length));
check('统计信息', r.data.stats.pending === 5 && r.data.stats.total === 5, JSON.stringify(r.data.stats));

r = await req('GET', '/api/packages?q=' + encodeURIComponent('ZT202506010001'));
check('按单号搜索', r.status === 200 && r.data.items.length === 1 && r.data.items[0].code === 'A100');

r = await req('GET', '/api/packages?store=' + encodeURIComponent('康桥水岸妈妈驿站'));
check('按门店筛选', r.status === 200 && r.data.items.length === 1);

r = await req('GET', '/api/packages?status=picked');
check('已取列表为空', r.status === 200 && r.data.items.length === 0);

// 更新状态
const pid = (await req('GET', '/api/packages?q=A100')).data.items[0].id;
r = await req('PATCH', '/api/packages/' + pid, { body: { status: 'picked' } });
check('标记已取', r.status === 200 && r.data.item.status === 'picked' && !!r.data.item.pickedAt);

r = await req('GET', '/api/packages');
check('统计更新(picked=1)', r.data.stats.picked === 1 && r.data.stats.pending === 4, JSON.stringify(r.data.stats));

check('门店列表含待取计数', r.data.stores.some((s) => s.store === '康桥水岸妈妈驿站' && s.pending === 1), JSON.stringify(r.data.stores));

// SMS Webhook（用已在库中的快递超市-圆通短信验证判重）
r = await req('POST', '/api/sms?token=' + TOKEN, {
  body: { text: SAMPLES[3].text, from: '1069xxxx', time: '2025-06-02 09:00:00' },
});
check('SMS Webhook 判重(duplicate)', r.status === 200 && r.data.duplicate === true, JSON.stringify(r.data));

r = await req('POST', '/api/sms?token=' + TOKEN, {
  body: { text: '【菜鸟驿站】您的申通快递已到江畔花园驿站，取件码：7788，请及时取件。', from: '1069xxxx', time: '2025-06-02 09:05:00' },
});
check('SMS Webhook 新增', r.status === 200 && r.data.ok === true && r.data.item.code === '7788' && r.data.item.source === 'sms', JSON.stringify(r.data));

r = await req('POST', '/api/sms?token=' + TOKEN, { body: { text: '【招商银行】余额提醒', from: '95555' } });
check('SMS Webhook 非快递短信忽略', r.status === 200 && r.data.ok === false);

// dryRun：只解析不入库（网页端"发送测试短信"）
r = await req('POST', '/api/sms?token=' + TOKEN + '&dryRun=1', { body: { text: SAMPLES[0].text, from: '测试' } });
check('SMS dryRun 只解析不入库', r.status === 200 && r.data.ok === true && r.data.dryRun === true && r.data.parsed.code === '3-2-4523', JSON.stringify(r.data));
r = await req('GET', '/api/packages');
check('dryRun 后数量不变', r.data.items.length === 6, '实际: ' + r.data.items?.length);

// 导出 / 导入
r = await req('GET', '/api/export');
check('导出备份', r.status === 200 && r.data.packages.length === 6, JSON.stringify(r.data.packages?.length));

r = await req('POST', '/api/import', {
  body: { data: { version: 1, settings: { defaultExpiryDays: 3 }, packages: [{ store: '导入测试', code: 'Z999', carrier: '京东' }] } },
});
check('导入恢复', r.status === 200 && r.data.count === 1, JSON.stringify(r.data));
r = await req('GET', '/api/packages');
check('导入后列表=1', r.data.items.length === 1 && r.data.items[0].code === 'Z999');

// 设置
r = await req('POST', '/api/settings', { body: { defaultExpiryDays: 5 } });
check('更新默认有效天数', r.status === 200 && r.data.settings.defaultExpiryDays === 5);

// 删除（导入后的记录）
const zid = (await req('GET', '/api/packages')).data.items[0].id;
r = await req('DELETE', '/api/packages/' + zid);
check('删除记录', r.status === 200, JSON.stringify(r.data));
r = await req('GET', '/api/packages');
check('删除后列表为空', r.data.items.length === 0, JSON.stringify(r.data.items?.length));

// 批量新增（直接传 items 数组）
r = await req('POST', '/api/packages/batch', {
  body: { items: [
    { store: '批量测试', code: 'X101', carrier: '中通', tracking: 'ZT101' },
    { store: '批量测试', code: 'X102', carrier: '圆通', tracking: 'YT102' },
  ] },
});
check('items 数组批量新增 2 条', r.status === 200 && r.data.added.length === 2 && r.data.skipped.length === 0, JSON.stringify(r.data));
r = await req('GET', '/api/packages');
check('批量后列表=2', r.data.items.length === 2, JSON.stringify(r.data.items?.length));

// 批量查重
r = await req('POST', '/api/packages/batch', {
  body: { items: [{ store: '批量测试', code: 'X101', carrier: '中通', tracking: 'ZT101' }] },
});
check('items 数组批量查重', r.status === 200 && r.data.added.length === 0 && r.data.skipped.length === 1, JSON.stringify(r.data));

// 到期排序：补录一个已过期包裹验证 sort=expiresAt
r = await req('POST', '/api/packages', {
  body: {
    store: '排序测试', code: 'E100', carrier: '中通',
    arrivedAt: new Date(Date.now() - 2 * 24 * 3600e3).toISOString(), expiresDays: 1,
  },
});
check('补录历史包裹(已过期)', r.status === 200 && r.data.item.status === 'pending', JSON.stringify(r.data));
r = await req('GET', '/api/packages?sort=expiresAt');
check('到期排序最早为已过期项', r.status === 200 && r.data.items[0]?.code === 'E100', JSON.stringify(r.data.items?.map((i) => i.code)));

// 包裹备注（文字 + 图片）
r = await req('POST', '/api/packages', { body: { store: '备注测试', code: 'N001', note: '给妈买的保健品' } });
check('添加带备注', r.status === 200 && r.data.item.note === '给妈买的保健品', JSON.stringify(r.data));
const noteId = r.data.item.id;
r = await req('PATCH', '/api/packages/' + noteId, { body: { note: '更新后的备注' } });
check('更新备注', r.status === 200 && r.data.item.note === '更新后的备注');
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
r = await req('PATCH', '/api/packages/' + noteId, { body: { photo: tinyPng } });
check('添加图片', r.status === 200 && r.data.item.photo === tinyPng);
r = await req('PATCH', '/api/packages/' + noteId, { body: { photo: 'not-a-base64-image' } });
check('非法图片被拒(400)', r.status === 400, 'status=' + r.status);
r = await req('PATCH', '/api/packages/' + noteId, { body: { photo: 'data:image/png;base64,' + 'A'.repeat(300 * 1024) } });
check('超大图片被拒(400)', r.status === 400, 'status=' + r.status);
r = await req('GET', '/api/packages?q=N001');
check('列表返回备注与图片', r.status === 200 && r.data.items[0].note === '更新后的备注' && r.data.items[0].photo === tinyPng, JSON.stringify(r.data.items?.[0]));
r = await req('DELETE', '/api/packages/' + noteId);
check('删除备注记录', r.status === 200);

// AI 模板学习（自定义识别规则）
const teachSample = '【小区代收】凭A-5-9999，请到阳光花园取件';
r = await req('POST', '/api/parse', { body: { text: teachSample } });
check('教学前内置规则无法识别', r.data.results[0].ok === false, JSON.stringify(r.data.results[0]));
r = await req('POST', '/api/rules', { body: { sample: teachSample, code: 'A-5-9999', store: '' } });
check('教学生成规则', r.status === 200 && r.data.ok === true && r.data.rule.codeBefore === '凭', JSON.stringify(r.data));
const ruleId = r.data.rule.id;
r = await req('POST', '/api/parse', { body: { text: '【小区代收】凭B-6-8888，请到幸福花园取件' } });
check('规则识别同格式新短信', r.data.results[0].ok === true && r.data.results[0].code === 'B-6-8888' && r.data.results[0].ruleId === ruleId, JSON.stringify(r.data.results[0]));
r = await req('POST', '/api/rules', { body: { sample: '随便一句话没有取件码', code: '1234' } });
check('定位失败返回 400', r.status === 400, 'status=' + r.status);
r = await req('GET', '/api/rules');
check('规则列表', r.status === 200 && r.data.rules.length === 1, JSON.stringify(r.data));
r = await req('DELETE', '/api/rules/' + ruleId);
check('删除规则', r.status === 200);
r = await req('GET', '/api/rules');
check('删除后规则为空', r.data.rules.length === 0);

// ---------- 编辑取件信息 ----------
r = await req('POST', '/api/packages', { body: { store: '编辑前驿站', code: 'E100', carrier: '中通' } });
const editId = r.data.item.id;
const newExpires = new Date(Date.now() + 5 * 86400e3).toISOString();
r = await req('PATCH', '/api/packages/' + editId, {
  body: { store: '编辑后驿站', code: 'E200', carrier: '顺丰', tracking: 'SF1234567890123', platform: '手动改', expiresAt: newExpires },
});
check('编辑多字段成功', r.status === 200 && r.data.item.store === '编辑后驿站' && r.data.item.code === 'E200', JSON.stringify(r.data.item));
check('编辑快递公司与单号', r.data.item.carrier === '顺丰' && r.data.item.tracking === 'SF1234567890123');
check('编辑到期时间生效', r.data.item.expiresAt === newExpires, r.data.item.expiresAt);
r = await req('GET', '/api/packages?q=E200');
check('编辑后可按新取件码搜到', r.data.items.length === 1 && r.data.items[0].store === '编辑后驿站');
await req('DELETE', '/api/packages/' + editId);

// ---------- 驿站管理 ----------
// 造两个驿站，测 删除 / 改名（合并）
await req('POST', '/api/packages', { body: { store: '驿站甲', code: 'A1' } });
await req('POST', '/api/packages', { body: { store: '驿站甲', code: 'A2' } });
await req('POST', '/api/packages', { body: { store: '驿站乙', code: 'B1' } });

r = await req('GET', '/api/stores');
check('驿站列表', r.status === 200 && r.data.stores.some((s) => s.store === '驿站甲' && s.total === 2), JSON.stringify(r.data.stores));
check('驿站列表含驿站乙', r.data.stores.some((s) => s.store === '驿站乙' && s.total === 1));

r = await req('POST', '/api/stores/rename', { body: { from: '驿站乙', to: '驿站甲' } });
check('驿站改名(合并)', r.status === 200 && r.data.updated === 1, JSON.stringify(r.data));
r = await req('GET', '/api/stores');
check('合并后驿站乙消失', !r.data.stores.some((s) => s.store === '驿站乙'));
check('合并后驿站甲有 3 条', r.data.stores.some((s) => s.store === '驿站甲' && s.total === 3));

r = await req('DELETE', '/api/stores', { body: { store: '驿站甲' } });
check('删除驿站及其包裹', r.status === 200 && r.data.deleted === 3, JSON.stringify(r.data));
r = await req('GET', '/api/stores');
check('删除后驿站甲消失', !r.data.stores.some((s) => s.store === '驿站甲'));

r = await req('DELETE', '/api/stores', { body: { store: '' } });
check('删除驿站空名被拒(400)', r.status === 400, 'status=' + r.status);
r = await req('POST', '/api/stores/rename', { body: { from: '', to: 'x' } });
check('改名空旧名被拒(400)', r.status === 400, 'status=' + r.status);

// 清理测试数据，保持库干净（供前端 E2E 使用）
const cleanupIds = (await req('GET', '/api/packages')).data.items.map((i) => i.id);
for (const id of cleanupIds) await req('DELETE', '/api/packages/' + id);
r = await req('GET', '/api/packages');
check('清理后列表为空', r.data.items.length === 0, '实际: ' + r.data.items?.length);

// 错误处理
r = await req('PATCH', '/api/packages/not-exist', { body: { status: 'picked' } });
check('不存在的记录 404', r.status === 404);

// 静态资源
const page = await fetch(BASE + '/');
const html = await page.text();
check('首页可访问', page.status === 200 && html.includes('码上取'));
check('静态资源可访问', (await fetch(BASE + '/app.js')).status === 200);

// 路径穿越防护
// 说明：Node 的 URL 构造器会把 %2e%2e 归一化，真正能穿过的是编码斜杠 ..%2f
// （URL 解析不视为分隔符，但服务端 decodeURIComponent 后会还原成 ..）
function rawStatus(pathname) {
  return new Promise((resolve) => {
    const u = new URL(BASE);
    const req = http.request({ hostname: u.hostname, port: u.port, path: pathname, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}
check('路径穿越防护(data)', (await rawStatus('/..%2fdata/token.txt')) === 403, 'status=' + await rawStatus('/..%2fdata/token.txt'));
check('路径穿越防护(根目录)', (await rawStatus('/..%2fserver.js')) === 403, 'status=' + await rawStatus('/..%2fserver.js'));
check('路径穿越防护(同名前缀目录)', (await rawStatus('/..%2fpublic2/x')) === 403, 'status=' + await rawStatus('/..%2fpublic2/x'));
check('%2e%2e 变体同样不可达', (await rawStatus('/%2e%2e/data/token.txt')) !== 200, 'status=' + await rawStatus('/%2e%2e/data/token.txt'));
check('正常静态路径不受影响', (await rawStatus('/app.js')) === 200, 'status=' + await rawStatus('/app.js'));
check('PWA manifest', (await fetch(BASE + '/manifest.webmanifest')).status === 200);
const icon = await fetch(BASE + '/icons/icon-192.png');
check('PWA 图标', icon.status === 200 && (await icon.arrayBuffer()).byteLength > 500);

console.log('\n========================================');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
} else {
  console.log('全部通过 ✔');
}
