/**
 * AI PDF Reader —— 应用入口
 *
 * 负责：窗口级交互、文档打开/切换、侧边栏四种视图、深链恢复、各模块协同。
 */
import { $, $$, el, toast, clamp, fmtTime, truncate, debounce } from './utils.js';
import { PdfViewer } from './viewer.js';
import { SelectionManager } from './selection.js';
import { ChatPanel } from './chat.js';
import { SettingsPanel, ScopePopover } from './settings.js';
import { ManualAnnotManager, ANNOT_TYPES, ANNOT_COLORS } from './manual-annot.js';

const THUMB_W = 124;

class App {
  constructor() {
    this.config = null;
    this.doc = null; // {hash, filePath, fileName, title, pageCount, ...}
    this.sidebarView = 'pages';
    this.thumbs = new Map();
    this._thumbObserver = null;
    this._reloading = false;
  }

  async init() {
    this.config = await window.api.getConfig();
    document.documentElement.dataset.theme = this.config.ui.theme || 'dark';

    this.viewer = new PdfViewer({
      scrollEl: $('#pagesScroll'),
      pagesEl: $('#pages'),
      onPageChange: (page, total) => this.onPageChange(page, total),
      onAnnotClick: (convId) => this.restoreConversation(convId),
      onTextProgress: (done, total) => this.onTextProgress(done, total)
    });

    this.chat = new ChatPanel({
      viewer: this.viewer,
      getConfig: () => this.config,
      onPersist: (hash, list) => this.persistConversations(hash, list),
      onStatus: (t) => {
        if (t) {
          $('#sbText').textContent = t;
        } else {
          // 状态清空时回落到文本抽取进度
          this.onTextProgress(this.viewer.pageLines.size, this.viewer.numPages);
        }
      },
      onJumpToAnchor: (anchor) => this.jumpToAnchor(anchor)
    });

    this.settings = new SettingsPanel({
      getConfig: () => this.config,
      onChange: (cfg) => this.onConfigChanged(cfg)
    });

    this.scopePop = new ScopePopover({
      getConfig: () => this.config,
      onChange: (cfg) => this.onConfigChanged(cfg),
      viewer: this.viewer
    });

    this.selection = new SelectionManager({
      viewer: this.viewer,
      scrollEl: $('#pagesScroll'),
      popupEl: $('#selPopup'),
      onDiscuss: (sel) => this.startDiscussion(sel, 'context'),
      onDiscussWeb: (sel) => this.startDiscussion(sel, 'web')
    });
    this.selection.onCaptureReady((payload) => this.onCaptured(payload));

    this.manualAnnot = new ManualAnnotManager({
      viewer: this.viewer,
      onChanged: () => this.updateStatus(),
      onBusy: (t) => this.showBusy(t),
      onBusyDone: () => this.hideBusy()
    });
    this.bindAnnotToolbar();

    this.bindTopbar();
    this.bindSidebar();
    this.bindSplitter();
    this.bindGlobal();
    this.bindIpc();

    this.setZoom(this.config.ui.zoom || 1.25);
    this.updateStatus();
    this.renderSidebar();

    // 首屏未配置 Key 时给个提示
    if (!this.config.ai.apiKey) {
      setTimeout(
        () => toast('首次使用请先配置 API Key（右上角齿轮 → AI 模型）', 'warn', 6000),
        900
      );
    }
  }

