/**
 * 把讨论以 PDF 注记的形式写回原文件。
 *
 * 每次讨论写两个注记（共享同一个会话 ID，便于幂等增删）：
 *   1. Highlight —— 半透明高亮选中区域，/Contents 里放讨论摘要，鼠标悬停可见
 *   2. Link     —— 覆盖同区域的透明热区，URI 指向 aidiscuss://conv/<id>?file=<hash>
 *                  任何支持外链的阅读器点击后都会唤起本应用并恢复该轮对话
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFString, PDFHexString } = require('pdf-lib');

const NM_PREFIX = 'ai-conv-';

function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function nmFor(convId, kind) {
  return `${NM_PREFIX}${convId}-${kind}`;
}

/** 移除某会话已有的全部注记，返回被移除的数量 */
function removeExisting(doc, convId) {
  let removed = 0;
  const pages = doc.getPages();
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      let dict;
      try {
        dict = doc.context.lookup(ref);
      } catch {
        keep.push(ref);
        continue;
      }
      let nm = '';
      try {
        const nmObj = dict.get ? dict.get(PDFName.of('NM')) : null;
        if (nmObj && nmObj.asString) nm = nmObj.asString();
      } catch {
        nm = '';
      }
      if (nm && nm.startsWith(`${NM_PREFIX}${convId}-`)) {
        removed++;
        continue;
      }
      keep.push(ref);
    }
    if (removed > 0) {
      page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    }
  }
  return removed;
}

/**
 * @param {object} opts
 * @param {string} opts.filePath   目标 PDF 绝对路径
 * @param {string} opts.convId     会话 ID
 * @param {string} opts.hash       文档指纹（写进 URI，便于外部唤起时定位）
 * @param {string} opts.contents   注记内容（讨论摘要）
 * @param {Array}  opts.items      [{page(1-based), rect:[x1,y1,x2,y2], quadPoints:[...8n]}]
 * @param {boolean} opts.backup    写入前是否备份
 * @param {string} opts.backupDir
 * @returns {Promise<{ok:boolean, error?:string, backupPath?:string, count:number}>}
 */
async function writeAnnotation(opts) {
  const { filePath, convId, hash, contents, items, backup, backupDir } = opts;

  if (!fs.existsSync(filePath)) return { ok: false, error: 'PDF 文件不存在', count: 0 };
  if (!items || !items.length) return { ok: false, error: '没有可标注的位置', count: 0 };

  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: `读取 PDF 失败：${e.message}`, count: 0 };
  }

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
  } catch (e) {
    if (/encrypt/i.test(e.message || '')) {
      return { ok: false, error: '该 PDF 已加密，无法写入注记（请先解除加密）', count: 0 };
    }
    return { ok: false, error: `解析 PDF 失败：${e.message}`, count: 0 };
  }

  const safeContents = String(contents || 'AI 讨论').slice(0, 1500);
  const uri = `aidiscuss://conv/${encodeURIComponent(convId)}?file=${encodeURIComponent(hash || '')}`;
  const now = pdfDate();
  let count = 0;

  try {
    // 幂等：先清掉该会话的旧注记
    removeExisting(doc, convId);

    const pages = doc.getPages();
    for (const it of items) {
      const pageIndex = Number(it.page) - 1;
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) continue;
      const page = pages[pageIndex];

      const rect = (it.rect || []).map(Number);
      if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) continue;

      let quads = (it.quadPoints || []).map(Number);
      if (quads.length < 8 || quads.some((n) => !Number.isFinite(n))) {
        // 退化成一个覆盖整块矩形的四边形（左下 右下 左上 右上）
        const [x1, y1, x2, y2] = rect;
        quads = [x1, y1, x2, y1, x1, y2, x2, y2];
      }
      // QuadPoints 必须是 8 的倍数
      quads = quads.slice(0, Math.floor(quads.length / 8) * 8);

      // 1) 高亮注记
      const hl = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: rect,
        QuadPoints: quads,
        C: [1, 0.82, 0.18],
        CA: 0.35,
        T: PDFHexString.fromText('AI PDF Reader'),
        Contents: PDFHexString.fromText(safeContents),
        M: PDFString.of(now),
        NM: PDFString.of(nmFor(convId, 'hl')),
        F: 4, // Print
        A: doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(uri) })
      });
      pushAnnot(doc, page, hl);
      count++;

      // 2) 透明热区，保证各种阅读器都能点中
      const link = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: rect,
        Border: [0, 0, 0],
        Contents: PDFHexString.fromText(`点击恢复该讨论：${safeContents}`),
        M: PDFString.of(now),
        NM: PDFString.of(nmFor(convId, 'ln')),
        F: 4,
        A: doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(uri) })
      });
      pushAnnot(doc, page, link);
      count++;
    }

    if (!count) return { ok: false, error: '没有有效的标注位置', count: 0 };

    let backupPath;
    if (backup) {
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const base = path.basename(filePath, path.extname(filePath));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        backupPath = path.join(backupDir, `${base}.${stamp}.bak.pdf`);
        fs.copyFileSync(filePath, backupPath);
      } catch (e) {
        console.warn('[annotations] 备份失败：', e.message);
      }
    }

    const out = await doc.save({ useObjectStreams: true });

    // 先写临时文件再替换，降低写坏原文件的风险
    const tmp = `${filePath}.aidiscuss.tmp`;
    try {
      fs.writeFileSync(tmp, out);
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }

    return { ok: true, count, backupPath };
  } catch (e) {
    const msg = /EPERM|EBUSY|EACCES/i.test(e.message || '')
      ? '无法写入：PDF 可能正被其它程序占用（如 Acrobat、浏览器），请关闭后重试'
      : `写回注记失败：${e.message}`;
    return { ok: false, error: msg, count: 0 };
  }
}

