'use strict';

/**
 * 解析器单元测试（纯函数，无需启动服务）
 * 用法：node test/run-tests.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSms, parseTextLines } from '../lib/parser.js';
import { SAMPLES } from './samples.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

console.log('[解析器测试]');
for (const s of SAMPLES) {
  const r = parseSms(s.text, { from: '', time: '2025-06-01 10:00:00' });
  for (const [k, v] of Object.entries(s.expect)) {
    check(`${s.name} -> ${k}`, r[k] === v, `实际: ${JSON.stringify(r[k])} (整条: ${JSON.stringify(r)})`);
  }
}

// 批量解析
const batchText = SAMPLES.slice(0, 3).map((s) => s.text).join('\n');
const lines = parseTextLines(batchText);
check('批量解析 3 行', lines.length === 3 && lines.every((l) => l.ok), JSON.stringify(lines));

// 空输入
check('空输入返回空数组', parseTextLines('').length === 0);

// ---------- 智能切块：多条短信 vs 订单详情页多行 ----------
console.log('\n[智能切块]');

// 多行一块：订单详情页（1 个取件码 + 门店 + 单号）→ 应合成 1 条
const orderBlob = '已送达\n取件码：8-2-1234\n菜鸟驿站(阳光花园店)\n运单号：YT1234567890123\n请及时取件';
const ob = parseTextLines(orderBlob);
check('订单详情页合并为 1 条', ob.length === 1, '实际切出 ' + ob.length + ' 条');
check('订单详情页识别取件码', ob[0]?.code === '8-2-1234', JSON.stringify(ob[0]?.code));
check('订单详情页识别门店', ob[0]?.store === '菜鸟驿站阳光花园店', ob[0]?.store);
check('订单详情页识别单号', ob[0]?.tracking === 'YT1234567890123', ob[0]?.tracking);

// 多个订单块：应切成 2 条，且门店不串块
const twoBlobs = '菜鸟驿站(北门店)\n取件码：3-2-4523\n运单号：ZT0000111122223\n丰巢快递柜\n取件码：998877\n运单号：SF1234567890123';
const tb = parseTextLines(twoBlobs);
check('两个订单块切为 2 条', tb.length === 2, '实际 ' + tb.length);
check('块1 门店正确', tb[0]?.store === '菜鸟驿站北门店', tb[0]?.store);
check('块2 门店正确(不串块)', tb[1]?.store === '丰巢快递柜', tb[1]?.store);
check('两块取件码都正确', tb[0]?.code === '3-2-4523' && tb[1]?.code === '998877', JSON.stringify(tb.map((x) => x.code)));

// 纯多行短信（每行自带取件码）→ 仍应逐行拆开
const multiSms = '【菜鸟驿站】已到阳光花园驿站，取件码：1234\n【妈妈驿站】已到康桥驿站，取件码：X888';
const ms = parseTextLines(multiSms);
check('多条短信仍逐行拆分', ms.length === 2 && ms.every((x) => x.ok), '实际 ' + ms.length);

// 每行只有取件码 → 3 条
check('纯取件码三行切为 3 条', parseTextLines('取件码：1111\n取件码：2222\n取件码：3333').length === 3);

console.log('\n[前端静态检查]');

// app.js 中引用的 DOM id 是否都存在于 index.html（防止元素 id 拼写不一致）
const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([...appJs.matchAll(/#([A-Za-z][A-Za-z0-9_-]+)/g)].map((m) => m[1]));
const missing = [...usedIds].filter((id) => !htmlIds.has(id));
check('app.js 引用的 DOM id 全部存在', missing.length === 0, '缺失: ' + missing.join(', '));

// sw.js 缓存清单中的静态资源是否存在
const swJs = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
const swPaths = [...swJs.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]).filter((p) => !p.startsWith('/api/'));
const swMissing = swPaths.filter((p) => !fs.existsSync(path.join(PUBLIC_DIR, p.slice(1))));
check('sw.js 缓存清单资源齐全', swMissing.length === 0, '缺失: ' + swMissing.join(', '));

console.log('\n========================================');
console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  console.log('失败项：');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
} else {
  console.log('全部通过 ✔');
}
