/**
 * 手动注记管理器（渲染进程）。
 *
 * 职责：
 *  - 工具状态：当前注记类型、颜色、是否擦除模式
 *  - 增删改：从文本选区创建、编辑批注文本、改颜色、删除
 *  - 持久化：本地 JSON（经 preload -> 主进程），以及按需写回 PDF
 *  - 渲染：把数据交给 viewer，由它与 AI 注记一起画到 .annot-layer
 *
 * 本地存储与 PDF 写回是分开的两条路径：
 * 日常阅读只写本地 JSON（快、无卡顿、不占文件），
 * 用户点"写回 PDF"时才修改 PDF 原文件（慢、需备份、可能被占用）。
 */
import { $ } from './utils.js';

export const ANNOT_TYPES = [
  { id: 'highlight', name: '高亮', hint: '多颜色高亮笔刷' },
  { id: 'underline', name: '下划线', hint: '下划线' },
  { id: 'strikeout', name: '删除线', hint: '删除线' },
  { id: 'note', name: '批注', hint: '高亮并附加批注文字' }
];

export const ANNOT_COLORS = [
  { id: 'yellow', name: '黄' },
  { id: 'green', name: '绿' },
  { id: 'blue', name: '蓝' },
  { id: 'pink', name: '粉' },
  { id: 'purple', name: '紫' },
  { id: 'orange', name: '橙' }
];