/** 删除某个会话的所有注记 */
async function removeAnnotation({ filePath, convId, backup, backupDir }) {
  if (!fs.existsSync(filePath)) return { ok: false, error: 'PDF 文件不存在', count: 0 };

  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: `读取 PDF 失败：${e.message}`, count: 0 };
  }

  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const removed = removeExisting(doc, convId);
    if (!removed) return { ok: true, count: 0 };

    let backupPath;
    if (backup) {
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        const base = path.basename(filePath, path.extname(filePath));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        backupPath = path.join(backupDir, `${base}.${stamp}.bak.pdf`);
        fs.copyFileSync(filePath, backupPath);
      } catch {
        /* ignore */
      }
    }

    const out = await doc.save({ useObjectStreams: true });
    const tmp = `${filePath}.aidiscuss.tmp`;
    try {
      fs.writeFileSync(tmp, out);
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }
    return { ok: true, count: removed, backupPath };
  } catch (e) {
    const msg = /EPERM|EBUSY|EACCES/i.test(e.message || '')
      ? '无法写入：PDF 可能正被其它程序占用，请关闭后重试'
      : `移除注记失败：${e.message}`;
    return { ok: false, error: msg, count: 0 };
  }
}

function pushAnnot(doc, page, dict) {
  const ref = doc.context.register(dict);
  const annots = page.node.Annots();
  if (annots && typeof annots.push === 'function') {
    annots.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
  }
}

/* ==========================================================================
   手动注记：写回 / 移除 PDF
   与 AI 会话注记的区别：
   - 不挂 URI 动作（没有可跳转的会话），是纯展示型注记
   - 类型映射为标准子类型 Highlight / Underline / StrikeOut
   ========================================================================== */

const MANUAL_NM_PREFIX = 'manual-';

/** 注记颜色 -> PDF 设备 RGB（0~1） */
const MANUAL_COLORS = {
  yellow: [1, 0.83, 0.22],
  green: [0.36, 0.82, 0.44],
  blue: [0.32, 0.64, 1],
  pink: [1, 0.52, 0.7],
  purple: [0.68, 0.48, 0.96],
  orange: [1, 0.61, 0.24]
};

/** 注记类型 -> PDF 注记子类型（批注用高亮承载，文本放进 Contents） */
const MANUAL_SUBTYPE = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  note: 'Highlight'
};

/** 按 NM 前缀批量移除注记，返回移除数量 */
function removeByNmPrefix(doc, prefix) {
  let removed = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      let dict;
      try {
        dict = doc.context.lookup(ref);
      } catch {
        keep.push(ref);
        continue;
      }
      let nm = '';
      try {
        const nmObj = dict.get ? dict.get(PDFName.of('NM')) : null;
        if (nmObj && nmObj.asString) nm = nmObj.asString();
      } catch {
        nm = '';
      }
      if (nm && nm.startsWith(prefix)) {
        removed++;
        continue;
      }
      keep.push(ref);
    }
    page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
  return removed;
}

/**
 * 把手动注记写回 PDF。
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {Array}  opts.items  [{id,type,color,page,rect:[x1,y1,x2,y2],quadPoints:[...8n],quote,note}]
 *                             坐标须已转成 PDF 用户空间（渲染侧 cssRectsToAnnotGeom 负责）
 * @param {boolean} opts.backup
 * @param {string} opts.backupDir
 */
