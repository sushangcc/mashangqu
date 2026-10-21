'use strict';

/**
 * 把 public/ 同步到 Android 的 assets/www
 *
 * WebView 版 App 的界面直接加载 assets/www 里的静态资源，
 * 每次改完网页版都必须跑一次本脚本，否则装到手机上看到的还是旧界面。
 *
 * 用法：node tools/sync-www.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const DEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www');

/** WebView 加载本地文件时不需要 Service Worker */
const SKIP = new Set(['sw.js']);

function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? path.join(base, name) : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else if (!SKIP.has(rel.replace(/\\/g, '/'))) out.push({ rel, full, size: st.size });
  }
  return out;
}

if (!fs.existsSync(SRC)) {
  console.error('[sync-www] 找不到 public 目录: ' + SRC);
  process.exit(1);
}

// 清空目标目录（保留目录本身）
fs.mkdirSync(DEST, { recursive: true });
for (const name of fs.readdirSync(DEST)) {
  fs.rmSync(path.join(DEST, name), { recursive: true, force: true });
}

const files = walk(SRC);
let total = 0;
for (const f of files) {
  const target = path.join(DEST, f.rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(f.full, target);
  total += f.size;
  console.log('  ' + f.rel.replace(/\\/g, '/') + '  ' + f.size + ' B');
}

console.log('\n[sync-www] 已同步 ' + files.length + ' 个文件，共 ' + (total / 1024).toFixed(1) + ' KB');
console.log('[sync-www] 目标: ' + DEST);
console.log('\n提示：改完网页版后需重新编译 APK 才能在手机上生效：');
console.log('  cd android && gradle assembleDebug');
