/**
 * 生成品牌图标资源（纯 Node，不依赖 Electron / 任何三方库）。
 *
 *   npm run icons
 *
 * 为什么不用 Electron 渲染 SVG？因为 CI 与无 GPU 环境里 Chromium 的 GPU 进程
 * 会直接 fatal，而图标是构建期必需品，不应该被运行环境卡住。这里自己用
 * 4×4 超采样光栅化几何图元，输出带抗锯齿的 RGBA PNG，再组装多尺寸 .ico。
 *
 * 产物：
 *   assets/icon.png          512×512
 *   assets/tray.png           32×32
 *   src/renderer/logo.png    128×128
 *   build/icon.png           512×512
 *   build/icon.ico           16/24/32/48/64/128/256
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 512;
const SAMPLES = 4; // 每轴采样数 → 16 采样/像素

// ── 几何 ────────────────────────────────────────────────────────────────────
/** 圆角矩形有符号距离：<=0 表示在内部。 */
function sdfRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** 圆环有符号距离：<=0 表示落在环带上。 */
function sdfRing(px, py, cx, cy, radius, halfWidth) {
  return Math.abs(Math.hypot(px - cx, py - cy) - radius) - halfWidth;
}

/** 从正上方起、顺时针计的角度（度，0–360）。 */
function angleFromTop(px, py, cx, cy) {
  const deg = (Math.atan2(px - cx, -(py - cy)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// 图形参数（以 512 为基准，缩放到任意尺寸）
const SQUARE_RADIUS = 116;
const RING = { cx: 256, cy: 262, radius: 138, halfWidth: 17 };
const ARC = { from: 2, to: 288 }; // 顺时针弧段，两端留出圆头
const CORE = { cx: 256, cy: 262, half: 52, radius: 30 };

const GRADIENT_STOPS = [
  { at: 0, color: [0x4d, 0x6b, 0xfe] },
  { at: 0.55, color: [0x5b, 0x63, 0xff] },
  { at: 1, color: [0x8b, 0x5c, 0xf6] },
];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gradientColor(t) {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i += 1) {
    const left = GRADIENT_STOPS[i];
    const right = GRADIENT_STOPS[i + 1];
    if (clamped >= left.at && clamped <= right.at) {
      const local = (clamped - left.at) / (right.at - left.at);
      return [0, 1, 2].map((channel) => lerp(left.color[channel], right.color[channel], local));
    }
  }
  return GRADIENT_STOPS[GRADIENT_STOPS.length - 1].color.slice();
}

/** 判断一个采样点是否在某个图元内（坐标已经是 512 基准）。 */
function shapeAt(x, y, isInside) {
  return isInside(x, y) ? 1 : 0;
}

/** 返回该采样点的 RGBA（0–1 浮点）。 */
function sampleColor(x, y) {
  const inSquare = sdfRoundRect(x, y, 256, 256, 256, 256, SQUARE_RADIUS) <= 0;
  if (!inSquare) return [0, 0, 0, 0];

  // 底色：对角渐变
  let [r, g, b] = gradientColor((x + y) / (BASE * 2));

  // 顶部高光
  const glow = 0.3 * (1 - y / BASE);
  r = lerp(r, 255, glow);
  g = lerp(g, 255, glow);
  b = lerp(b, 255, glow);

  const ringHit = sdfRing(x, y, RING.cx, RING.cy, RING.radius, RING.halfWidth) <= 0;

  // 暗环（完整一圈，低透明度）
  if (ringHit) {
    r = lerp(r, 255, 0.34);
    g = lerp(g, 255, 0.34);
    b = lerp(b, 255, 0.34);
  }

  // 高亮弧（表示"运行中"的进度环）
  if (ringHit) {
    const deg = angleFromTop(x, y, RING.cx, RING.cy);
    if (deg >= ARC.from && deg <= ARC.to) {
      r = 255;
      g = 255;
      b = 255;
    }
  }

  // 中心核心块：旋转 45° 的圆角方块
  const dx = x - CORE.cx;
  const dy = y - CORE.cy;
  const cos = Math.SQRT1_2;
  const rx = dx * cos + dy * cos;
  const ry = -dx * cos + dy * cos;
  if (sdfRoundRect(rx, ry, 0, 0, CORE.half, CORE.half, CORE.radius) <= 0) {
    r = 255;
    g = 255;
    b = 255;
  }

  return [r, g, b, 1];
}

/** 光栅化成 RGBA buffer（straight alpha）。 */
function rasterize(size) {
  const scale = BASE / size;
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + offset + sx * step) * scale;
          const y = (py + offset + sy * step) * scale;
          const [r, g, b, a] = sampleColor(x, y);
          accR += r * a;
          accG += g * a;
          accB += b * a;
          accA += a;
        }
      }

      const count = SAMPLES * SAMPLES;
      const alpha = accA / count;
      const index = (py * size + px) * 4;
      if (alpha <= 0.0001) {
        out[index + 3] = 0;
        continue;
      }
      out[index] = Math.round(Math.min(255, accR / accA));
      out[index + 1] = Math.round(Math.min(255, accG / accA));
      out[index + 2] = Math.round(Math.min(255, accB / accA));
      out[index + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ── PNG 编码 ────────────────────────────────────────────────────────────────
function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── ICO 组装 ────────────────────────────────────────────────────────────────
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    directory.writeUInt8(0, base + 2);
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
function write(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return `${path.relative(ROOT, target).replace(/\\/g, '/')}  ${(data.length / 1024).toFixed(1)} KB`;
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngCache = new Map();

function pngFor(size) {
  if (!pngCache.has(size)) pngCache.set(size, encodePng(rasterize(size), size));
  return pngCache.get(size);
}

const outputs = [
  write(path.join(ROOT, 'assets', 'icon.png'), pngFor(512)),
  write(path.join(ROOT, 'assets', 'tray.png'), pngFor(32)),
  write(path.join(ROOT, 'src', 'renderer', 'logo.png'), pngFor(128)),
  write(path.join(ROOT, 'build', 'icon.png'), pngFor(512)),
  write(path.join(ROOT, 'build', 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, data: pngFor(size) })))),
];

process.stdout.write(`\n图标资源已生成：\n  ${outputs.join('\n  ')}\n\n`);
