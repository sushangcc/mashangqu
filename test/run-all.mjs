'use strict';

/**
 * 一键全量测试：自动拉起空数据测试服务 → 顺序执行 API 集成测试 + 前端 E2E → 清理
 * 用法：node test/run-all.mjs   （或 npm run test:all）
 *
 * 依赖：jsdom（npm install --no-save --cache .npm-cache jsdom）
 * 注意：子进程使用 stdio inherit，不捕获管道输出，规避受限环境的管道限制。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8123;
const TOKEN = 'test-token-123';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kdc-runall-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** 运行一个测试脚本，返回是否通过 */
function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'test', script)], {
      env: {
        ...process.env,
        KDC_API_BASE: BASE,
        KDC_API_TOKEN: TOKEN,
        KDC_FE_BASE: BASE,
        KDC_FE_TOKEN: TOKEN,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

console.log('========================================');
console.log('  码上取 一键全量测试');
console.log('========================================');

// 0. 解析器单元测试（无需服务）
console.log('\n【0/3】解析器单元测试 + 前端静态检查');
const parserOk = await run('run-tests.mjs');
if (!parserOk) {
  console.error('✘ 解析器测试未通过，中止后续测试');
  process.exit(1);
}

// 1. 启动空数据测试服务（stdout 忽略，避免干扰测试输出）
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), TOKEN, DATA_DIR, HOST: '127.0.0.1' },
  stdio: 'ignore',
});

try {
  const ready = await waitReady();
  if (!ready) {
    console.error('✘ 测试服务启动失败');
    process.exit(1);
  }

  // 2. API 集成测试
  console.log('\n【1/4】API 集成测试');
  const apiOk = await run('api.test.mjs');

  // 3. App 接口契约测试（复刻 ApiClient.kt 的请求）
  console.log('\n【2/4】App 接口契约测试');
  const contractOk = await run('api-contract.test.mjs');

  // 4. 前端 E2E（依赖 jsdom）
  console.log('\n【3/4】前端 E2E（jsdom）');
  let feOk = false;
  try {
    feOk = await run('frontend.test.mjs');
  } catch (e) {
    console.error('前端 E2E 运行失败（是否已安装 jsdom？npm install --no-save --cache .npm-cache jsdom）：', e.message);
  }

  console.log('\n========================================');
  console.log(`汇总：解析器 ${parserOk ? '通过 ✔' : '失败 ✘'} | API ${apiOk ? '通过 ✔' : '失败 ✘'} | App 契约 ${contractOk ? '通过 ✔' : '失败 ✘'} | 前端 E2E ${feOk ? '通过 ✔' : '失败 ✘'}`);
  console.log('========================================');
  process.exit(apiOk && contractOk && feOk ? 0 : 1);
} finally {
  server.kill();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
