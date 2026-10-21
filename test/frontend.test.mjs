'use strict';

/**
 * 前端端到端测试（jsdom + 真实服务端）
 * 用 jsdom 加载 index.html 并真实执行 app.js，驱动完整交互：
 * 渲染 → 手动添加 → 搜索 → 标记已取 → 删除 → 批量粘贴 → 测试短信(dryRun)
 *
 * 前置：服务已启动且数据为空（见 README「运行测试」）。
 * 环境变量：KDC_FE_BASE（默认 http://127.0.0.1:8123）、KDC_FE_TOKEN（默认 test-token-123）
 * 用法：node test/frontend.test.mjs
 */

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BASE = process.env.KDC_FE_BASE || 'http://127.0.0.1:8123';
const TOKEN = process.env.KDC_FE_TOKEN || 'test-token-123';

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

async function seed() {
  const seeds = [
    { store: '种子驿站A', code: 'S001', carrier: '中通', tracking: 'ZT000000000001' },
    { store: '种子驿站B', code: 'S002', carrier: '圆通', tracking: 'YT000000000002' },
    { store: '种子驿站C', code: 'S003', carrier: '韵达', tracking: 'YD000000000003' },
    // 今日到期：12 小时前到达，1 天有效期
    { store: '种子驿站D', code: 'E001', carrier: '京东', arrivedAt: new Date(Date.now() - 12 * 3600e3).toISOString(), expiresDays: 1 },
    // 已过期：5 天前到达，3 天有效期
    { store: '种子驿站E', code: 'E002', carrier: '顺丰', arrivedAt: new Date(Date.now() - 5 * 24 * 3600e3).toISOString(), expiresDays: 3 },
  ];
  for (const s of seeds) {
    const res = await fetch(BASE + '/api/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': TOKEN },
      body: JSON.stringify(s),
    });
    if (res.status !== 200) throw new Error('seed 失败: ' + res.status + ' ' + JSON.stringify(s));
  }
}

const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const cssText = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');

function createAppDom(preseedToken) {
  const errors = [];
  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // fetch 代理：相对路径解析到测试服务端
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? new URL(input, BASE).toString() : input;
        return globalThis.fetch(url, init);
      };
      window.Notification = class {
        static permission = 'denied';
        static requestPermission() { return Promise.resolve('denied'); }
      };
      window.confirm = () => true;
      window.document.execCommand = () => true;
      window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
      window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + String(e.reason)));
    },
  });
  // 注入真实 CSS，让 getComputedStyle 反映样式（防止 hidden 被 display 覆盖类 bug 漏测）
  const style = dom.window.document.createElement('style');
  style.textContent = cssText;
  dom.window.document.head.appendChild(style);
  if (preseedToken) dom.window.localStorage.setItem('msq_token', preseedToken);
  return { dom, errors };
}

async function loadApp(dom) {
  const script = dom.window.document.createElement('script');
  script.textContent = appJs;
  dom.window.document.body.appendChild(script);
  await sleep(900);
}

const { dom, errors } = createAppDom(TOKEN);
const { window } = dom;
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const cards = () => $$('.card');
const cardByCode = (code) => cards().find((c) => c.querySelector('.code')?.textContent === code);
const lastToast = () => $$('#toastWrap .toast').at(-1)?.textContent || '';
const anyToast = (text) => $$('#toastWrap .toast').some((t) => t.textContent.includes(text));

console.log('[前端 E2E] ' + BASE);

