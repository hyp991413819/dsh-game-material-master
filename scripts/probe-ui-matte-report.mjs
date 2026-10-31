/**
 * 抠图产物像素体检（只读，不占显卡）。
 *
 * 对同一张渲染图的两种抠图产物，量三件事：
 *   ① **alpha 分布** —— UI 元素需要「内部实心、边缘收边」；连续 alpha 会让面板发虚。
 *   ② **内部不透明度** —— 腐蚀掉边缘 6px 后的 alpha 均值，接近 255 才算实心。
 *   ③ **RGB 保真** —— 与源图同一区域的 RGB 平均绝对差；抠图不该改颜色。
 *
 * 用法：node scripts/probe-ui-matte-report.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const RENDER = "F:\\comfyui\\ComfyUI\\output\\gmm_ui\\umvvvuibn560d20_00001_.png";
const BOXES = [
  { key: "panel", box: [112, 112, 912, 808], dirs: ["gmm_ab_wevisone", "gmm_ab_qwen"], file: "element_01_object_the_whole_dark.png" },
  { key: "title", box: [292, 172, 732, 308], dirs: ["gmm_ab_wevisone", "gmm_ab_qwen"], file: "element_02_text_DAILY_SIGN_IN.png" }
];

const OUT = "F:\\comfyui\\ComfyUI\\output";

// 用内置 PNG 解码：Node 没有图像库，走 zlib + 手写解滤波（与 src/png.ts 同一思路）。
import { inflateSync } from "node:zlib";

function decodePng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`不支持的 colorType ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]; pos += 1;
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** 腐蚀 mask（方形核），返回布尔数组：true = 内部。 */
function erode(mask, width, height, radius) {
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let ok = 1;
      for (let dx = -radius; dx <= radius && ok; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width || !mask[y * width + nx]) ok = 0;
      }
      tmp[y * width + x] = ok;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let ok = 1;
      for (let dy = -radius; dy <= radius && ok; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height || !tmp[ny * width + x]) ok = 0;
      }
      out[y * width + x] = ok;
    }
  }
  return out;
}

function stats(image, label) {
  const { width, height, channels, data } = image;
  const hasAlpha = channels === 4;
  let sum = 0, opaque = 0, zero = 0, partial = 0, n = width * height;
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = hasAlpha ? data[i * channels + 3] : 255;
    sum += a;
    if (a >= 255) opaque += 1;
    else if (a <= 0) zero += 1;
    else partial += 1;
    if (a >= 128) solid[i] = 1;
  }
  const inner = erode(solid, width, height, 6);
  let innerSum = 0, innerCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (inner[i]) { innerSum += hasAlpha ? data[i * channels + 3] : 255; innerCount += 1; }
  }
  const pct = (v) => `${((v / n) * 100).toFixed(1)}%`;
  console.log(`  ${label}  ${width}×${height}`);
  console.log(`    alpha 均值 ${(sum / n).toFixed(1)} · 全不透明 ${pct(opaque)} · 全透明 ${pct(zero)} · 半透明 ${pct(partial)}`);
  console.log(`    内部(腐蚀6px) ${innerCount} px · 不透明度均值 ${innerCount ? (innerSum / innerCount).toFixed(1) : "n/a"}`);
  return { innerCount, innerAlpha: innerCount ? innerSum / innerCount : 0 };
}

/** 从源图裁出同一块，量 RGB 平均绝对差。 */
function rgbDiff(source, sliced, box) {
  const [x1, y1] = box;
  let diffSum = 0, count = 0;
  for (let y = 0; y < sliced.height; y += 1) {
    for (let x = 0; x < sliced.width; x += 1) {
      const sy = y1 + y, sx = x1 + x;
      if (sy >= source.height || sx >= source.width) continue;
      const si = (sy * source.width + sx) * source.channels;
      const di = (y * sliced.width + x) * sliced.channels;
      const a = sliced.channels === 4 ? sliced.data[di + 3] : 255;
      if (a < 250) continue; // 只比不透明处
      for (let c = 0; c < 3; c += 1) diffSum += Math.abs(source.data[si + c] - sliced.data[di + c]);
      count += 1;
    }
  }
  return count === 0 ? null : { mean: diffSum / (count * 3), count };
}

/**
 * 在源图里按「最佳位移」找产物对应的那块，再量 RGB 平均绝对差。
 *
 * 产物是**紧裁**过的，起点不等于画框原点；直接按画框原点对齐会整体错位，
 * 量出来的差值没有意义（曾经因此把「文字抠得很准」误判成 141 的大偏差）。
 * 这里在 ±24px 内搜一遍，取差最小的那个位移。
 */
function bestRgbDiff(source, sliced, box) {
  const search = 24;
  let best = null;
  for (let dy = -search; dy <= search; dy += 2) {
    for (let dx = -search; dx <= search; dx += 2) {
      const diff = rgbDiff(source, sliced, [box[0] + dx, box[1] + dy]);
      if (diff && (best === null || diff.mean < best.mean)) best = { ...diff, dx, dy };
    }
  }
  return best;
}

if (!existsSync(RENDER)) {
  console.error(`找不到渲染图：${RENDER}`);
  process.exit(1);
}
const source = decodePng(readFileSync(RENDER));
console.log(`源图 ${RENDER.split("\\").pop()} ${source.width}×${source.height}\n`);

for (const entry of BOXES) {
  console.log(`=== ${entry.key} ===`);
  for (const dir of entry.dirs) {
    const path = join(OUT, dir, entry.file);
    if (!existsSync(path)) { console.log(`  ${dir}: 产物还没出来`); continue; }
    const image = decodePng(readFileSync(path));
    stats(image, dir);
    const diff = bestRgbDiff(source, image, entry.box);
    if (diff) {
      console.log(
        `    RGB 与源图平均绝对差 ${diff.mean.toFixed(2)}` +
          `（最佳位移 ${diff.dx},${diff.dy}；比了 ${diff.count} 个不透明像素）`
      );
    }
  }
  console.log("");
}
