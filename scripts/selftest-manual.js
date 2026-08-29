/**
 * 手动注记功能自测。
 *
 * 覆盖：
 *  1. 本地存储层（增删改、脏数据过滤、颜色/类型归一化）
 *  2. 写回 PDF：四种类型的标准子类型、颜色、批注文本
 *  3. 幂等性：同一批注记重复写回不会叠加
 *  4. 移除：从 PDF 中精确摘除
 *
 * 用法：node scripts/selftest-manual.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const {
  writeManualAnnotations,
  removeManualAnnotations,
  MANUAL_COLORS
} = require('../electron/lib/annotations');
const { ManualAnnotations, TYPES, COLORS } = require('../electron/lib/manual-annot');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfai-manual-'));
const BACKUP = path.join(TMP, 'backups');

async function makeSamplePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 3; p++) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (let l = 1; l <= 20; l++) {
      page.drawText(`Page ${p} Line ${l}: the quick brown fox jumps over the lazy dog.`, {
        x: 60,
        y,
        size: 11,
        font
      });
      y -= 24;
    }
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function readAnnots(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, verbosity: 0, useSystemFonts: false }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    for (const a of await page.getAnnotations()) {
      out.push({
        page: n,
        subtype: a.subtype,
        rect: a.rect,
        quadPoints: a.quadPoints,
        color: a.color || null,
        text: (a.contentsObj && a.contentsObj.str) || a.contents || ''
      });
    }
  }
  await doc.destroy();
  return out;
}

function quadLen(q) {
  if (!q) return 0;
  if (Array.isArray(q)) return q.length;
  return Object.keys(q).length;
}

/** 模拟渲染进程 cssRectsToAnnotGeom 的产物：PDF 用户空间坐标 */
function geom(page, y) {
  return {
    page,
    rect: [60, y, 400, y + 14],
    quadPoints: [60, y + 14, 400, y + 14, 60, y, 400, y]
  };
}

