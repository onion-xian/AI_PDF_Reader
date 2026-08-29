/**
 * PDF 渲染引擎
 *
 *  - 虚拟化滚动渲染（只渲染视口附近的页，适合几百页的书籍）
 *  - 文本层（pdf.js TextLayer），供用户选中文字
 *  - 逐页抽取文本并聚类成行，得到「第 X 页 第 Y 行」的精确定位能力
 *  - CSS 坐标 <-> PDF 坐标互转，供注记写入使用
 *  - 讨论注记覆盖层：点击即可恢复该轮历史对话
 */
import * as pdfjsLib from 'app://local/vendor/pdfjs/pdf.mjs';
import { clamp, throttle } from './utils.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://local/vendor/pdfjs/pdf.worker.mjs';

const CMAP_URL = 'app://local/vendor/pdfjs/cmaps/';
const FONT_URL = 'app://local/vendor/pdfjs/standard_fonts/';

export class PdfViewer {
  constructor({ scrollEl, pagesEl, onPageChange, onAnnotClick, onTextProgress }) {
    this.scrollEl = scrollEl;
    this.pagesEl = pagesEl;
    this.onPageChange = onPageChange || (() => {});
    this.onAnnotClick = onAnnotClick || (() => {});
    this.onTextProgress = onTextProgress || (() => {});

    this.pdf = null;
    this.numPages = 0;
    this.scale = 1.25;
    this.currentPage = 1;
    this.pageWraps = [];
    this.pageLines = new Map(); // page -> { lines: [{no,text,rect}], text }
    this.renderTasks = new Map(); // page -> RenderTask
    this.rendered = new Set();
    this.annotations = [];      // AI 会话注记
    this.manualAnnots = [];      // 用户手动注记
    this.selectedManualId = null;
    this.onManualAnnotClick = null;
    this.outline = [];
    this.extracting = false;
    // 每次换文档递增，用于在 await 之后判断「这份文档还是不是当前那份」
    this._docToken = 0;
    this._pdfClosed = true;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    this._observer = null;
    this._onScroll = throttle(() => this._updateCurrentPage(), 90);
    scrollEl.addEventListener('scroll', this._onScroll, { passive: true });
  }

  // ------------------------------------------------------------ 加载
  async load(data) {
    const token = ++this._docToken;
    this.close({ keepToken: true });

    const loadingTask = pdfjsLib.getDocument({
      data,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      isEvalSupported: false,
      verbosity: 0
    });
    this.pdf = await loadingTask.promise;

    // 加载期间用户又打开了别的文档：这份直接丢弃，不要污染界面
    if (token !== this._docToken) {
      try {
        this.pdf.destroy();
      } catch {
        /* ignore */
      }
      this.pdf = null;
      return { numPages: 0, outline: [], title: '' };
    }

    this._pdfClosed = false;
    this.numPages = this.pdf.numPages;

    try {
      this.outline = (await this.pdf.getOutline()) || [];
    } catch {
      this.outline = [];
    }

    this._buildPlaceholders();
    this._observePages();
    this.currentPage = 1;
    this.onPageChange(1, this.numPages);

    return { numPages: this.numPages, outline: this.outline, title: this._guessTitle() };
  }

  _guessTitle() {
    try {
      const meta = this.pdf._pdfInfo?.metadata;
      if (meta && meta.get && meta.get('Title')) return meta.get('Title');
      if (meta && typeof meta === 'object' && meta.Title) return meta.Title;
    } catch {
      /* ignore */
    }
    return '';
  }

  _buildPlaceholders() {
    const frag = document.createDocumentFragment();
    this.pageWraps = [];
    for (let n = 1; n <= this.numPages; n++) {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.page = String(n);
      // 先给一个基于首页尺寸的占位，避免滚动条跳动
      wrap.style.width = '800px';
      wrap.style.height = '1100px';
      wrap.innerHTML = `<div class="page-loading">第 ${n} 页</div><div class="annot-layer"></div>`;
      this.pageWraps.push(wrap);
      frag.appendChild(wrap);
    }
    this.pagesEl.innerHTML = '';
    this.pagesEl.appendChild(frag);
  }

