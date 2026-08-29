/**
 * 关键路径自测（纯 Node，不需要 GUI）
 *
 * 覆盖技术风险最高的几处：
 *   1. pdf-lib 写入的讨论注记，能否被 pdf.js 标准解析器正确读出（决定别的阅读器点不点得动）
 *   2. 注记的幂等性：同一会话重复写入不会堆积
 *   3. 注记可移除
 *   4. 笔记 Markdown 生成
 *   5. token 估算与上下文截断
 *   6. 文档指纹在「写入注记后」保持稳定（否则笔记会对不上号）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const { writeAnnotation, removeAnnotation } = require('../electron/lib/annotations');
const { Notes } = require('../electron/lib/notes');
const { Store } = require('../electron/lib/store');
const TokenUtils = require('../electron/lib/tokens');

let pass = 0;
let fail = 0;

/** pdf.js 返回的 quadPoints 是类数组对象，统一取长度 */
function quadLen(q) {
  if (!q) return 0;
  if (Array.isArray(q)) return q.length;
  return Object.keys(q).length;
}

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfai-test-'));
const BACKUP = path.join(TMP, 'backups');

/** 造一份 5 页带文本层的测试 PDF */
async function makeSamplePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 5; p++) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (let l = 1; l <= 30; l++) {
      page.drawText(`Page ${p} Line ${l}: the quick brown fox jumps over the lazy dog.`, {
        x: 60,
        y,
        size: 11,
        font
      });
      y -= 22;
    }
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function readAnnotsWithPdfjs(file) {
  // 用 pdf.js（与浏览器同源的解析器）验证注记是否标准合规
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, verbosity: 0, useSystemFonts: false }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const annots = await page.getAnnotations();
    for (const a of annots) {
      out.push({
        page: n,
        subtype: a.subtype,
        rect: a.rect,
        quadPoints: a.quadPoints,
        // pdf.js 对非 http(s) 协议放在 unsafeUrl，文本在 contentsObj.str
        uri: a.unsafeUrl || a.url || '',
        text: (a.contentsObj && a.contentsObj.str) || a.contents || ''
      });
    }
  }
  await doc.destroy();
  return out;
}