function newId() {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export class ManualAnnotManager {
  constructor({ viewer, onChanged, onBusy, onBusyDone }) {
    this.viewer = viewer;
    this.onChanged = onChanged || (() => {});
    this.onBusy = onBusy || (() => {});
    this.onBusyDone = onBusyDone || (() => {});

    this.hash = null;
    this.filePath = null;
    this.items = [];

    this.tool = 'highlight';
    this.color = 'yellow';
    this.eraserMode = false;
    this.selectedId = null;

    this.viewer.onManualAnnotClick = (id, evt) => this.handleMarkClick(id, evt);
  }

  // ------------------------------------------------------------ 文档切换
  async setDocument(hash, filePath) {
    this.hash = hash || null;
    this.filePath = filePath || null;
    this.selectedId = null;
    this.items = [];
    if (this.hash) {
      try {
        this.items = (await window.api.listManualAnnots(this.hash)) || [];
      } catch (e) {
        console.warn('[manual-annot] load failed', e);
        this.items = [];
      }
    }
    this.render();
  }

  // ------------------------------------------------------------ 持久化
  async persist() {
    if (!this.hash) return;
    try {
      await window.api.saveManualAnnots(this.hash, this.items);
    } catch (e) {
      console.warn('[manual-annot] save failed', e);
    }
    this.onChanged();
  }

  // ------------------------------------------------------------ 工具状态
  setTool(tool) {
    if (!ANNOT_TYPES.some((t) => t.id === tool)) return;
    this.tool = tool;
    this.eraserMode = false;
    this.syncToolbar();
  }

  setColor(color) {
    this.color = color;
    // 改颜色时若已有选中注记，直接应用到它身上
    if (this.selectedId) this.update(this.selectedId, { color });
    this.syncToolbar();
  }

  toggleEraser() {
    this.eraserMode = !this.eraserMode;
    if (this.eraserMode) this.select(null);
    this.syncToolbar();
  }

  // ------------------------------------------------------------ 增删改
  /**
   * 从当前文本选区创建一条注记。
   * @param {object} sel selection.js 产出的 {page, quote, rects, lineStart, lineEnd}
   */
  async createFromSelection(sel) {
    if (!this.hash) return null;
    if (!sel || !sel.rects || !sel.rects.length) return null;

    const now = new Date().toISOString();
    const item = {
      id: newId(),
      type: this.tool,
      color: this.color,
      page: Number(sel.page),
      rects: sel.rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      quote: String(sel.quote || '').slice(0, 500),
      note: '',
      createdAt: now,
      updatedAt: now
    };
    this.items.push(item);
    await this.persist();
    this.render([item.page]);

    // 批注类型创建后直接进入编辑，省一次点击
    if (item.type === 'note') this.select(item.id, { edit: true });
    else this.select(item.id);
    return item;
  }

  update(id, patch) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    Object.assign(it, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    this.render([it.page]);
  }

  async remove(id) {
    const it = this.items.find((x) => x.id === id);
    if (!it) return;
    const page = it.page;
    this.items = this.items.filter((x) => x.id !== id);
    if (this.selectedId === id) this.select(null);
    await this.persist();
    this.render([page]);
  }

  select(id, { edit = false } = {}) {
    this.selectedId = id || null;
    this.render();
    if (id && edit) this.openEditor(id);
    else this.closeEditor();
  }

  // ------------------------------------------------------------ 交互
  handleMarkClick(id, evt) {
    if (this.eraserMode) {
      this.remove(id);
      return;
    }
    // 点击已选中的注记 -> 打开编辑气泡
    if (this.selectedId === id) {
      this.openEditor(id, evt);
      return;
    }
    this.select(id);
  }

  getSelected() {
    return this.items.find((x) => x.id === this.selectedId) || null;
  }

  // ------------------------------------------------------------ 编辑气泡
  openEditor(id, evt) {
    const item = this.items.find((x) => x.id === id);
    if (!item) return;
    const box = $('#maEditor');
    if (!box) return;

    box.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'ma-editor-head';
    const typeName = (ANNOT_TYPES.find((t) => t.id === item.type) || {}).name || item.type;
    head.textContent = `编辑${typeName}`;

    // 颜色行
    const colors = document.createElement('div');
    colors.className = 'ma-editor-colors';
    for (const c of ANNOT_COLORS) {
      const b = document.createElement('button');
      b.className = `ma-swatch ma-swatch-${c.id}${item.color === c.id ? ' on' : ''}`;
      b.title = c.name;
      b.addEventListener('click', () => {
        this.update(item.id, { color: c.id });
        this.openEditor(item.id);
      });
      colors.appendChild(b);
    }

    // 批注输入
    const ta = document.createElement('textarea');
    ta.className = 'ma-editor-note';
    ta.placeholder = '写下你的批注…';
    ta.value = item.note || '';
    ta.addEventListener('change', () => this.update(item.id, { note: ta.value }));
    ta.addEventListener('blur', () => {
      if (ta.value !== (item.note || '')) this.update(item.id, { note: ta.value });
    });

    // 原文
    const quote = document.createElement('div');
    quote.className = 'ma-editor-quote';
    quote.textContent = item.quote || '（无原文）';

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'ma-editor-actions';

    const del = document.createElement('button');
    del.className = 'ma-btn danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      this.remove(item.id);
      this.closeEditor();
    });

    const close = document.createElement('button');
    close.className = 'ma-btn';
    close.textContent = '完成';
    close.addEventListener('click', () => this.closeEditor());

    actions.appendChild(del);
    actions.appendChild(close);

    box.appendChild(head);
    box.appendChild(colors);
    box.appendChild(ta);
    box.appendChild(quote);
    box.appendChild(actions);

    // 定位：优先跟随点击位置，其次跟随注记 DOM
    const wrap = this.viewer.pageWraps[item.page - 1];
    const mark = wrap && wrap.querySelector(`[data-ma-id="${item.id}"]`);
    const host = $('#maEditorHost') || document.body;
    const hostRect = host.getBoundingClientRect();

    let left;
    let top;
    if (evt && evt.clientX) {
      left = evt.clientX - hostRect.left;
      top = evt.clientY - hostRect.top + 12;
    } else if (mark) {
      const r = mark.getBoundingClientRect();
      left = r.left - hostRect.left;
      top = r.bottom - hostRect.top + 8;
    } else {
      left = 120;
      top = 120;
    }

    const bw = 260;
    left = Math.max(8, Math.min(left, hostRect.width - bw - 8));
    top = Math.max(8, Math.min(top, hostRect.height - 230));

    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.classList.remove('hidden');
    setTimeout(() => ta.focus(), 0);
  }

  closeEditor() {
    const box = $('#maEditor');
    if (box) box.classList.add('hidden');
  }

  // ------------------------------------------------------------ 写回 PDF
  /**
   * 把本地注记写回 PDF 原文件。
   * @param {string[]|null} ids 指定要写回的注记；null 表示全部
   */
  async writeToPdf(ids = null) {
    if (!this.filePath) return { ok: false, error: '尚未打开 PDF' };
    const targets = ids
      ? this.items.filter((x) => ids.includes(x.id))
      : this.items.filter((x) => x.type !== 'note' || x.note);
    if (!targets.length) return { ok: false, error: '没有可写回的注记' };

    // CSS 坐标 -> PDF 用户空间坐标（与 AI 注记共用同一套换算）
    const payload = [];
    for (const it of targets) {
      const geom = await this.viewer.cssRectsToAnnotGeom(it.page, it.rects);
      if (!geom) continue;
      payload.push({
        id: it.id,
        type: it.type,
        color: it.color,
        page: it.page,
        rect: geom.rect,
        quadPoints: geom.quadPoints,
        quote: it.quote,
        note: it.note
      });
    }
    if (!payload.length) return { ok: false, error: '没有有效的注记位置' };

    this.onBusy(`正在写回 ${payload.length} 条注记…`);
    try {
      const res = await window.api.writeManualAnnotsToPdf({
        filePath: this.filePath,
        items: payload
      });
      return res;
    } finally {
      this.onBusyDone();
    }
  }

  // ------------------------------------------------------------ 渲染
  render(pages = null) {
    this.viewer.setManualAnnotations(this.items, this.selectedId, pages);
  }

  /** 同步工具栏按钮的激活态 */
  syncToolbar() {
    for (const t of ANNOT_TYPES) {
      const el = $(`#maTool-${t.id}`);
      if (el) el.classList.toggle('on', !this.eraserMode && this.tool === t.id);
    }
    const er = $('#maToolEraser');
    if (er) er.classList.toggle('on', this.eraserMode);

    for (const c of ANNOT_COLORS) {
      const el = $(`#maColor-${c.id}`);
      if (el) el.classList.toggle('on', this.color === c.id);
    }
  }
}
