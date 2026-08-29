/**
 * 生成多尺寸 ICO 图标。
 *
 * 为什么要手写：Pillow 的 Image.save(format='ICO', sizes=[...]) 在多数版本里
 * 只会写入最小的那一档（实测只落 16x16），而 electron-builder 要求图标至少
 * 256x256，否则报 "image must be at least 256x256"。
 *
 * 这里改为：先把各尺寸渲染成 PNG，再按 ICO 规范手工拼装（Vista+ 支持内嵌 PNG）。
 *
 * 用法：
 *   node scripts/make-icon.js <源图.png> [输出.ico]
 *   缺省输出 build/icon.ico，尺寸档位 16/32/48/64/128/256
 *
 * 依赖：需要 Python + Pillow 做缩放（仅用于生成中间 PNG）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SIZES = [16, 32, 48, 64, 128, 256];
const PYTHON = process.env.PDFAI_PYTHON || 'C:/Users/onion/.workbuddy/binaries/python/versions/3.13.12/python.exe';

function renderSizes(srcPng, tmpDir) {
  const py = `
from PIL import Image
import os, sys
src, out = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGBA')
for s in [${SIZES.join(',')}]:
    img.resize((s, s), Image.LANCZOS).save(os.path.join(out, f'{s}.png'), format='PNG')
`;
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync(PYTHON, ['-c', py, srcPng, tmpDir], { stdio: 'pipe' });
  return SIZES.map((s) => ({
    size: s,
    data: fs.readFileSync(path.join(tmpDir, `${s}.png`))
  }));
}

/**
 * ICO 二进制布局：
 *   ICONDIR      6 字节   reserved(2)=0  type(2)=1  count(2)=N
 *   ICONDIRENTRY 16 字节  w(1) h(1) colors(1) rsv(1) planes(2) bpp(2) size(4) offset(4)
 *   图像数据     紧随其后（PNG 原始字节）
 * 注意：宽高 >=256 时该字节写 0，这是 ICO 规范的特殊约定。
 */
function buildIco(entries) {
  const HEADER = 6;
  const DIR_ENTRY = 16;
  const dirSize = HEADER + DIR_ENTRY * entries.length;
  let dataOffset = dirSize;

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const dirs = [];
  const blobs = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(DIR_ENTRY);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // color count (0 = >=256 colors)
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(dataOffset, 12);
    dirs.push(e);
    blobs.push(data);
    dataOffset += data.length;
  }

  return Buffer.concat([header, ...dirs, ...blobs]);
}

function main() {
  const src = process.argv[2] || 'D:/workbuddy/icon.png';
  const out = process.argv[3] || path.join(__dirname, '..', 'build', 'icon.ico');

  if (!fs.existsSync(src)) {
    console.error(`源图不存在：${src}`);
    process.exit(1);
  }

  const tmpDir = path.join(require('os').tmpdir(), `pdfai-icon-${Date.now()}`);
  try {
    const entries = renderSizes(src, tmpDir);
    const ico = buildIco(entries);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, ico);
    console.log(`ICO 已生成：${out}`);
    console.log(`  尺寸档位：${entries.map((e) => `${e.size}x${e.size}`).join(', ')}`);
    console.log(`  文件大小：${(ico.length / 1024).toFixed(1)} KB`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) main();
module.exports = { buildIco, SIZES };