async function main() {
  console.log('\n=== 1. 生成测试 PDF ===');
  const pdfPath = path.join(TMP, 'sample.pdf');
  await makeSamplePdf(pdfPath);
  check('测试 PDF 已生成', fs.existsSync(pdfPath), pdfPath);

  console.log('\n=== 2. 写入讨论注记 ===');
  const convId = 'c-test0001';
  const items = [
    {
      page: 2,
      // PDF 坐标（左下原点），覆盖第 2 页上部两行
      rect: [60, 700, 420, 740],
      quadPoints: [60, 700, 420, 700, 60, 740, 420, 740]
    }
  ];
  const w1 = await writeAnnotation({
    filePath: pdfPath,
    convId,
    hash: 'abcd1234abcd1234',
    contents: 'AI 讨论：这里的 QKV 是怎么来的？ → 由输入嵌入线性变换得到',
    items,
    backup: true,
    backupDir: BACKUP
  });
  check('写入成功', w1.ok, w1.error);
  check('写入了 2 个注记（高亮 + 热区）', w1.count === 2, `count=${w1.count}`);
  check('已生成备份', !!w1.backupPath && fs.existsSync(w1.backupPath));

  console.log('\n=== 3. 用 pdf.js 标准解析器回读 ===');
  let annots = [];
  try {
    annots = await readAnnotsWithPdfjs(pdfPath);
  } catch (e) {
    check('pdf.js 能解析注记', false, e.message);
  }
  if (annots.length) {
    check('pdf.js 读出 2 个注记', annots.length === 2, `实际 ${annots.length}`);
    const hl = annots.find((a) => a.subtype === 'Highlight');
    const ln = annots.find((a) => a.subtype === 'Link');
    check('存在 Highlight 注记', !!hl);
    check('存在 Link 注记', !!ln);
    check('注记落在第 2 页', annots.every((a) => a.page === 2), JSON.stringify(annots.map((a) => a.page)));
    check(
      'Highlight 带 QuadPoints（8 个数值）',
      hl && quadLen(hl.quadPoints) >= 8,
      hl ? JSON.stringify(hl.quadPoints) : 'no highlight'
    );
    check('注记带 /Contents 摘要（中文未乱码）', hl && /AI 讨论/.test(hl.text || ''), hl && hl.text);
    const uri = ln && ln.uri;
    check(
      'Link 指向 aidiscuss:// 深链',
      uri && uri.startsWith('aidiscuss://conv/c-test0001'),
      String(uri)
    );
    check('深链携带 file 指纹', uri && uri.includes('file=abcd1234abcd1234'), String(uri));
  }

  console.log('\n=== 4. 幂等性：同一会话重复写入 ===');
  const w2 = await writeAnnotation({
    filePath: pdfPath,
    convId,
    hash: 'abcd1234abcd1234',
    contents: 'AI 讨论：更新后的摘要',
    items,
    backup: false,
    backupDir: BACKUP
  });
  check('重复写入成功', w2.ok, w2.error);
  const after = await readAnnotsWithPdfjs(pdfPath);
  check('注记数量未堆积（仍为 2）', after.length === 2, `实际 ${after.length}`);
  check('摘要已更新', after.some((a) => /更新后的摘要/.test(a.text || '')));

  console.log('\n=== 5. 第二个会话的注记互不干扰 ===');
  await writeAnnotation({
    filePath: pdfPath,
    convId: 'c-test0002',
    hash: 'abcd1234abcd1234',
    contents: 'AI 讨论：第二段讨论',
    items: [{ page: 3, rect: [60, 600, 420, 640], quadPoints: [60, 600, 420, 600, 60, 640, 420, 640] }],
    backup: false,
    backupDir: BACKUP
  });
  const two = await readAnnotsWithPdfjs(pdfPath);
  check('共 4 个注记（两轮讨论各 2 个）', two.length === 4, `实际 ${two.length}`);
  check('分布在第 2、3 页', new Set(two.map((a) => a.page)).size === 2);

  console.log('\n=== 6. 移除注记 ===');
  const r1 = await removeAnnotation({ filePath: pdfPath, convId: 'c-test0001', backup: false, backupDir: BACKUP });
  check('移除成功', r1.ok, r1.error);
  check('移除了 2 个', r1.count === 2, `count=${r1.count}`);
  const rest = await readAnnotsWithPdfjs(pdfPath);
  check('剩余 2 个注记', rest.length === 2, `实际 ${rest.length}`);
  // pdf.js 只对 Link 注记解析 url，Highlight 的 /A 不体现在 uri 上
  check(
    '剩余的是第二个会话',
    rest.some((a) => (a.uri || '').includes('c-test0002')) &&
      !rest.some((a) => (a.uri || '').includes('c-test0001')),
    JSON.stringify(rest.map((a) => [a.subtype, a.uri]))
  );

  console.log('\n=== 7. 文档指纹稳定性 ===');
  const { Store: _S } = require('../electron/lib/store');
  const { fileHash } = require('../electron/lib/store');
  const h0 = fileHash(pdfPath);
  const storeDir = path.join(TMP, 'store');
  const store = new Store(storeDir);
  const meta1 = store.upsertDoc(pdfPath, { pageCount: 5 });
  // 再写一次注记，改变文件字节
  await writeAnnotation({
    filePath: pdfPath,
    convId: 'c-test0003',
    hash: meta1.hash,
    contents: '再一次写入',
    items,
    backup: false,
    backupDir: BACKUP
  });
  const h1 = fileHash(pdfPath);
  const meta2 = store.upsertDoc(pdfPath, { pageCount: 5 });
  check('写入注记后文件指纹确实变了', h0 !== h1, `${h0} vs ${h1}`);
  check('但文档记录的指纹保持不变', meta1.hash === meta2.hash, `${meta1.hash} vs ${meta2.hash}`);

  console.log('\n=== 8. 笔记 Markdown 生成 ===');
  const notes = new Notes(path.join(TMP, 'notes'));
  const now = new Date().toISOString();
  const convs = [
    {
      id: 'c-aaa',
      createdAt: now,
      updatedAt: now,
      mode: 'context',
      model: 'deepseek-chat',
      anchor: { page: 3, lineStart: 12, lineEnd: 14, quote: 'The attention mechanism allows...' },
      conclusion: 'QKV 由输入嵌入经三次线性变换得到',
      annotated: true,
      annotNo: 1,
      messages: [
        { role: 'user', content: '这里的 QKV 是怎么来的？' },
        {
          role: 'assistant',
          content: '由输入嵌入分别乘 W_Q / W_K / W_V 得到【第 3 页 第 12 行】。',
          model: 'deepseek-chat',
          usage: { prompt_tokens: 1200, completion_tokens: 320 }
        }
      ]
    },
    {
      id: 'c-bbb',
      createdAt: now,
      updatedAt: now,
      mode: 'web',
      model: 'deepseek-chat',
      anchor: { page: 8, lineStart: 3, lineEnd: 3, quote: 'Table 2: ablation study' },
      conclusion: '',
      annotated: false,
      messages: [
        { role: 'user', content: '这个方法和 FlashAttention 相比如何？' },
        {
          role: 'assistant',
          content: 'FlashAttention 通过分块降低显存 [1][2]。',
          model: 'deepseek-chat',
          sources: [{ title: 'FlashAttention', url: 'https://arxiv.org/abs/2205.14135', snippet: '...' }]
        }
      ]
    }
  ];
  const mdPath = notes.write(
    { hash: 'abcd1234abcd1234', filePath: pdfPath, fileName: 'sample.pdf', title: '示例论文', pageCount: 5, createdAt: now, updatedAt: now },
    convs
  );
  const md = fs.readFileSync(mdPath, 'utf8');
  check('笔记文件已生成', fs.existsSync(mdPath), mdPath);
  check('含文档标题', /# 示例论文/.test(md));
  check('含位置信息（页码+行号）', /第 3 页 第 12-14 行/.test(md), md.slice(0, 400));
  check('含模式标注', /上下文讨论/.test(md) && /联网检索讨论/.test(md));
  check('含结论', /QKV 由输入嵌入/.test(md));
  check('含讨论索引表', /讨论索引/.test(md));
  check('含深链', /aidiscuss:\/\/conv\/c-aaa/.test(md));
  check('含检索来源', /FlashAttention/.test(md) && /arxiv\.org/.test(md));
  check('含会话 ID', /c-aaa/.test(md) && /c-bbb/.test(md));

  console.log('\n=== 9. token 估算与截断 ===');
  const pages = [];
  for (let n = 1; n <= 20; n++) {
    pages.push({ page: n, text: '中文正文内容。'.repeat(400) }); // 每页约 2800 字
  }
  const est = TokenUtils.estimateTokens(pages[0].text);
  check('单页 token 估算合理', est > 1000 && est < 5000, String(est));
  const built = TokenUtils.buildContext(pages, 10, 12000);
  check('截断后不超上限', built.tokens <= 12000, String(built.tokens));
  check('标记为已截断', built.truncated === true);
  check('以锚点页为中心取文', built.usedPages.includes(10), JSON.stringify(built.usedPages));
  check('保留锚点页附近页', built.usedPages.includes(9) && built.usedPages.includes(11));
  const wide = TokenUtils.buildContext(pages, 10, 999999);
  check('上限足够时不截断', wide.truncated === false && wide.usedPages.length === 20);
  const one = TokenUtils.buildContext([{ page: 1, text: '短文本' }], 1, 12000);
  check('单页短文本正常', one.tokens > 0 && one.truncated === false);

  console.log('\n=== 10. 会话检索（深链恢复用） ===');
  store.saveConversations(meta1.hash, convs);
  const found = store.findConversation('c-bbb', meta1.hash);
  check('能按会话 ID 反查', !!found && found.conversation.id === 'c-bbb');
  check('能拿到所属文档', found && found.meta.filePath === pdfPath);
  const missed = store.findConversation('c-notexist', meta1.hash);
  check('查不到时返回 null', missed === null);

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========\n`);
  console.log(`测试产物：${TMP}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n自测脚本异常：', e);
  process.exit(1);
});