  // ================================================================ 顶栏
  bindTopbar() {
    $('#btnOpenFirst').addEventListener('click', () => this.openDialog());
    $('#btnPrevPage').addEventListener('click', () => this.viewer.goToPage(this.viewer.currentPage - 1));
    $('#btnNextPage').addEventListener('click', () => this.viewer.goToPage(this.viewer.currentPage + 1));
    $('#btnZoomIn').addEventListener('click', () => this.setZoom(this.viewer.scale * 1.2));
    $('#btnZoomOut').addEventListener('click', () => this.setZoom(this.viewer.scale / 1.2));
    $('#btnZoomLevel').addEventListener('click', () => this.setZoom(1.25));
    $('#btnFitWidth').addEventListener('click', () => this.viewer.fitWidth());
    $('#btnCapture').addEventListener('click', () => {
      if (!this.doc) return toast('请先打开 PDF 文档', 'warn');
      this.selection.startCapture();
    });
    $('#btnSettings').addEventListener('click', () => this.settings.open());
    $('#btnSettings2').addEventListener('click', () => this.settings.open());
    $('#btnOpenNote').addEventListener('click', async () => {
      if (!this.doc) return toast('请先打开 PDF 文档', 'warn');
      const p = await window.api.notePath(this.doc.hash);
      window.api.showInFolder(p);
    });
    $('#btnToggleTheme').addEventListener('click', () => this.toggleTheme());

    const pageInput = $('#pageInput');
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = Number(pageInput.value);
        if (Number.isFinite(n)) this.viewer.goToPage(n);
        pageInput.blur();
      }
    });
  }

  setZoom(scale) {
    this.viewer.setScale(scale);
    $('#btnZoomLevel').textContent = `${Math.round(scale * 100)}%`;
  }

  toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    window.api.setConfig({ ui: { theme: next } }).then((cfg) => (this.config = cfg));
  }

  onPageChange(page, total) {
    $('#pageInput').value = String(page);
    $('#pageTotal').textContent = `/ ${total}`;
    $('#sbPos').textContent = total ? `第 ${page} / ${total} 页` : '—';
    // 缩略图跟随
    if (this.sidebarView === 'pages') this._highlightThumb(page);
  }

  onTextProgress(done, total) {
    const node = $('#sbText');
    if (done >= total) {
      node.textContent = `文本提取完成（${total} 页）`;
      this.chat._updateCtxBar();
    } else {
      node.textContent = `正在提取正文 ${done}/${total} 页…`;
    }
  }

  updateStatus() {
    $('#sbFile').textContent = this.doc ? `${this.doc.fileName}` : '未打开文档';
    $('#sbModel').textContent = `模型：${this.config?.ai?.model || '未配置'}`;
    $('#sbNote').textContent = this.doc
      ? `笔记：${this.chat.conversations.length} 轮讨论`
      : '笔记：—';
  }

  // ================================================================ 侧边栏
  bindSidebar() {
    for (const btn of $$('.ab-btn[data-view]')) {
      btn.addEventListener('click', () => this.setSidebarView(btn.dataset.view));
    }
    $('#btnConvList').addEventListener('click', () => {
      const d = $('#convDrawer');
      const mask = $('#drawerMask');
      if (!d.classList.contains('hidden')) {
        d.classList.add('hidden');
        mask.classList.add('hidden');
        return;
      }
      this.renderConvDrawer();
      d.classList.remove('hidden');
      mask.classList.remove('hidden');
    });
    $('#convDrawerClose').addEventListener('click', () => {
      $('#convDrawer').classList.add('hidden');
      $('#drawerMask').classList.add('hidden');
    });
    $('#drawerMask').addEventListener('click', () => {
      $('#convDrawer').classList.add('hidden');
      $('#drawerMask').classList.add('hidden');
    });
  }

  setSidebarView(view) {
    this.sidebarView = view;
    for (const btn of $$('.ab-btn[data-view]')) {
      btn.classList.toggle('active', btn.dataset.view === view);
    }
    const titles = { pages: '页面', outline: '目录', discussions: '讨论记录', library: '文档库' };
    $('#sidebarTitle').textContent = titles[view] || '';
    this.renderSidebar();
  }

  renderSidebar() {
    const body = $('#sidebarBody');
    body.innerHTML = '';
    this._thumbObserver?.disconnect();

    if (!this.doc && this.sidebarView !== 'library') {
      body.appendChild(el('div', { class: 'side-empty', text: '尚未打开文档。按 Ctrl+O 打开 PDF 后，这里会显示页面、目录与讨论记录。' }));
      $('#sidebarCount').textContent = '';
      return;
    }

    switch (this.sidebarView) {
      case 'pages': this.renderThumbs(body); break;
      case 'outline': this.renderOutline(body); break;
      case 'discussions': this.renderDiscussions(body); break;
      case 'library': this.renderLibrary(body); break;
    }
  }

  async renderThumbs(body) {
    const total = this.viewer.numPages;
    $('#sidebarCount').textContent = total ? `${total} 页` : '';
    this._thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const n = Number(e.target.dataset.page);
            this._renderThumb(n);
          }
        }
      },
      { root: body, rootMargin: '300px 0px' }
    );

    for (let n = 1; n <= total; n++) {
      const canvas = document.createElement('canvas');
      canvas.className = 'thumb-canvas';
      canvas.width = THUMB_W;
      canvas.height = Math.round(THUMB_W * 1.414);
      const item = el('div', {
        class: 'thumb-item' + (n === this.viewer.currentPage ? ' active' : ''),
        'data-page': String(n),
        onclick: () => this.viewer.goToPage(n)
      }, [
        canvas,
        el('div', { class: 'thumb-meta' }, [
          el('div', { class: 'thumb-no', text: `第 ${n} 页` }),
          el('div', { class: 'thumb-badges' })
        ])
      ]);
      body.appendChild(item);
      this._thumbObserver.observe(item);
    }
    this._paintThumbBadges();
    this._highlightThumb(this.viewer.currentPage);
  }

  async _renderThumb(n) {
    if (this.thumbs.has(n) || !this.viewer.pdf) return;
    this.thumbs.set(n, true);
    const item = $(`#sidebarBody .thumb-item[data-page="${n}"]`);
    if (!item) return;
    const canvas = item.querySelector('canvas');
    try {
      const page = await this.viewer.pdf.getPage(n);
      const v0 = page.getViewport({ scale: 1 });
      const v = page.getViewport({ scale: THUMB_W / v0.width });
      canvas.width = Math.floor(v.width);
      canvas.height = Math.floor(v.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: v }).promise;
    } catch (e) {
      /* 渲染取消或页面销毁，忽略 */
    }
  }

  _paintThumbBadges() {
    if (!this.doc) return;
    const byPage = new Map();
    for (const c of this.chat.conversations) {
      const p = c.anchor?.page;
      if (p == null) continue;
      byPage.set(p, (byPage.get(p) || 0) + 1);
    }
    for (const [p, count] of byPage) {
      const holder = $(`#sidebarBody .thumb-item[data-page="${p}"] .thumb-badges`);
      if (holder) holder.appendChild(el('span', { class: 'thumb-badge', text: `${count} 讨论` }));
    }
  }

  _highlightThumb(page) {
    const cur = $('#sidebarBody .thumb-item.active');
    if (cur) cur.classList.remove('active');
    const next = $(`#sidebarBody .thumb-item[data-page="${page}"]`);
    if (next) {
      next.classList.add('active');
      const body = $('#sidebarBody');
      const top = next.offsetTop;
      const bottom = top + next.offsetHeight;
      if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) {
        body.scrollTop = top - body.clientHeight / 2 + next.offsetHeight / 2;
      }
    }
  }

  renderOutline(body) {
    const outline = this.viewer.outline || [];
    $('#sidebarCount').textContent = outline.length ? `${outline.length} 项` : '';
    if (!outline.length) {
      body.appendChild(el('div', { class: 'side-empty', text: '这个 PDF 没有内置目录（书签）。可以使用左侧「页面」视图浏览缩略图。' }));
      return;
    }
    const walk = (items, depth) => {
      for (const it of items) {
        body.appendChild(
          el('div', {
            class: 'outline-item',
            style: { paddingLeft: `${12 + depth * 12}px` },
            title: it.title,
            onclick: async () => {
              if (!it.dest) return;
              try {
                const dest = typeof it.dest === 'string' ? await this.viewer.pdf.getDestination(it.dest) : it.dest;
                if (!dest) return;
                const ref = dest[0];
                const idx = await this.viewer.pdf.getPageIndex(ref);
                this.viewer.goToPage(idx + 1);
              } catch {
                toast('无法跳转到该目录项', 'warn', 1800);
              }
            }
          }, [el('span', { text: it.title || '(无标题)' })])
        );
        if (it.items?.length) walk(it.items, depth + 1);
      }
    };
    walk(outline, 0);
  }

  renderDiscussions(body) {
    const list = [...this.chat.conversations].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    $('#sidebarCount').textContent = list.length ? `${list.length} 轮` : '';
    if (!list.length) {
      body.appendChild(el('div', { class: 'side-empty', text: '还没有讨论。在 PDF 里选中一段文字，点「与 AI 讨论」开始第一轮。' }));
      return;
    }
    list.forEach((c, i) => {
      const firstQ = c.messages.find((m) => m.role === 'user')?.content || '(未提问)';
      const item = el('div', {
        class: 'disc-item' + (c.id === this.chat.activeId ? ' active' : ''),
        onclick: () => this.restoreConversation(c.id)
      }, [
        el('div', { class: 'disc-top' }, [
          el('span', { class: 'disc-idx', text: String(i + 1) }),
          el('span', { class: 'disc-time', text: fmtTime(c.createdAt) }),
          c.anchor ? el('span', { class: 'disc-pos', text: `P${c.anchor.page}${c.anchor.lineStart != null ? `·L${c.anchor.lineStart}` : ''}` }) : null
        ]),
        el('div', { class: 'disc-q', text: firstQ }),
        el('div', { class: 'disc-top', style: { marginTop: '5px', marginBottom: '0' } }, [
          el('span', { class: 'disc-mode', text: { context: '上下文', web: '联网', image: '截图' }[c.mode] || c.mode }),
          c.annotated ? el('span', { class: 'disc-mode', style: { color: 'var(--amber)', borderColor: 'var(--amber)' }, text: '已写入 PDF' }) : null,
          el('span', {
            class: 'disc-mode',
            style: { marginLeft: 'auto', cursor: 'pointer' },
            text: '删除',
            onclick: (e) => {
              e.stopPropagation();
              if (confirm(`删除第 ${i + 1} 轮讨论？PDF 上的注记也会一并移除。`)) {
                this.chat.deleteConversation(c.id);
              }
            }
          })
        ])
      ]);
      body.appendChild(item);
    });
  }

  async renderLibrary(body) {
    const docs = await window.api.listLibrary();
    $('#sidebarCount').textContent = docs.length ? `${docs.length} 个` : '';
    if (!docs.length) {
      body.appendChild(el('div', { class: 'side-empty', text: '还没有打开过任何 PDF。' }));
      return;
    }
    for (const d of docs) {
      body.appendChild(
        el('div', {
          class: 'lib-item',
          onclick: () => this.openFile(d.filePath)
        }, [
          el('div', { class: 'lib-name', text: d.title || d.fileName }),
          el('div', { class: 'lib-path', text: d.filePath }),
          el('div', { class: 'lib-stat', text: `打开于 ${fmtTime(d.updatedAt)}` })
        ])
      );
    }
  }

  renderConvDrawer() {
    const body = $('#convDrawerBody');
    body.innerHTML = '';
    const list = [...this.chat.conversations].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!list.length) {
      body.appendChild(el('div', { class: 'side-empty', text: '还没有讨论记录。' }));
      return;
    }
    for (const c of list) {
      const firstQ = c.messages.find((m) => m.role === 'user')?.content || '(未提问)';
      const turns = c.messages.filter((m) => m.role !== 'system').length;
      body.appendChild(
        el('div', {
          class: 'disc-item' + (c.id === this.chat.activeId ? ' active' : ''),
          onclick: () => {
            this.restoreConversation(c.id);
            $('#convDrawer').classList.add('hidden');
            $('#drawerMask').classList.add('hidden');
          }
        }, [
          el('div', { class: 'disc-top' }, [
            el('span', { class: 'disc-time', text: fmtTime(c.createdAt, true) }),
            el('span', { class: 'disc-mode', text: { context: '上下文', web: '联网', image: '截图' }[c.mode] || c.mode }),
            c.anchor ? el('span', { class: 'disc-pos', text: `第 ${c.anchor.page} 页 第 ${c.anchor.lineStart ?? '-'} 行` }) : null
          ]),
          el('div', { class: 'disc-q', text: firstQ }),
          el('div', { class: 'form-hint', text: `${turns} 条消息${c.conclusion ? ' · 已有结论' : ''}${c.annotated ? ' · 已写入 PDF' : ''}` })
        ])
      );
    }
  }

  // ================================================================ 分隔条
  bindSplitter() {
    const sp = $('#splitter');
    const panel = $('#chatPanel');
    let dragging = false;
    sp.addEventListener('mousedown', (e) => {
      dragging = true;
      sp.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = clamp(window.innerWidth - e.clientX, 340, Math.max(420, window.innerWidth - 620));
      panel.style.width = `${w}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ================================================================ 全局事件
  bindGlobal() {
    // 快捷键
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.openDialog();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        this.settings.open();
      } else if (mod && e.key === '=') {
        e.preventDefault();
        this.setZoom(this.viewer.scale * 1.2);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        this.setZoom(this.viewer.scale / 1.2);
      }
    });

    document.addEventListener('click', (e) => {
      // 点击 PDF 空白区收起浮动工具条
      if (!e.target.closest('#selPopup') && !window.getSelection()?.toString()) {
        this.selection.hidePopup();
      }
    });

    // 拖放打开
    const area = $('.viewer-area');
    const mask = $('#dropMask');
    area.addEventListener('dragover', (e) => {
      e.preventDefault();
      mask.classList.add('show');
    });
    area.addEventListener('dragleave', (e) => {
      if (e.target === area) mask.classList.remove('show');
    });
    area.addEventListener('drop', (e) => {
      e.preventDefault();
      mask.classList.remove('show');
      const f = e.dataTransfer?.files?.[0];
      if (f && /\.pdf$/i.test(f.name)) this.openFile(f.path || f.name);
      else toast('请拖入 PDF 文件', 'warn');
    });

    // 模块间事件
    window.addEventListener('conversations-changed', () => {
      this.refreshAfterConversationChange();
    });
    window.addEventListener('open-settings', () => this.settings.open());
    window.addEventListener('open-scope-popover', (e) => this.scopePop.toggle(e.detail.anchor));
    // 注记写入只改动注记层，PDF 的页面内容/文本层并未变化，
    // 因此这里走增量刷新即可——完整重载（重解析 PDF + 重抽全文）会明显卡顿。
    window.addEventListener('pdf-dirty', (e) => {
      if (this.doc) this.refreshAnnotationsIncremental(e.detail?.pages);
    });
    window.addEventListener('busy', (e) => this.showBusy(e.detail?.text));
    window.addEventListener('busy-done', () => this.hideBusy());
  }

  bindIpc() {
    window.api.on('app:openFile', (path) => this.openFile(path));
    window.api.on('app:menu', (action) => {
      switch (action) {
        case 'settings': this.settings.open(); break;
        case 'zoom-in': this.setZoom(this.viewer.scale * 1.2); break;
        case 'zoom-out': this.setZoom(this.viewer.scale / 1.2); break;
        case 'zoom-reset': this.setZoom(1.25); break;
        case 'toggle-theme': this.toggleTheme(); break;
      }
    });
    window.api.on('app:deepLink', (payload) => this.handleDeepLink(payload));
  }

  onConfigChanged(cfg) {
    this.config = cfg;
    this.updateStatus();
    this.chat._updateCtxBar();
    this.chat._updateScopeLabel();
  }

  // ================================================================ 打开文档
  async openDialog() {
    const path = await window.api.openPdfDialog();
    if (path) this.openFile(path);
  }

  async openFile(filePath, { restoreConvId = null } = {}) {
    if (!filePath) return;
    try {
      const res = await window.api.readPdf(filePath);
      if (!res.ok) return toast(`打开失败：${res.error}`, 'err', 4000);

      const opened = await window.api.openLibrary(filePath, {});
      if (!opened.ok) return toast(`打开失败：${opened.error}`, 'err', 4000);

      this.doc = opened.meta;
      this.chat.setDocument(this.doc, opened.conversations);
      await this.manualAnnot.setDocument(this.doc.hash, this.doc.filePath);

      const info = await this.viewer.load(res.data);
      if (info.title && info.title !== this.doc.title) {
        const updated = await window.api.updateDoc(this.doc.hash, { title: info.title, pageCount: info.numPages });
        if (updated) this.doc = updated;
      } else {
        const updated = await window.api.updateDoc(this.doc.hash, { pageCount: info.numPages });
        if (updated) this.doc = updated;
      }

      this.thumbs.clear();
      $('#emptyState')?.remove();
      $('#btnZoomLevel').textContent = `${Math.round(this.viewer.scale * 100)}%`;

      // 顶栏信息
      $('#docTitle').textContent = this.doc.title || this.doc.fileName;
      $('#docSub').textContent = this.doc.filePath;
      $('#pageTotal').textContent = `/ ${info.numPages}`;
      this.updateStatus();
      this.renderSidebar();
      this.refreshAnnotations();

      // 后台抽取全文
      this.viewer.extractAll(() => {
        this.chat._updateCtxBar();
      });

      if (restoreConvId) {
        this.restoreConversation(restoreConvId);
      }

      window.api.syncNote(this.doc.hash, this.chat.conversations);
    } catch (e) {
      console.error(e);
      toast(`打开 PDF 失败：${e.message}`, 'err', 5000);
    }
  }

  async reloadPdf() {
    if (!this.doc || this._reloading) return;
    this._reloading = true;
    const page = this.viewer.currentPage;
    try {
      const res = await window.api.readPdf(this.doc.filePath);
      if (res.ok) {
        await this.viewer.load(res.data);
        await this.viewer.goToPage(page, { smooth: false });
        this.thumbs.clear();
        this.renderSidebar();
        this.refreshAnnotations();
        await this.viewer.extractAll(() => this.chat._updateCtxBar());
      }
    } catch (e) {
      console.warn('[app] reload failed', e);
    } finally {
      this._reloading = false;
    }
  }

  refreshAnnotations(pages = null) {
    this.viewer.setAnnotations(this.chat.conversations, this.chat.activeId, pages);
  }

  /**
   * 注记变更后的增量刷新：只重绘受影响的注记层，保留页码 / 缩放 / 滚动位置。
   * 不重新读取文件、不重新解析 PDF、不重抽全文、不重建缩略图。
   * @param {number[]|null} pages 受影响的页码；null 表示全量重绘
   */
  refreshAnnotationsIncremental(pages = null) {
    const st = this.viewer.captureViewState();
    this.refreshAnnotations(pages);
    this.viewer.restoreViewState(st);
    this.updateStatus();
    if (this.sidebarView === 'discussions') this.renderSidebar();
  }

  // ------------------------------------------------------------ 忙碌遮罩
  showBusy(text = '处理中…') {
    const el = $('#busyOverlay');
    if (!el) return;
    const t = $('#busyText');
    if (t) t.textContent = text;
    el.hidden = false;
  }

  hideBusy() {
    const el = $('#busyOverlay');
    if (el) el.hidden = true;
  }

  // ------------------------------------------------------------ 手动注记
  bindAnnotToolbar() {
    // 类型工具：选中文本后点击即应用
    for (const t of ANNOT_TYPES) {
      const btn = $(`#maTool-${t.id}`);
      if (!btn) continue;
      btn.title = `${t.name}：先在 PDF 中选中文字，再点此应用`;
      btn.addEventListener('click', () => {
        this.manualAnnot.setTool(t.id);
        this.applyAnnotToSelection();
      });
    }

    // 颜色圆点动态生成，省得在 HTML 里重复六遍
    const cbox = $('#maColors');
    if (cbox) {
      cbox.innerHTML = '';
      for (const c of ANNOT_COLORS) {
        const b = document.createElement('button');
        b.className = `ma-swatch ma-swatch-${c.id}`;
        b.id = `maColor-${c.id}`;
        b.title = `颜色：${c.name}`;
        b.addEventListener('click', () => this.manualAnnot.setColor(c.id));
        cbox.appendChild(b);
      }
    }

    $('#maToolEraser')?.addEventListener('click', () => this.manualAnnot.toggleEraser());
    $('#maWritePdf')?.addEventListener('click', () => this.writeManualAnnotsToPdf());

    // Delete / Backspace 删除选中的注记（输入框内不拦截）
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const ae = document.activeElement;
      const tag = (ae && ae.tagName ? ae.tagName : '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (ae && ae.isContentEditable)) return;
      const sel = this.manualAnnot.getSelected();
      if (!sel) return;
      e.preventDefault();
      this.manualAnnot.remove(sel.id);
    });

    this.manualAnnot.syncToolbar();
  }

  /** 把当前工具应用到现有文本选区 */
  async applyAnnotToSelection() {
    const sel = this.selection && this.selection.current;
    if (!sel || !sel.rects || !sel.rects.length) {
      return toast('先在 PDF 中选中一段文字，再点击注记工具', 'warn', 2600);
    }
    const item = await this.manualAnnot.createFromSelection(sel);
    if (!item) return undefined;
    const t = ANNOT_TYPES.find((x) => x.id === item.type);
    toast(item.type === 'note' ? '已添加批注，可直接输入文字' : `已添加${t ? t.name : '注记'}`, 'ok', 2000);
    this.selection.hidePopup();
    return undefined;
  }

  async writeManualAnnotsToPdf() {
    if (!this.doc) return toast('请先打开 PDF', 'warn');
    const res = await this.manualAnnot.writeToPdf();
    if (!res || !res.ok) return toast((res && res.error) || '写回失败', 'err', 4000);
    return toast(
      res.backupPath ? `已写回 ${res.count} 条注记（原文件已自动备份）` : `已写回 ${res.count} 条注记`,
      'ok',
      3600
    );
  }

  refreshAfterConversationChange() {
    this.refreshAnnotations();
    this.updateStatus();
    if (this.sidebarView === 'discussions') this.renderSidebar();
    if (this.sidebarView === 'pages') {
      this.renderSidebar();
    }
    if (!$('#convDrawer').classList.contains('hidden')) this.renderConvDrawer();
  }

  persistConversations(hash, list) {
    window.api.saveConversations(hash, list);
    window.api.syncNote(hash, list);
    this.updateStatus();
  }

  // ================================================================ 讨论
  startDiscussion(sel, mode) {
    if (!this.doc) return;
    if (mode === 'web' && !this.hasSearchKey()) {
      toast('请先在设置中配置联网检索的 API Key', 'warn', 4000);
      this.settings.open();
      return;
    }
    this.chat.setPendingAnchor(sel, mode);
    // 侧边栏切到讨论记录，方便看到新增
    if (this.sidebarView === 'pages' || this.sidebarView === 'outline') {
      this.setSidebarView('discussions');
    }
  }

  hasSearchKey() {
    const s = this.config.search;
    return s.provider === 'bocha' ? !!s.bochaKey : !!s.tavilyKey;
  }

  restoreConversation(convId) {
    const conv = this.chat.conversations.find((c) => c.id === convId);
    if (!conv) return;
    this.chat.openConversation(convId);
    this.refreshAnnotations();
    // 侧边栏同步高亮
    if (this.sidebarView === 'discussions') this.renderSidebar();
  }

  jumpToAnchor(anchor) {
    if (!anchor || anchor.page == null) return;
    const rect = anchor.union || (anchor.rects && anchor.rects[0]);
    this.viewer.scrollToRect(anchor.page, rect);
    if (rect) this.viewer.flashRects(anchor.page, anchor.rects || [rect]);
  }

  // ================================================================ 截图提问
  async onCaptured({ image, parsed, hasText }) {
    const cfg = this.config;
    const preview = $('#capturePreview');
    $('#cpImage').src = `data:image/png;base64,${image}`;
    $('#cpQuestion').value = '';
    $('#cpWarn').classList.toggle('hidden', hasText || !!cfg.ai.supportsVision);
    preview.classList.remove('hidden');

    // 绑定一次
    if (!this._cpBound) {
      this._cpBound = true;
      $('#cpCancel').addEventListener('click', () => preview.classList.add('hidden'));
      $('#cpRetake').addEventListener('click', () => {
        preview.classList.add('hidden');
        this.selection.startCapture();
      });
      $('#cpSend').addEventListener('click', () => this.submitCapture());
      $('#cpQuestion').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.submitCapture();
        }
      });
    }
    this._capture = { image, parsed, hasText };
    $('#cpQuestion').focus();
  }

  async submitCapture() {
    const q = $('#cpQuestion').value.trim();
    const cap = this._capture;
    if (!q || !cap) return;
    $('#capturePreview').classList.add('hidden');

    if (!this.config.ai.apiKey && !/127\.0\.0\.1|localhost/.test(this.config.ai.baseURL || '')) {
      toast('请先在设置中填写 API Key', 'warn', 3400);
      this.settings.open();
      return;
    }

    let conv = this.chat.active;
    if (!conv || conv.messages.length > 0) {
      conv = this.chat.newConversation(null, cap.hasText ? 'context' : 'image');
    }
    conv.anchor = {
      page: cap.parsed.page,
      lineStart: cap.parsed.lineStart,
      lineEnd: cap.parsed.lineEnd,
      quote: cap.parsed.quote || '(扫描区域，无文本层)',
      rects: cap.parsed.rects,
      union: cap.parsed.union,
      isImage: !cap.hasText
    };
    conv.image = cap.image;
    conv.updatedAt = new Date().toISOString();

    if (cap.hasText) {
      // 有文本层：直接按文本讨论，最省 token
      this.chat.render();
      this.chat.persist();
      const input = $('#chatInput');
      input.value = q;
      input.focus();
      toast('已定位到该区域的文字，正在按文字提问', 'ok', 2600);
      this.chat.submit();
      return;
    }

    if (!this.config.ai.supportsVision) {
      toast('当前模型未开启识图能力，且该区域没有文本层。请在设置中开启「模型支持识图」或换用多模态模型。', 'warn', 6000);
      return;
    }

    // 无文本层：走视觉问答
    this.chat.render();
    const userMsg = {
      role: 'user',
      content: q,
      at: new Date().toISOString(),
      image: cap.image
    };
    conv.messages.push(userMsg);
    this.chat._appendMessage(userMsg);
    this.chat._setStreaming(true);

    try {
      this.chat.requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      this.chat._pendingText = '';
      const aiMsg = { role: 'assistant', content: '', model: this.config.ai.model, at: new Date().toISOString() };
      this.chat._pendingMsg = aiMsg;
      this.chat._appendMessage(aiMsg, { streaming: true });

      window.api.aiChat({
        requestId: this.chat.requestId,
        messages: [
          { role: 'system', content: this.config.prompts.contextSystem },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `这是《${this.doc?.title || '文档'}》第 ${cap.parsed.page} 页的一个区域截图（该 PDF 无文本层，只能看图）。\n\n${q}\n\n请先描述你看到了什么（公式、图表、段落结构），再作答。`
              },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${cap.image}` } }
            ]
          }
        ]
      });
    } catch (e) {
      this.chat._setStreaming(false);
      toast(e.message || String(e), 'err', 4000);
    }
  }

  // ================================================================ 深链
  async handleDeepLink(payload) {
    if (!payload?.convId) return;
    const hit = await window.api.findConversation(payload.convId, payload.hash);
    if (!hit) {
      toast('未找到该讨论记录（笔记可能已被清理）', 'warn', 4200);
      return;
    }
    await this.openFile(hit.meta.filePath, { restoreConvId: payload.convId });
    toast(`已恢复 ${fmtTime(hit.conversation.createdAt)} 的讨论`, 'ok', 2600);
  }
}

const app = new App();
app
  .init()
  .then(async () => {
    console.log('[renderer] init OK');
    window.__appReady = true;

    // 自测模式：node scripts/uitest.js <pdf> 会带这个参数启动
    const autotest = new URLSearchParams(location.search).get('autotest');
    if (autotest) {
      const mod = await import('./uitest.js');
      window.__uiTest = await mod.runUiTest(app, decodeURIComponent(autotest));
    }
  })
  .catch((e) => {
    console.error('[renderer] init FAILED:', e);
    window.__appError = String(e && e.stack ? e.stack : e);
    toast(`初始化失败：${e.message}`, 'err', 8000);
  });
window.__app = app;
