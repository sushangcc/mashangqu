'use strict';

/**
 * 生成 PWA 图标（纯 Node 实现，无依赖）
 * 绘制：蓝底圆角方块 + 白色快递箱 + 黄色封条
 * 用法：node tools/gen-icon.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制 ----------
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function drawIcon(size) {
  const img = Buffer.alloc(size * size * 4);
  const bg = [31, 111, 235, 255];        // #1f6feb
  const box = [255, 255, 255, 255];      // 白
  const tape = [255, 213, 79, 255];      // #ffd54f
  const s = size;

  const margin = Math.round(s * 0.12);
  const radius = Math.round(s * 0.24);
  // 圆角方形背景
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const px = x + 0.5, py = y + 0.5;
      const idx = (y * s + x) * 4;
      if (inRoundedRect(px, py, margin, margin, s - margin, s - margin, radius)) {
        img[idx] = bg[0]; img[idx + 1] = bg[1]; img[idx + 2] = bg[2]; img[idx + 3] = bg[3];
      }
    }
  }
  // 白色快递箱（中部偏下）
  const bx0 = Math.round(s * 0.24), bx1 = Math.round(s * 0.76);
  const by0 = Math.round(s * 0.34), by1 = Math.round(s * 0.78);
  const br = Math.round(s * 0.06);
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const idx = (y * s + x) * 4;
      if (inRoundedRect(x + 0.5, y + 0.5, bx0, by0, bx1, by1, br)) {
        img[idx] = box[0]; img[idx + 1] = box[1]; img[idx + 2] = box[2]; img[idx + 3] = box[3];
      }
    }
  }
  // 黄色封条：横 + 竖
  const tw = Math.round(s * 0.11);
  const hx0 = Math.round(s * 0.30), hx1 = Math.round(s * 0.70);
  const hy0 = Math.round(s * 0.52), hy1 = Math.round(s * 0.60);
  const vx0 = Math.round(s * 0.45), vx1 = Math.round(s * 0.55);
  const vy0 = Math.round(s * 0.40), vy1 = Math.round(s * 0.72);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const idx = (y * s + x) * 4;
      const inH = x >= hx0 && x <= hx1 && y >= hy0 && y <= hy1;
      const inV = x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
      if ((inH || inV) && img[idx + 3] === 255) {
        img[idx] = tape[0]; img[idx + 1] = tape[1]; img[idx + 2] = tape[2]; img[idx + 3] = tape[3];
      }
    }
  }
  return encodePNG(s, s, img);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log('已生成', file);
}
