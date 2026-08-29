/** 读取 exe 内嵌的图标资源尺寸，用于确认打包图标是否生效。 */
const fs = require('fs');
const path = require('path');

const exe = process.argv[2] || 'dist/win-unpacked/AI PDF Reader.exe';
if (!fs.existsSync(exe)) {
  console.error('找不到文件：', exe);
  process.exit(1);
}

const buf = fs.readFileSync(exe);

// ---- 定位 PE 头
const e_lfanew = buf.readUInt32LE(0x3c);
if (buf.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\0\0') {
  console.error('不是有效的 PE 文件');
  process.exit(1);
}
const coff = e_lfanew + 4;
const optMagic = buf.readUInt16LE(coff + 20);
const isPE32Plus = optMagic === 0x20b;
// 数据目录偏移：PE32 在 opt+96，PE32+ 在 opt+112
const dataDirOff = coff + 20 + (isPE32Plus ? 112 : 96);
const rsrcRVA = buf.readUInt32LE(dataDirOff + 2 * 8);
const rsrcSize = buf.readUInt32LE(dataDirOff + 2 * 8 + 4);

// ---- 段表：RVA -> 文件偏移
const numSections = buf.readUInt16LE(coff + 2);
const optSize = buf.readUInt16LE(coff + 16);
let secOff = coff + 20 + optSize;
const sections = [];
for (let i = 0; i < numSections; i++) {
  const s = secOff + i * 40;
  sections.push({
    name: buf.toString('ascii', s, s + 8).replace(/\0/g, ''),
    vsize: buf.readUInt32LE(s + 8),
    vaddr: buf.readUInt32LE(s + 12),
    rawSize: buf.readUInt32LE(s + 16),
    rawPtr: buf.readUInt32LE(s + 20)
  });
}
function rvaToOff(rva) {
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
      return s.rawPtr + (rva - s.vaddr);
    }
  }
  return -1;
}

// ---- 遍历资源树
const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const rootOff = rvaToOff(rsrcRVA);

function readEntry(off) {
  const id = buf.readUInt32LE(off);
  const nameOff = buf.readUInt32LE(off + 4);
  return { id, nameOff, isDir: (nameOff & 0x80000000) !== 0, dirOff: nameOff & 0x7fffffff };
}

function readResDir(off) {
  const named = buf.readUInt16LE(off + 12);
  const ids = buf.readUInt16LE(off + 14);
  const out = [];
  for (let i = 0; i < named + ids; i++) {
    out.push(readEntry(off + 16 + i * 8));
  }
  return out;
}

function readDataEntry(off) {
  return {
    rva: buf.readUInt32LE(off),
    size: buf.readUInt32LE(off + 4)
  };
}

const groupSizes = [];
const iconDims = [];

for (const lvl1 of readResDir(rootOff)) {
  if (!lvl1.isDir) continue;
  const typeId = lvl1.id;

  for (const lvl2 of readResDir(rootOff + lvl1.dirOff)) {
    if (!lvl2.isDir) continue;
    for (const lvl3 of readResDir(rootOff + lvl2.dirOff)) {
      if (lvl3.isDir) continue;
      const de = readDataEntry(rootOff + lvl3.dirOff);
      const dataOff = rvaToOff(de.rva);
      if (dataOff < 0) continue;
      const data = buf.subarray(dataOff, dataOff + Math.min(de.size, buf.length - dataOff));

      if (typeId === RT_GROUP_ICON) {
        // GRPICONDIR: reserved(2) type(2) count(2) + 14 字节/项
        const count = data.readUInt16LE(4);
        for (let i = 0; i < count; i++) {
          const p = 6 + i * 14;
          if (p + 8 > data.length) break;
          let w = data.readUInt8(p);
          let h = data.readUInt8(p + 1);
          if (w === 0) w = 256;
          if (h === 0) h = 256;
          groupSizes.push({ w, h, bpp: data.readUInt16LE(p + 6) });
        }
      } else if (typeId === RT_ICON) {
        const isPng =
          data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
        if (isPng) {
          // 256x256 通常是 PNG 压缩存储，不以 BITMAPINFOHEADER 开头
          const outFile = process.argv[3] || 'dist/exe-icon-extracted.png';
          fs.writeFileSync(outFile, data);
          console.log(`  [PNG 图标] 已提取 ${data.length} 字节 -> ${outFile}`);
        } else if (data.length >= 12 && data.readUInt32LE(0) === 40) {
          // BITMAPINFOHEADER: biSize(4) biWidth(4) biHeight(4)
          iconDims.push({ w: Math.abs(data.readInt32LE(4)), h: Math.abs(data.readInt32LE(8)) / 2 });
        }
      }
    }
  }
}

console.log(`文件：${path.basename(exe)}`);
console.log(`图标组条目：${groupSizes.length}`);
if (groupSizes.length) {
  const uniq = [...new Set(groupSizes.map((s) => `${s.w}x${s.h}`))];
  console.log(`  声明尺寸：${uniq.join(', ')}`);
  const maxS = Math.max(...groupSizes.map((s) => s.w));
  console.log(`  最大尺寸：${maxS}px  ${maxS >= 256 ? '(满足 Windows 大图标要求)' : '(偏小)'}`);
}
console.log(`图标位图数据块：${iconDims.length}`);
if (iconDims.length) {
  const uniq2 = [...new Set(iconDims.map((s) => `${s.w}x${s.h}`))];
  console.log(`  实际位图：${uniq2.join(', ')}`);
}
