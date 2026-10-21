'use strict';

/**
 * Android 工程静态一致性检查（无需 Android SDK，纯文本核对）
 * 检查项：
 *   1. 各 Kotlin 文件对 ApiClient 的方法调用必须真实存在
 *   2. R.drawable / R.mipmap 资源引用必须真实存在
 *   3. 引用的本地类必须真实存在
 * 用法：node tools/check-android.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'android', 'app', 'src', 'main');
const KOTLIN_DIR = path.join(SRC, 'java', 'com', 'mashangqu', 'app');
const RES_DIR = path.join(SRC, 'res');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log('  ✔', name);
  } else {
    failed++;
    console.log('  ✘', name, detail ? '—— ' + detail : '');
  }
}

const ktFiles = fs.readdirSync(KOTLIN_DIR).filter((f) => f.endsWith('.kt'));
const allKt = ktFiles.map((f) => fs.readFileSync(path.join(KOTLIN_DIR, f), 'utf8'));
const allSrc = allKt.join('\n');

// 1. ApiClient 方法调用存在性
const apiMethods = new Set([...allSrc.matchAll(/ApiClient\.(\w+)\(/g)].map((m) => m[1]));
const apiDefs = new Set([...allSrc.matchAll(/fun (\w+)\(/g)].map((m) => m[1]));
const apiMissing = [...apiMethods].filter((m) => !apiDefs.has(m));
check('ApiClient 调用方法全部存在', apiMissing.length === 0, '缺失: ' + apiMissing.join(', '));

// 2. R 资源引用存在性
// 注意：R.id.* 由 layout 里的 @+id 定义，不在 res/id 目录下，需单独收集
const resRefs = new Set([...allSrc.matchAll(/R\.(\w+)\.(\w+)/g)].map((m) => `${m[1]}/${m[2]}`));

// 收集所有 layout / menu / xml 文件里 @+id 声明的 id
const declaredIds = new Set();
const scanDirs = ['layout', 'menu', 'xml', 'navigation'].map((d) => path.join(RES_DIR, d));
for (const dir of scanDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of txt.matchAll(/@\+id\/(\w+)/g)) declaredIds.add(m[1]);
  }
}

const resMissing = [];
for (const ref of resRefs) {
  const [type, name] = ref.split('/');
  if (type === 'id') {
    if (!declaredIds.has(name)) resMissing.push(ref + '(layout 中无此 id)');
    continue;
  }
  const dir = path.join(RES_DIR, type);
  if (!fs.existsSync(dir)) { resMissing.push(ref); continue; }
  const files = fs.readdirSync(dir);
  const ok = files.some((f) => f === `${name}.xml` || f.startsWith(`${name}.`) || (type === 'mipmap' && f.includes(name)));
  if (!ok) resMissing.push(ref);
}
check('R 资源引用全部存在', resMissing.length === 0, '缺失: ' + resMissing.join(', '));

// 3. 本地类引用存在性（排除 kotlin/java 标准类与 android.*）
const localClasses = ['PackageItem', 'Stats', 'StoreInfo', 'PackageListResult', 'ApiException',
  'ApiClient', 'Prefs', 'MainActivity', 'MashangquWidget', 'WidgetCache', 'SmsReceiver'];
const declared = new Set();
for (const src of allKt) {
  for (const m of src.matchAll(/(?:class|object|data class)\s+(\w+)/g)) declared.add(m[1]);
}
for (const cls of localClasses) {
  const used = allSrc.includes(cls);
  if (used && !declared.has(cls)) {
    // 类在同包其他文件，或本身就是定义文件——检查是否有定义（含类声明或 companion 引用）
    const defined = allKt.some((s) => new RegExp(`(class|object|interface|enum class)\\s+${cls}\\b`).test(s));
    check(`类 ${cls} 已定义`, defined, '未找到定义');
  }
}

console.log('\n' + (failed === 0 ? '✅ Android 一致性检查全部通过' : `❌ 发现 ${failed} 项问题`));
process.exit(failed === 0 ? 0 : 1);
