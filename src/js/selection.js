/**
 * 文本选区 / 区域截图
 *
 * 两者共用同一套「屏幕矩形 → 页码 / 行号 / 原文 / PDF 坐标」解析，
 * 因此扫描件（无文本层）走截图、可选文字的文本走选区，后续处理完全一致。
 */
import { $, clamp, toast } from './utils.js';

function intersects(a, b, tol = 1) {
  return !(
    a.x + a.w < b.x - tol ||
    b.x + b.w < a.x - tol ||
    a.y + a.h < b.y - tol ||
    b.y + b.h < a.y - tol
  );
}

function unionRect(rects) {
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export class SelectionManager {
  constructor({ viewer, scrollEl, popupEl, onDiscuss, onDiscussWeb }) {
    this.viewer = viewer;
    this.scrollEl = scrollEl;
    this.popup = popupEl;
    this.onDiscuss = onDiscuss || (() => {});
    this.onDiscussWeb = onDiscussWeb || (() => {});

    this.current = null; // {page, lineStart, lineEnd, quote, rects, screenRects}
    this.capturing = false;
    this._capture = null;

    this._bindPopup();
    this._bindSelection();
    this._bindCapture();
  }

  // ------------------------------------------------------------ 工具条
  _bindPopup() {
    // 阻止按下时清除选区
    this.popup.addEventListener('mousedown', (e) => e.preventDefault());
    $('#spDiscuss').addEventListener('click', () => this._fire('context'));
    $('#spDiscussWeb').addEventListener('click', () => this._fire('web'));
    $('#spCopy').addEventListener('click', async () => {
      if (!this.current) return;
      const { copyText } = await import('./utils.js');
      const ok = await copyText(this.current.quote);
      toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'ok' : 'err', 1600);
      this.hidePopup();
    });
  }

  _fire(mode) {
    const sel = this.current;
    if (!sel) return;
    this.hidePopup();
    if (mode === 'web') this.onDiscussWeb(sel);
    else this.onDiscuss(sel);
  }

  _bindSelection() {
    const onUp = (e) => {
      if (this.capturing) return;
      if (this.popup.contains(e.target)) return;
      setTimeout(() => this._readSelection(), 12);
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Escape') this.hidePopup();
    });
    this.scrollEl.addEventListener('scroll', () => this.hidePopup(), { passive: true });
  }

  hidePopup() {
    this.popup.classList.add('hidden');
  }

  _readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hidePopup();
      return;
    }
    const range = sel.getRangeAt(0);
    const wrap = this._pageWrapOf(range.commonAncestorContainer);
    if (!wrap) {
      this.hidePopup();
      return;
    }
    const pageNum = Number(wrap.dataset.page);
    const wrapRect = wrap.getBoundingClientRect();
    const scale = this.viewer.scale;

    const screenRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 0.6 && r.height > 0.6
    );
    if (!screenRects.length) {
      this.hidePopup();
      return;
    }

    // 只保留落在当前页面范围内的矩形
    const cssRects = [];
    for (const r of screenRects) {
      const x = (r.left - wrapRect.left) / scale;
      const y = (r.top - wrapRect.top) / scale;
      if (x < -20 || y < -20) continue;
      cssRects.push({ x, y, w: r.width / scale, h: r.height / scale });
    }
    if (!cssRects.length) {
      this.hidePopup();
      return;
    }

    const parsed = this.resolveRects(pageNum, cssRects);
    const text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      this.hidePopup();
      return;
    }

    this.current = { ...parsed, quote: text || parsed.quote, screenRects };
    this._showPopup(screenRects[screenRects.length - 1]);
  }

  /**
   * 把页面内 CSS 矩形解析成 {page, lineStart, lineEnd, quote, rects}
   * 截图与文本选区共用。
   */
  resolveRects(pageNum, cssRects) {
    const lines = this.viewer.getPageLines(pageNum);
    const union = unionRect(cssRects);

    let lineStart = null;
    let lineEnd = null;
    const hitTexts = [];

    for (const ln of lines) {
      // 行矩形与选区有交集即视为命中
      const hit = cssRects.some((r) => intersects(ln.rect, r, Math.max(1.5, ln.rect.h * 0.25)));
      if (hit) {
        if (lineStart === null) lineStart = ln.no;
        lineEnd = ln.no;
        hitTexts.push(ln.text);
      }
    }

    // 文本层尚未抽取完成时，退化为整页顺序号缺失
    return {
      page: pageNum,
      lineStart: lineStart ?? null,
      lineEnd: lineEnd ?? null,
      quote: hitTexts.join(' ').trim(),
      rects: cssRects.map((r) => ({
        x: Number(r.x.toFixed(2)),
        y: Number(r.y.toFixed(2)),
        w: Number(r.w.toFixed(2)),
        h: Number(r.h.toFixed(2))
      })),
      union: unionRect(cssRects)
    };
  }

  _pageWrapOf(node) {
    let n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== document.body) {
      if (n.classList && n.classList.contains('page-wrap')) return n;
      n = n.parentNode;
    }
    return null;
  }

  _showPopup(rect) {
    const p = this.popup;
    p.classList.remove('hidden');
    // 先显示再量尺寸
    const w = p.offsetWidth;
    const h = p.offsetHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8) top = rect.top - h - 8;
    left = clamp(left, 8, window.innerWidth - w - 8);
    p.style.left = `${left}px`;
    p.style.top = `${Math.max(8, top)}px`;
  }

  // ------------------------------------------------------------ 区域截图
  _bindCapture() {
    const overlay = $('#captureOverlay');
    const rectEl = $('#captureRect');

    const onDown = (e) => {
      if (e.button !== 0) return;
      this._capture = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
      rectEl.classList.remove('hidden');
      this._updateRectEl(rectEl);
    };
    const onMove = (e) => {
      if (!this._capture) return;
      this._capture.x1 = e.clientX;
      this._capture.y1 = e.clientY;
      this._updateRectEl(rectEl);
    };
    const onUp = async () => {
      if (!this._capture) return;
      const c = this._capture;
      this._capture = null;
      const w = Math.abs(c.x1 - c.x0);
      const h = Math.abs(c.y1 - c.y0);
      this.stopCapture();
      if (w < 12 || h < 12) {
        toast('框选区域太小，请重新框选', 'warn', 1800);
        return;
      }
      await this._doCapture(
        Math.min(c.x0, c.x1),
        Math.min(c.y0, c.y1),
        w,
        h
      );
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        this._capture = null;
        rectEl.classList.add('hidden');
        this.stopCapture();
      }
    };

    overlay.addEventListener('mousedown', onDown);
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp);
    document.addEventListener('keydown', (e) => {
      if (this.capturing) onKey(e);
    });
  }

  _updateRectEl(rectEl) {
    const c = this._capture;
    if (!c) return;
    const x = Math.min(c.x0, c.x1);
    const y = Math.min(c.y0, c.y1);
    rectEl.style.left = `${x}px`;
    rectEl.style.top = `${y}px`;
    rectEl.style.width = `${Math.abs(c.x1 - c.x0)}px`;
    rectEl.style.height = `${Math.abs(c.y1 - c.y0)}px`;
  }

  startCapture() {
    this.capturing = true;
    $('#captureOverlay').classList.remove('hidden');
  }

  stopCapture() {
    this.capturing = false;
    $('#captureOverlay').classList.add('hidden');
    $('#captureRect').classList.add('hidden');
  }

  /**
   * 截取屏幕区域，并解析出它在 PDF 中的位置与可提取文本。
   * @returns {Promise<{image:string, parsed:object|null, hasText:boolean}>}
   */
  async _doCapture(x, y, w, h) {
    const viewer = this.viewer;
    const scrollRect = this.scrollEl.getBoundingClientRect();

    // 找到框选区域中心所在的页面
    const cx = x + w / 2;
    const cy = y + h / 2;
    let targetWrap = null;
    for (const wrap of viewer.pageWraps) {
      const r = wrap.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        targetWrap = wrap;
        break;
      }
    }
    if (!targetWrap) {
      toast('请把框选区域放在 PDF 页面内', 'warn');
      return;
    }

    const wrapRect = targetWrap.getBoundingClientRect();
    const scale = viewer.scale;
    const pageNum = Number(targetWrap.dataset.page);

    const cssRect = {
      x: clamp((x - wrapRect.left) / scale, 0, wrapRect.width / scale),
      y: clamp((y - wrapRect.top) / scale, 0, wrapRect.height / scale),
      w: w / scale,
      h: h / scale
    };
    const parsed = this.resolveRects(pageNum, [cssRect]);

    // 截图区域必须在可视范围内，否则裁掉
    const clip = {
      x: Math.max(Math.round(x), Math.round(scrollRect.left)),
      y: Math.max(Math.round(y), Math.round(scrollRect.top)),
      width: Math.round(w),
      height: Math.round(h)
    };
    if (clip.x + clip.width > Math.round(scrollRect.right)) {
      clip.width = Math.max(1, Math.round(scrollRect.right) - clip.x);
    }
    if (clip.y + clip.height > Math.round(scrollRect.bottom)) {
      clip.height = Math.max(1, Math.round(scrollRect.bottom) - clip.y);
    }
    if (clip.width < 8 || clip.height < 8) {
      toast('框选区域超出可视范围，请滚动到目标位置后重试', 'warn', 2600);
      return;
    }

    let image = '';
    try {
      image = await window.api.captureRegion(clip);
    } catch (e) {
      toast(`截图失败：${e.message || e}`, 'err', 3000);
      return;
    }
    if (!image) {
      toast('截图失败：未能捕获该区域（请确认它完全落在可视范围内）', 'err', 3200);
      return;
    }

    const hasText = !!parsed.quote;
    this.onCapture?.({ image, parsed, hasText, pageNum });
  }

  onCaptureReady(fn) {
    this.onCapture = fn;
  }

  clear() {
    this.current = null;
    this.hidePopup();
  }
}