  _observePages() {
    if (this._observer) this._observer.disconnect();
    this._observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const n = Number(e.target.dataset.page);
            this.renderPage(n);
          }
        }
      },
      { root: this.scrollEl, rootMargin: '700px 0px' }
    );
    for (const w of this.pageWraps) this._observer.observe(w);
  }

  /** 用首页尺寸把所有占位页尺寸对齐，减少滚动跳动 */
  async _syncPlaceholderSizes() {
    if (!this.pdf || this.numPages === 0) return;
    const first = await this.pdf.getPage(1);
    const v = first.getViewport({ scale: this.scale });
    const ratio = v.height / v.width;
    const w = 800 * (this.scale / 1.25);
    for (const wrap of this.pageWraps) {
      if (this.rendered.has(Number(wrap.dataset.page))) continue;
      wrap.style.width = `${Math.floor(w)}px`;
      wrap.style.height = `${Math.floor(w * ratio)}px`;
    }
  }

  // ------------------------------------------------------------ 渲染
  async renderPage(n) {
    if (!this.pdf || n < 1 || n > this.numPages) return;
    if (this.renderTasks.has(n)) return;

    const wrap = this.pageWraps[n - 1];
    if (!wrap) return;

    const renderId = ++this._renderToken || (this._renderToken = 1);
    const page = await this.pdf.getPage(n);
    if (this._pdfClosed) return;

    const viewport = page.getViewport({ scale: this.scale });
    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);
    wrap.style.width = `${cssW}px`;
    wrap.style.height = `${cssH}px`;

    const loading = wrap.querySelector('.page-loading');
    if (loading) loading.textContent = `第 ${n} 页`;

    let canvas = wrap.querySelector('canvas.page-canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      wrap.insertBefore(canvas, wrap.firstChild);
    }
    canvas.width = Math.floor(cssW * this.dpr);
    canvas.height = Math.floor(cssH * this.dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(this.dpr, this.dpr);

    // 页码角标
    let tag = wrap.querySelector('.page-num-tag');
    if (!tag) {
      tag = document.createElement('div');
      tag.className = 'page-num-tag';
      tag.textContent = String(n);
      wrap.appendChild(tag);
    }

    const task = page.render({ canvasContext: ctx, viewport });
    this.renderTasks.set(n, task);

    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') {
        this.renderTasks.delete(n);
        return;
      }
      console.error('[viewer] render page', n, e);
    }
    this.renderTasks.delete(n);
    if (renderId !== this._renderToken) return;

    if (loading) loading.remove();
    this.rendered.add(n);

    // 文本层
    try {
      await this._renderTextLayer(wrap, page, viewport, n);
    } catch (e) {
      console.warn('[viewer] text layer failed on page', n, e);
    }

    // 该页渲染完成后补画注记（AI 注记与手动注记一起）
    this._paintAllAnnotations([n]);
  }

  async _renderTextLayer(wrap, page, viewport, n) {
    if (wrap.querySelector('.textLayer')) return;
    if (typeof pdfjsLib.TextLayer !== 'function') return;

    const textContent = await page.getTextContent();
    if (this._pdfClosed) return;

    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.style.setProperty('--scale-factor', String(this.scale));
    wrap.appendChild(layer);

    const tl = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: layer,
      viewport
    });
    await tl.render();
  }

  // ------------------------------------------------------------ 文本抽取
  /**
   * 抽取一页并按视觉顺序聚类成行。
   * @returns {{lines: Array<{no:number,text:string,rect:{x,y,w,h}}>, text:string}}
   */
  async extractPageLines(n) {
    if (this.pageLines.has(n)) return this.pageLines.get(n);
    if (!this.pdf || n < 1 || n > this.numPages) return { lines: [], text: '' };

    const page = await this.pdf.getPage(n);
    const tc = await page.getTextContent();
    // textContent 的 transform 处在 PDF 用户空间（左下原点、y 轴向上），
    // 而选区矩形是 CSS 空间（左上原点、y 轴向下）。行矩形必须统一到 CSS 空间，
    // 否则「矩形 → 行号」的匹配会整体上下颠倒。
    const vp = page.getViewport({ scale: 1 });
    const [m0, m1, m2, m3, m4, m5] = vp.transform;
    const toCss = (x, y) => [m0 * x + m2 * y + m4, m1 * x + m3 * y + m5];

    const items = [];
    for (const it of tc.items) {
      if (!it.str || it.str === ' ') continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      items.push({ x, y, h, w: it.width, str: it.str, eol: !!it.hasEOL });
    }
    // 从上到下、从左到右
    items.sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x));

    const rawLines = [];
    for (const it of items) {
      let target = null;
      for (const ln of rawLines) {
        if (Math.abs(ln.y - it.y) <= Math.max(2, it.h * 0.45)) {
          target = ln;
          break;
        }
      }
      if (!target) {
        target = { y: it.y, h: it.h, items: [] };
        rawLines.push(target);
      }
      target.items.push(it);
      target.h = Math.max(target.h, it.h);
    }
    rawLines.sort((a, b) => b.y - a.y);

    const lines = [];
    let no = 0;
    for (const ln of rawLines) {
      ln.items.sort((a, b) => a.x - b.x);
      let text = '';
      let prevRight = null;
      for (const it of ln.items) {
        // 两个 item 间距超过一个字符宽度时补空格，避免英文单词粘连
        if (prevRight !== null && it.x - prevRight > Math.max(1.2, it.h * 0.16)) text += ' ';
        text += it.str;
        prevRight = it.x + (it.w || 0);
        if (it.eol) text += '\n';
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const first = ln.items[0];
      const last = ln.items[ln.items.length - 1];
      // 行盒：左端到右端、基线到行顶（均在 PDF 空间），再整体换算到 CSS 空间
      const px1 = first.x;
      const px2 = last.x + (last.w || 0);
      const pyBottom = ln.y - ln.h * 0.18; // 略低于基线，容纳下伸部分
      const pyTop = ln.y + ln.h * 0.82;
      const [cx1, cy1] = toCss(px1, pyTop);
      const [cx2, cy2] = toCss(px2, pyBottom);
      const rect = {
        x: Math.min(cx1, cx2),
        y: Math.min(cy1, cy2),
        w: Math.max(Math.abs(cx2 - cx1), 1),
        h: Math.max(Math.abs(cy2 - cy1), 3)
      };
      no += 1;
      lines.push({ no, text, rect });
    }

    const result = { lines, text: lines.map((l) => l.text).join('\n') };
    this.pageLines.set(n, result);
    return result;
  }

  /** 后台逐页抽取全文，带进度回调 */
  async extractAll(onDone) {
    if (!this.pdf || this.extracting) return;
    const token = this._docToken;
    this.extracting = true;
    let done = 0;
    for (let n = 1; n <= this.numPages; n++) {
      // 中途换了文档就停手，别把旧文档的页写进新文档的缓存
      if (this._pdfClosed || token !== this._docToken) break;
      if (!this.pageLines.has(n)) {
        try {
          await this.extractPageLines(n);
        } catch (e) {
          console.warn('[viewer] extract page', n, e);
        }
      }
      done = n;
      this.onTextProgress(done, this.numPages);
      // 让出主线程，避免卡 UI
      await new Promise((r) => setTimeout(r, 0));
    }
    this.extracting = false;
    onDone?.(done);
  }

  getPageText(n) {
    return this.pageLines.get(n)?.text || '';
  }

  getPageLines(n) {
    return this.pageLines.get(n)?.lines || [];
  }

  isFullyExtracted() {
    return this.pageLines.size >= this.numPages && this.numPages > 0;
  }

  // ------------------------------------------------------------ 坐标转换
  /** CSS 坐标（scale=1，左上原点）转 PDF 坐标（左下原点） */
  async cssToPdf(n, x, y) {
    const page = await this.pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    return viewport.convertToPdfPoint(x, y);
  }

  /**
   * 把若干个 CSS 矩形（scale=1）转成 PDF 注记所需的矩形与 QuadPoints
   * @returns {{rect:number[], quadPoints:number[]}}
   */
  async cssRectsToAnnotGeom(n, rects) {
    const pdfRects = [];
    for (const r of rects) {
      const [x1, y1] = await this.cssToPdf(n, r.x, r.y);
      const [x2, y2] = await this.cssToPdf(n, r.x + r.w, r.y + r.h);
      pdfRects.push([x1, y1, x2, y2]);
    }
    if (!pdfRects.length) return null;

    const xs = pdfRects.flatMap((r) => [r[0], r[2]]);
    const ys = pdfRects.flatMap((r) => [r[1], r[3]]);
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    const quadPoints = [];
    for (const [x1, y1, x2, y2] of pdfRects) {
      const lx = Math.min(x1, x2);
      const rx = Math.max(x1, x2);
      const by = Math.min(y1, y2);
      const ty = Math.max(y1, y2);
      // 左下 → 右下 → 左上 → 右上
      quadPoints.push(lx, by, rx, by, lx, ty, rx, ty);
    }
    return { rect, quadPoints };
  }

  // ------------------------------------------------------------ 视图控制
  async setScale(next) {
    const s = clamp(next, 0.3, 4);
    if (Math.abs(s - this.scale) < 0.001) return;
    this.scale = s;

    // 作废进行中的渲染（递增 token 让它们的后续步骤自行退出）
    this._renderToken = (this._renderToken || 0) + 1;
    for (const [, task] of this.renderTasks) {
      try {
        task.cancel();
      } catch {
        /* ignore */
      }
    }
    this.renderTasks.clear();
    this.rendered.clear();
    for (const wrap of this.pageWraps) {
      const tl = wrap.querySelector('.textLayer');
      if (tl) tl.remove();
      const canvas = wrap.querySelector('canvas.page-canvas');
      if (canvas) canvas.remove();
      if (!wrap.querySelector('.page-loading')) {
        const ld = document.createElement('div');
        ld.className = 'page-loading';
        ld.textContent = `第 ${wrap.dataset.page} 页`;
        wrap.appendChild(ld);
      }
    }
    await this._syncPlaceholderSizes();
    // 重新渲染视口内页面
    for (const wrap of this.pageWraps) {
      const r = wrap.getBoundingClientRect();
      const sr = this.scrollEl.getBoundingClientRect();
      if (r.bottom > sr.top - 400 && r.top < sr.bottom + 400) {
        this.renderPage(Number(wrap.dataset.page));
      }
    }
    this._paintAllAnnotations();
    this._updateCurrentPage();
  }

  /**
   * 抓取当前视图状态（页码 / 缩放 / 滚动位置）。
   * 用于注记写入等场景：刷新注记层前后各调一次，避免视图跳动。
   */
  captureViewState() {
    return {
      page: this.currentPage,
      scale: this.scale,
      scrollTop: this.scrollEl ? this.scrollEl.scrollTop : 0
    };
  }

  /**
   * 恢复视图状态。仅在确有偏差时才动，避免无谓的重渲染。
   */
  restoreViewState(st) {
    if (!st) return;
    if (this.scrollEl && Math.abs(this.scrollEl.scrollTop - st.scrollTop) > 0.5) {
      this.scrollEl.scrollTop = st.scrollTop;
    }
    if (st.scale && Math.abs(st.scale - this.scale) >= 0.001) {
      // 缩放确实变了才走 setScale（它会重建 canvas，代价高）
      return this.setScale(st.scale);
    }
    return undefined;
  }

  fitWidth() {
    if (!this.pdf) return;
    const avail = this.scrollEl.clientWidth - 56;
    const probe = this.pageWraps[0];
    // 用页面原始宽度（PDF 单位）算比例
    this.pdf.getPage(1).then((page) => {
      const base = page.getViewport({ scale: 1 }).width;
      this.setScale(avail / base);
    });
  }

  async goToPage(n, opts = {}) {
    const target = clamp(Math.round(n), 1, this.numPages || 1);
    const wrap = this.pageWraps[target - 1];
    if (!wrap) return;
    await this.renderPage(target);
    const top = wrap.offsetTop - (opts.offset ?? 12);
    this.scrollEl.scrollTo({ top, behavior: opts.smooth === false ? 'auto' : 'smooth' });
    this.currentPage = target;
    this.onPageChange(target, this.numPages);
  }

  /** 滚动到指定页的某个矩形（PDF 坐标转回 CSS 后定位） */
  async scrollToRect(n, cssRect) {
    await this.goToPage(n, { offset: 80 });
    if (cssRect) {
      const wrap = this.pageWraps[n - 1];
      const top = wrap.offsetTop + cssRect.y * this.scale - 120;
      this.scrollEl.scrollTo({ top, behavior: 'smooth' });
    }
  }

  _updateCurrentPage() {
    if (!this.pageWraps.length) return;
    const st = this.scrollEl.scrollTop;
    const mid = st + this.scrollEl.clientHeight * 0.32;
    let found = 1;
    for (let i = 0; i < this.pageWraps.length; i++) {
      const w = this.pageWraps[i];
      if (w.offsetTop + w.offsetHeight > mid) {
        found = i + 1;
        break;
      }
      found = i + 1;
    }
    if (found !== this.currentPage) {
      this.currentPage = found;
      this.onPageChange(found, this.numPages);
    }
  }

  // ------------------------------------------------------------ 注记覆盖层
  /**
   * @param {Array} conversations 含 anchor.rects（CSS scale=1）与 anchor.page
   */
  setAnnotations(conversations, activeId = null, pages = null) {
    this.annotations = conversations || [];
    this.activeConvId = activeId;
    this._paintAllAnnotations(pages);
  }

  /** 手动注记；与 AI 注记共用同一个 .annot-layer，因此走统一重绘入口 */
  setManualAnnotations(items, selectedId = null, pages = null) {
    this.manualAnnots = items || [];
    this.selectedManualId = selectedId;
    this._paintAllAnnotations(pages);
  }

  /**
   * 统一重绘入口：AI 会话注记 + 手动注记一起画。
   * 两者共用 DOM 图层，分开画会互相清空，所以必须在同一次清空之后绘制。
   *
   * @param {number[]|null} pages 只重绘这些页；为 null 时全量重绘。
   *   增量场景下只传受影响的页码，避免大文档逐页清空 DOM。
   */
  _paintAllAnnotations(pages = null) {
    const only = pages && pages.length ? new Set(pages.map(Number)) : null;

    // 先清空目标页（即便该页已无注记，也要清掉残留）
    for (const wrap of this.pageWraps) {
      const n = Number(wrap.dataset.page);
      if (only && !only.has(n)) continue;
      const layer = wrap.querySelector('.annot-layer');
      if (layer) layer.innerHTML = '';
    }

    this._paintConversationAnnotations(only);
    this._paintManualAnnotations(only);
  }

  _paintConversationAnnotations(only) {
    const byPage = new Map();
    for (const c of this.annotations || []) {
      const a = c.anchor;
      if (!a || a.page == null || !Array.isArray(a.rects) || !a.rects.length) continue;
      if (only && !only.has(Number(a.page))) continue;
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(c);
    }
    for (const [page, list] of byPage) this._paintAnnotationsForPage(page, list);
  }

  _paintManualAnnotations(only) {
    const byPage = new Map();
    for (const it of this.manualAnnots || []) {
      if (!it || it.page == null || !Array.isArray(it.rects) || !it.rects.length) continue;
      if (only && !only.has(Number(it.page))) continue;
      if (!byPage.has(it.page)) byPage.set(it.page, []);
      byPage.get(it.page).push(it);
    }
    for (const [page, list] of byPage) this._paintManualForPage(page, list);
  }

  /** 绘制单条手动注记的所有矩形 */
  _paintManualForPage(page, list) {
    const wrap = this.pageWraps[page - 1];
    if (!wrap) return;
    const layer = wrap.querySelector('.annot-layer');
    if (!layer) return;

    for (const it of list) {
      for (const r of it.rects) {
        const el = document.createElement('div');
        el.className =
          'ma-mark' +
          ` ma-${it.type}` +
          ` ma-c-${it.color}` +
          (it.id === this.selectedManualId ? ' ma-selected' : '');
        el.style.left = `${r.x * this.scale}px`;
        el.style.top = `${r.y * this.scale}px`;
        el.style.width = `${Math.max(r.w * this.scale, 3)}px`;
        el.style.height = `${Math.max(r.h * this.scale, 3)}px`;
        el.dataset.maId = it.id;

        const tip = [it.type === 'note' ? '批注' : '', it.note, it.quote]
          .filter(Boolean)
          .join(' · ');
        if (tip) el.title = tip.slice(0, 200);

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.onManualAnnotClick?.(it.id, e);
        });
        layer.appendChild(el);
      }
    }
  }

  _paintAnnotationsForPage(page, list) {
    const wrap = this.pageWraps[page - 1];
    if (!wrap) return;
    const layer = wrap.querySelector('.annot-layer');
    if (!layer) return;
    layer.innerHTML = '';

    const items = list || this.annotations.filter((c) => c.anchor?.page === page);
    for (const c of items) {
      const rects = c.anchor.rects || [];
      for (const r of rects) {
        const mark = document.createElement('div');
        // 已写回 PDF 的用琥珀色实线；只存在本机笔记里的用蓝色虚线
        mark.className =
          'annot-mark' +
          (c.id === this.activeConvId ? ' active' : '') +
          (c.annotated ? '' : ' pending');
        mark.title = c.annotated
          ? '已写入 PDF 注记，点击恢复这轮对话'
          : '这轮讨论尚未写入 PDF 注记，点击恢复对话';
        mark.style.left = `${r.x * this.scale}px`;
        mark.style.top = `${r.y * this.scale}px`;
        mark.style.width = `${Math.max(r.w * this.scale, 3)}px`;
        mark.style.height = `${Math.max(r.h * this.scale, 3)}px`;
        mark.dataset.conv = c.id;

        if (c.annotNo) {
          const flag = document.createElement('span');
          flag.className = 'annot-flag';
          flag.textContent = `#${c.annotNo}`;
          mark.appendChild(flag);
        }

        mark.addEventListener('mouseenter', (e) => this._showAnnotTip(e, c));
        mark.addEventListener('mouseleave', () => this._hideAnnotTip());
        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this._hideAnnotTip();
          this.onAnnotClick(c.id);
        });
        layer.appendChild(mark);
      }
    }
  }

  _showAnnotTip(evt, conv) {
    this._hideAnnotTip();
    const firstQ = (conv.messages || []).find((m) => m.role === 'user')?.content || '';
    const concl = conv.conclusion || '';
    const tip = document.createElement('div');
    tip.className = 'annot-tip';
    tip.innerHTML =
      `<span class="at-time">${new Date(conv.createdAt).toLocaleString('zh-CN')} · ` +
      `第 ${conv.anchor?.page ?? '-'} 页 第 ${conv.anchor?.lineStart ?? '-'} 行</span>` +
      `<b>问：</b>${escapeTip(firstQ, 150)}` +
      (concl ? `<br/><b>结论：</b>${escapeTip(concl, 150)}` : '') +
      `<br/><span style="opacity:.7">点击恢复这轮对话</span>`;
    document.body.appendChild(tip);
    const pad = 12;
    let left = evt.clientX + pad;
    let top = evt.clientY + pad;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    if (left + w > window.innerWidth - 8) left = evt.clientX - w - pad;
    if (top + h > window.innerHeight - 8) top = evt.clientY - h - pad;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    this._tip = tip;
  }

  _hideAnnotTip() {
    if (this._tip) {
      this._tip.remove();
      this._tip = null;
    }
  }

  /** 在页面上临时高亮某段（用于「跳到引用位置」） */
  flashRects(pageNum, rects, ms = 2200) {
    const wrap = this.pageWraps[pageNum - 1];
    if (!wrap || !rects?.length) return;
    const layer = wrap.querySelector('.annot-layer');
    if (!layer) return;
    const nodes = rects.map((r) => {
      const d = document.createElement('div');
      d.className = 'annot-mark sel-highlight';
      d.style.left = `${r.x * this.scale}px`;
      d.style.top = `${r.y * this.scale}px`;
      d.style.width = `${Math.max(r.w * this.scale, 3)}px`;
      d.style.height = `${Math.max(r.h * this.scale, 3)}px`;
      d.style.pointerEvents = 'none';
      layer.appendChild(d);
      return d;
    });
    setTimeout(() => nodes.forEach((n) => n.remove()), ms);
  }

  // ------------------------------------------------------------ 生命周期
  getViewportForPage(n, scale = 1) {
    return this.pdf?.getPage(n).then((p) => p.getViewport({ scale }));
  }

  close(opts = {}) {
    if (!opts.keepToken) this._docToken++;
    this._pdfClosed = true;
    for (const [, task] of this.renderTasks) {
      try {
        task.cancel();
      } catch {
        /* ignore */
      }
    }
    this.renderTasks.clear();
    this.rendered.clear();
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this.pdf) {
      try {
        this.pdf.destroy();
      } catch {
        /* ignore */
      }
    }
    this._renderToken = (this._renderToken || 0) + 1;
    this.pdf = null;
    this.numPages = 0;
    this.pageWraps = [];
    this.pageLines.clear();
    this.annotations = [];
    this.outline = [];
    this.pagesEl.innerHTML = '';
  }
}

function escapeTip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const v = t.length > n ? `${t.slice(0, n)}…` : t;
  return v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