try {
  await seed(3);
  await loadApp(dom);

  // 1. 初始渲染
  check('初始渲染 5 张卡片', cards().length === 5, '实际: ' + cards().length);
  check('统计徽标 待取 5', ($('#statBadge').textContent || '').includes('待取 5'), $('#statBadge').textContent);
  check('门店筛选出现种子门店', $$('#storeChips .chip').some((c) => c.textContent.includes('种子驿站A')));

  // 1b. 到期提醒横幅
  const banner = $('#expiryBanner');
  check('到期横幅可见', banner.hidden === false, 'hidden=' + banner.hidden);
  check('横幅提示过期与到期', (banner.textContent || '').includes('已过期') && (banner.textContent || '').includes('今日到期'), banner.textContent);

  // 1c. 即将到期排序（已过期的 E002 应排最前）
  $$('#sortRow .sort-btn').find((b) => b.dataset.sort === 'expiresAt').click();
  await sleep(400);
  check('到期排序后 E002 排最前', cards()[0]?.querySelector('.code')?.textContent === 'E002', '实际: ' + cards()[0]?.querySelector('.code')?.textContent);
  $$('#sortRow .sort-btn').find((b) => b.dataset.sort === 'arrivedAt').click();
  await sleep(400);

  // 1d. 门店筛选
  $$('#storeChips .chip').find((c) => c.textContent.includes('种子驿站A')).click();
  await sleep(400);
  check('门店筛选只显示该店', cards().length === 1 && cards()[0]?.querySelector('.store')?.textContent === '种子驿站A', '实际: ' + cards().length);

  // 1e. 到期横幅点击 → 回到全部待取
  $('#expiryBanner').click();
  await sleep(400);
  check('横幅点击回到待取视图', cards().length === 5, '实际: ' + cards().length);

  // 2. 手动添加（带备注）
  $('#fCode').value = 'T999';
  $('#fStore').value = '前端测试驿站';
  $('#fCarrier').value = '中通';
  $('#fNote').value = '测试备注';
  $('#btnAddSave').click();
  await sleep(500);
  check('手动添加后 6 张卡片', cards().length === 6, '实际: ' + cards().length);
  check('添加成功提示', anyToast('已添加'), '最新: ' + lastToast());
  check('卡片显示备注', $$('.card-note').some((n) => n.textContent.includes('测试备注')), $$('.card-note').map((n) => n.textContent).join('|'));

  // 3. 搜索（输单号/取件码查取件码）
  $('#searchInput').value = 'T999';
  $('#btnSearch').click();
  await sleep(400);
  check('搜索过滤出 1 张卡片', cards().length === 1, '实际: ' + cards().length);
  check('搜索结果取件码正确', cardByCode('T999') !== undefined);
  $('#searchInput').value = '';
  $('#btnSearch').click();
  await sleep(400);
  check('清空搜索恢复 6 张', cards().length === 6);

  // 4. 标记已取
  cardByCode('T999').click();
  await sleep(300);
  check('详情面板打开', $('#sheetDetail').hidden === false);
  $('#dToggle').click();
  await sleep(500);
  check('标记后待取 5 张', cards().length === 5, '实际: ' + cards().length);

  // 5. 已取标签页
  $$('#statusTabs .tab').find((t) => t.dataset.status === 'picked').click();
  await sleep(400);
  check('已取页 1 张卡片', cards().length === 1 && cardByCode('T999') !== undefined, '实际: ' + cards().length);

  // 6. 全部标签页 → 删除
  $$('#statusTabs .tab').find((t) => t.dataset.status === 'all').click();
  await sleep(400);
  cardByCode('T999').click();
  await sleep(300);
  $('#dDelete').click();
  await sleep(500);
  check('删除后 5 张卡片', cards().length === 5, '实际: ' + cards().length);

  // 7. 批量粘贴两条短信
  $('#fab').click();
  await sleep(200);
  $$('#addTabs .tab').find((t) => t.dataset.atab === 'batch').click();
  $('#batchText').value =
    '【菜鸟驿站】您的包裹已到达 批量测试驿站，取件码：B001，请及时取件。\n' +
    '【妈妈驿站】您的包裹已到 批量妈妈驿站，取件码：B002，请尽快领取。';
  $('#btnBatchParse').click();
  await sleep(500);
  check('批量解析预览 2 行', $$('#batchPreview .preview-row').length === 2, '实际: ' + $$('#batchPreview .preview-row').length);
  $('#btnBatchAdd').click();
  await sleep(600);
  check('批量添加成功提示', anyToast('已添加 2 条'), '最新: ' + lastToast());
  check('批量后 7 张卡片', cards().length === 7, '实际: ' + cards().length);

  // 8. 设置页可以打开（短信转发配置已移除，此处只验证面板可用）
  $('#btnSettings').click();
  await sleep(300);
  check('设置面板可打开', $('#sheetSettings').hidden === false, 'hidden=' + $('#sheetSettings').hidden);

  // 8b. 左滑标记已取（先关设置、切回待取视图）
  $('#backdrop').click();
  await sleep(200);
  $$('#statusTabs .tab').find((t) => t.dataset.status === 'pending').click();
  await sleep(400);
  const swipeCard = cards()[0];
  const beforeCount = cards().length;
  swipeCard.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 180, clientY: 60, bubbles: true }));
  swipeCard.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 40, clientY: 62, bubbles: true }));
  swipeCard.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 40, clientY: 62, bubbles: true }));
  await sleep(600);
  check('左滑已取：卡片减少', cards().length === beforeCount - 1, '实际: ' + cards().length);
  check('左滑已取：待取计数减少', ($('#statBadge').textContent || '').includes('待取 ' + (beforeCount - 1)), $('#statBadge').textContent);

  // 8c. 小幅度滑动不触发已取（回弹）
  const swipeCard2 = cards()[0];
  const beforeCount2 = cards().length;
  swipeCard2.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 150, clientY: 60, bubbles: true }));
  swipeCard2.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 120, clientY: 62, bubbles: true }));
  swipeCard2.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 120, clientY: 62, bubbles: true }));
  // 模拟真实浏览器：滑动结束后自动补发 click（消费 moved 标志，防止误开详情）
  swipeCard2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  check('小幅滑动回弹不触发', cards().length === beforeCount2, '实际: ' + cards().length);

  // 8d. 普通点击仍打开详情
  cards()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  check('点击卡片打开详情', $('#sheetDetail').hidden === false);
  $('#backdrop').click();
  await sleep(200);

  // 8e. AI 教学：识别不了的短信 → 教学 → 记住格式 → 重新解析成功
  $('#fab').click();
  await sleep(200);
  $$('#addTabs .tab').find((t) => t.dataset.atab === 'batch').click();
  $('#batchText').value = '【小区代收】凭A-5-9999，请到阳光花园取件';
  $('#btnBatchParse').click();
  await sleep(500);
  check('失败行显示教学按钮', $$('#batchPreview [data-teach]').length === 1, '实际: ' + $$('#batchPreview [data-teach]').length);
  $$('#batchPreview [data-teach]')[0].click();
  await sleep(200);
  check('教学弹窗打开', $('#sheetTeach').hidden === false);
  $('#teachCode').value = 'A-5-9999';
  $('#btnTeachSave').click();
  await sleep(600);
  check('教学成功提示', ($('#teachResult').textContent || '').includes('已记住'), $('#teachResult').textContent);
  $('#batchText').value = '【小区代收】凭B-6-8888，请到幸福花园取件';
  $('#btnBatchParse').click();
  await sleep(500);
  check('规则生效识别同格式短信', $$('#batchPreview .preview-row:not(.fail)').length === 1, $('#batchPreview').textContent);
  $('#backdrop').click();
  await sleep(200);

  // 8f. 编辑备注（详情 → 备注弹窗 → 保存）
  cards()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(300);
  $('#dEdit').click();
  await sleep(200);
  check('备注编辑弹窗打开', $('#sheetEditNote').hidden === false);
  $('#editNote').value = '编辑后的备注';
  $('#btnEditNoteSave').click();
  await sleep(600);
  check('备注保存成功提示', anyToast('备注已保存'), '最新: ' + lastToast());
  check('卡片显示新备注', $$('.card-note').some((n) => n.textContent.includes('编辑后的备注')), $$('.card-note').map((n) => n.textContent).join('|'));

  // 9. 无未捕获错误
  check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

  // 10. 登录流程（模拟未登录打开页面：输错提示、显示口令、输对关闭）
  const { dom: dom2, errors: errors2 } = createAppDom(null);
  const w2 = dom2.window;
  const $2 = (s) => w2.document.querySelector(s);
  const $$2 = (s) => [...w2.document.querySelectorAll(s)];
  await loadApp(dom2);
  const cs = (sel) => w2.getComputedStyle($2(sel));
  check('未登录时显示口令弹窗', $2('#loginOverlay').hidden === false && cs('#loginOverlay').display === 'flex', 'display=' + cs('#loginOverlay').display);
  $2('#loginToken').value = 'wrong-token';
  $2('#btnLogin').click();
  await sleep(500);
  check('错误口令：提示且弹窗保留', $2('#loginOverlay').hidden === false && $2('#loginError').hidden === false && ($2('#loginError').textContent || '').includes('口令不正确'), $2('#loginError').textContent);
  $2('#btnTogglePwd').click();
  check('显示口令切换可用', $2('#loginToken').type === 'text');
  $2('#loginToken').value = TOKEN;
  $2('#btnLogin').click();
  await sleep(700);
  check('正确口令：弹窗关闭', $2('#loginOverlay').hidden === true && cs('#loginOverlay').display === 'none', 'hidden=' + $2('#loginOverlay').hidden + ' display=' + cs('#loginOverlay').display);
  check('登录后列表渲染', $$2('.card').length > 0, '实际: ' + $$2('.card').length);
  check('登录场景无运行时错误', errors2.length === 0, errors2.join(' | '));
  dom2.window.close();
} finally {
  dom.window.close();
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