async function main() {
  console.log('\n=== 1. 本地存储层 ===');
  const store = new ManualAnnotations(path.join(TMP, 'userdata'));
  const hash = 'deadbeefcafe1234';

  check('空文档返回空数组', store.list(hash).length === 0);

  const items = [
    {
      id: 'm-1',
      type: 'highlight',
      color: 'yellow',
      page: 1,
      rects: [{ x: 10, y: 20, w: 100, h: 14 }],
      quote: '第一段',
      note: ''
    },
    {
      id: 'm-2',
      type: 'note',
      color: 'green',
      page: 2,
      rects: [{ x: 10, y: 20, w: 100, h: 14 }],
      quote: '第二段',
      note: '这是我的批注'
    }
  ];
  store.save(hash, items);
  const loaded = store.list(hash);
  check('保存后可读回 2 条', loaded.length === 2);
  check('批注文本保留', loaded.find((x) => x.id === 'm-2').note === '这是我的批注');
  check('页码保留', loaded.find((x) => x.id === 'm-2').page === 2);
  check('自动生成时间戳', !!loaded[0].createdAt && !!loaded[0].updatedAt);

  // 脏数据过滤
  store.save(hash, [
    ...items,
    { id: 'bad-1', type: 'notatype', page: 1, rects: [{ x: 0, y: 0, w: 1, h: 1 }] }, // 非法类型
    { id: 'bad-2', type: 'highlight', page: 0, rects: [{ x: 0, y: 0, w: 1, h: 1 }] }, // 非法页码
    { id: 'bad-3', type: 'highlight', page: 1, rects: [] }, // 无矩形
    { id: 'bad-4', type: 'highlight', page: 1, rects: [{ x: NaN, y: 0, w: 1, h: 1 }] } // 非法坐标
  ]);
  check('脏数据被过滤，只剩 2 条', store.list(hash).length === 2, `实际 ${store.list(hash).length}`);

  // 归一化
  store.save(hash, [
    { id: 'm-9', type: 'highlight', color: 'notacolor', page: 1, rects: [{ x: 1, y: 1, w: 2, h: 2 }] }
  ]);
  const norm = store.list(hash)[0];
  check('非法颜色回退为 yellow', norm.color === 'yellow', norm.color);

  // 不同文档互不干扰
  store.save('otherhash00000001', [
    { id: 'x', type: 'underline', page: 1, rects: [{ x: 1, y: 1, w: 2, h: 2 }] }
  ]);
  check(
    '按文档指纹隔离',
    store.list(hash).length === 1 && store.list('otherhash00000001').length === 1
  );

  console.log('\n=== 2. 类型与颜色常量 ===');
  check('四种注记类型', TYPES.length === 4 && TYPES.includes('strikeout'));
  check('六种颜色', COLORS.length === 6 && COLORS.includes('purple'));
  check('PDF 颜色表覆盖全部色', COLORS.every((c) => Array.isArray(MANUAL_COLORS[c])));

  console.log('\n=== 3. 写回 PDF：四种类型 ===');
  const pdf = path.join(TMP, 'sample.pdf');
  await makeSamplePdf(pdf);

  const writeItems = [
    { id: 'w-hl', type: 'highlight', color: 'yellow', ...geom(1, 700), quote: '高亮的原文', note: '' },
    { id: 'w-ul', type: 'underline', color: 'blue', ...geom(1, 650), quote: '下划线的原文', note: '' },
    { id: 'w-sk', type: 'strikeout', color: 'pink', ...geom(2, 600), quote: '删除线的原文', note: '' },
    { id: 'w-nt', type: 'note', color: 'green', ...geom(2, 550), quote: '批注的原文', note: '这条很重要' }
  ];

  const res = await writeManualAnnotations({
    filePath: pdf,
    items: writeItems,
    backup: true,
    backupDir: BACKUP
  });
  check('写回成功', res.ok === true, res.error);
  check('写入 4 条', res.count === 4, `实际 ${res.count}`);
  check('生成了备份', !!res.backupPath && fs.existsSync(res.backupPath));

  let annots = await readAnnots(pdf);
  check('pdf.js 读到 4 条', annots.length === 4, `实际 ${annots.length}`);

  const bySub = (s) => annots.filter((a) => a.subtype === s);
  check('Highlight 共 2 条（高亮 + 批注）', bySub('Highlight').length === 2);
  check('Underline 1 条', bySub('Underline').length === 1);
  check('StrikeOut 1 条', bySub('StrikeOut').length === 1);

  const noteAnnot = annots.find((a) => a.text.includes('这条很重要'));
  check('批注文本写入 Contents', !!noteAnnot);
  check('批注同时保留原文', !!noteAnnot && noteAnnot.text.includes('批注的原文'));

  const hl = annots.find((a) => a.subtype === 'Highlight' && a.text.includes('高亮的原文'));
  check(
    '高亮含 QuadPoints 且为 8 的倍数',
    !!hl && quadLen(hl.quadPoints) >= 8 && quadLen(hl.quadPoints) % 8 === 0
  );

  // 颜色：pdf.js 返回 0-255
  const ul = bySub('Underline')[0];
  const expectBlue = MANUAL_COLORS.blue.map((v) => Math.round(v * 255));
  const gotBlue = (ul.color || []).slice(0, 3).map(Math.round);
  check(
    '下划线颜色为蓝色',
    gotBlue.length === 3 && gotBlue.every((v, i) => Math.abs(v - expectBlue[i]) <= 2),
    `期望 ${expectBlue} 实际 ${gotBlue}`
  );

  console.log('\n=== 4. 幂等性 ===');
  await writeManualAnnotations({ filePath: pdf, items: writeItems, backup: false });
  annots = await readAnnots(pdf);
  check('重复写回不叠加（仍为 4 条）', annots.length === 4, `实际 ${annots.length}`);

  console.log('\n=== 5. 从 PDF 移除 ===');
  const rm = await removeManualAnnotations({ filePath: pdf, ids: ['w-hl', 'w-ul'], backup: false });
  check('移除 2 条', rm.ok && rm.count === 2, `实际 ${rm.count}`);
  annots = await readAnnots(pdf);
  check('剩余 2 条', annots.length === 2, `实际 ${annots.length}`);
  check('移除的是指定 id', !annots.some((a) => a.text.includes('高亮的原文')));

  console.log('\n=== 6. 边界情况 ===');
  const badPage = await writeManualAnnotations({
    filePath: pdf,
    items: [{ id: 'z', type: 'highlight', color: 'yellow', ...geom(999, 100), quote: 'x' }],
    backup: false
  });
  check('越界页码被跳过', badPage.ok === false || badPage.count === 0);

  const noFile = await writeManualAnnotations({
    filePath: path.join(TMP, 'nope.pdf'),
    items: [],
    backup: false
  });
  check('文件不存在时优雅失败', noFile.ok === false && !!noFile.error);

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
  console.log(`测试产物：${TMP}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