async function writeManualAnnotations({ filePath, items, backup = true, backupDir = null }) {
  if (!fs.existsSync(filePath)) return { ok: false, error: 'PDF 文件不存在', count: 0 };
  try {
    const bytes = fs.readFileSync(filePath);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPages();
    const now = pdfDate();

    // 同 id 先清旧版，保证重复写回不会叠加出重复注记
    for (const it of items || []) {
      if (it && it.id) removeByNmPrefix(doc, `${MANUAL_NM_PREFIX}${it.id}`);
    }

    let count = 0;
    for (const it of items || []) {
      const pageIndex = Number(it.page) - 1;
      if (!Number.isFinite(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) continue;
      const page = pages[pageIndex];

      const rect = (it.rect || []).map(Number);
      if (rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) continue;

      let quads = (it.quadPoints || []).map(Number);
      if (quads.length < 8 || quads.some((n) => !Number.isFinite(n))) {
        const [x1, y1, x2, y2] = rect;
        quads = [x1, y1, x2, y1, x1, y2, x2, y2];
      }
      quads = quads.slice(0, Math.floor(quads.length / 8) * 8);

      const subtype = MANUAL_SUBTYPE[it.type] || 'Highlight';
      const rgb = MANUAL_COLORS[it.color] || MANUAL_COLORS.yellow;
      // 批注把用户写的笔记放前面，原文其次，方便外部阅读器一眼看到重点
      const contents = [it.note, it.quote].filter(Boolean).join('\n') || '注记';

      pushAnnot(
        doc,
        page,
        doc.context.obj({
          Type: 'Annot',
          Subtype: subtype,
          Rect: rect,
          QuadPoints: quads,
          C: rgb,
          CA: it.type === 'note' ? 0.42 : 0.35,
          T: PDFHexString.fromText('AI PDF Reader'),
          Contents: PDFHexString.fromText(contents),
          M: PDFString.of(now),
          NM: PDFString.of(`${MANUAL_NM_PREFIX}${it.id || `x${count}`}`),
          F: 4 // Print
        })
      );
      count++;
    }

    if (!count) return { ok: false, error: '没有有效的注记位置', count: 0 };

    let backupPath;
    if (backup) {
      try {
        const dir = backupDir && backupDir.trim() ? backupDir : path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(filePath, path.extname(filePath));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        backupPath = path.join(dir, `${base}.${stamp}.bak.pdf`);
        fs.copyFileSync(filePath, backupPath);
      } catch (e) {
        console.warn('[annotations] 手动注记备份失败：', e.message);
      }
    }

    const out = await doc.save({ useObjectStreams: true });
    const tmp = `${filePath}.aimanual.tmp`;
    try {
      fs.writeFileSync(tmp, out);
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }

    return { ok: true, count, backupPath };
  } catch (e) {
    const msg = /EPERM|EBUSY|EACCES/i.test(e.message || '')
      ? '无法写入：PDF 可能正被其它程序占用（如 Acrobat、浏览器），请关闭后重试'
      : `写回注记失败：${e.message}`;
    return { ok: false, error: msg, count: 0 };
  }
}

/** 从 PDF 中移除指定的手动注记 */
async function removeManualAnnotations({ filePath, ids = [], backup = true, backupDir = null }) {
  if (!fs.existsSync(filePath)) return { ok: false, error: 'PDF 文件不存在', count: 0 };
  try {
    const bytes = fs.readFileSync(filePath);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });

    let count = 0;
    for (const id of ids) count += removeByNmPrefix(doc, `${MANUAL_NM_PREFIX}${id}`);
    if (!count) return { ok: true, count: 0 };

    let backupPath;
    if (backup) {
      try {
        const dir = backupDir && backupDir.trim() ? backupDir : path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(filePath, path.extname(filePath));
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        backupPath = path.join(dir, `${base}.${stamp}.bak.pdf`);
        fs.copyFileSync(filePath, backupPath);
      } catch (e) {
        console.warn('[annotations] 手动注记备份失败：', e.message);
      }
    }

    const out = await doc.save({ useObjectStreams: true });
    const tmp = `${filePath}.aimanual.tmp`;
    try {
      fs.writeFileSync(tmp, out);
      fs.rmSync(filePath, { force: true });
      fs.renameSync(tmp, filePath);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }
    return { ok: true, count, backupPath };
  } catch (e) {
    const msg = /EPERM|EBUSY|EACCES/i.test(e.message || '')
      ? '无法写入：PDF 可能正被其它程序占用，请关闭后重试'
      : `移除注记失败：${e.message}`;
    return { ok: false, error: msg, count: 0 };
  }
}

module.exports = {
  writeAnnotation,
  removeAnnotation,
  writeManualAnnotations,
  removeManualAnnotations,
  NM_PREFIX,
  MANUAL_NM_PREFIX,
  MANUAL_COLORS
};
