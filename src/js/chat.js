/**
 * 聊天面板：会话管理 + 双模式提问 + 流式渲染
 *
 * 一轮「完整讨论」= 一个会话（conversation）。新讨论生成新会话，
 * 所有会话连同锚点一起持久化，并在 PDF 上以注记形式留痕。
 */
import { $, el, uid, fmtTime, toast, escapeHtml, truncate } from './utils.js';
import { renderMarkdown, bindCitations } from './markdown.js';

const MODE_LABEL = { context: 'PDF 上下文', web: '联网检索', image: '截图提问' };

/** 落盘前剔除 base64 截图，只留一个 hasImage 标记 */
function stripImages(conversations) {
  return (conversations || []).map((c) => {
    if (!c.image && !c.messages?.some((m) => m.image)) return c;
    const out = { ...c };
    if (out.image) {
      delete out.image;
      out.hasImage = true;
    }
    out.messages = (c.messages || []).map((m) => {
      if (!m.image) return m;
      const { image, ...rest } = m;
      return { ...rest, hasImage: true };
    });
    return out;
  });
}

export class ChatPanel {
  constructor({ viewer, getConfig, onPersist, onStatus, onJumpToAnchor }) {
    this.viewer = viewer;
    this.getConfig = getConfig;
    this.onPersist = onPersist || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onJumpToAnchor = onJumpToAnchor || (() => {});

    this.doc = null; // {hash, filePath, fileName, title, pageCount}
    this.conversations = [];
    this.activeId = null;
    this.streaming = false;
    this.requestId = null;
    this._pendingEl = null;
    this._pendingText = '';
    this._renderTimer = null;
    this._lastUsage = null;
    this.pendingAnchor = null; // 未发起讨论前暂存的锚点

    this._bindUI();
    this._bindAIEvents();
  }

  // ================================================================ UI 绑定
  _bindUI() {
    $('#modeSwitch').addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (!btn) return;
      const mode = btn.dataset.mode;
      this.setMode(mode);
    });

    $('#btnSend').addEventListener('click', () => this.submit());
    $('#btnStop').addEventListener('click', () => this.stop());

    const input = $('#chatInput');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
      this._updateSendState();
    });

    $('#qpClose').addEventListener('click', () => this.clearPendingAnchor());

    $('#btnNewConv').addEventListener('click', () => {
      this.newConversation(null, this.currentMode);
      toast('已开启新讨论，选中 PDF 文字即可带着引用提问', 'info', 2400);
    });

    $('#btnMarkConclusion').addEventListener('click', () => this.markConclusion());
    $('#btnAnnotate').addEventListener('click', () => this.annotateActive());

    $('#btnCtxScope').addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('open-scope-popover', { detail: { anchor: e.currentTarget } }));
    });
  }

  _bindAIEvents() {
    window.api.on('ai:chunk', ({ requestId, delta }) => {
      if (requestId !== this.requestId) return;
      this._pendingText += delta;
      this._scheduleStreamRender();
    });

    window.api.on('ai:usage', ({ requestId, usage }) => {
      if (requestId !== this.requestId) return;
      this._lastUsage = usage;
    });

    window.api.on('ai:done', ({ requestId, content, reasoning, usage }) => {
      if (requestId !== this.requestId) return;
      this._finishStream(content, { reasoning, usage: usage || this._lastUsage });
    });

    window.api.on('ai:error', ({ requestId, message }) => {
      if (requestId !== this.requestId) return;
      this._finishStream(null, { error: message });
    });

    window.api.on('ai:aborted', ({ requestId }) => {
      if (requestId !== this.requestId) return;
      this._finishStream(this._pendingText || '(已停止生成)', { aborted: true });
    });
  }

  // ================================================================ 文档 / 会话
  setDocument(doc, conversations) {
    this.doc = doc;
    this.conversations = conversations || [];
    this.activeId = null;
    this.pendingAnchor = null;
    this._renderEmpty();
    this._updateComposeState();
    this._updateCtxBar();
  }

  get active() {
    return this.conversations.find((c) => c.id === this.activeId) || null;
  }

  get currentMode() {
    const btn = $('#modeSwitch .mode-btn.active');
    return btn ? btn.dataset.mode : 'context';
  }

  setMode(mode) {
    for (const b of document.querySelectorAll('#modeSwitch .mode-btn')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
    // 讨论进行中时不允许中途切换
    if (this.active && !this.streaming) {
      this.active.mode = mode;
      this.persist();
      toast(`本轮讨论已切换为「${MODE_LABEL[mode]}」`, 'info', 1800);
    }
    this._updateCtxBar();
    this._updateScopeLabel();
    this._updateSendState();
  }

  newConversation(anchor, mode) {
    const cfg = this.getConfig();
    const conv = {
      id: uid('c'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: mode || this.currentMode || 'context',
      model: cfg.ai.model,
      anchor: anchor || null,
      conclusion: '',
      annotated: false,
      annotNo: null,
      messages: []
    };
    this.conversations.push(conv);
    this.activeId = conv.id;
    this.pendingAnchor = null;
    this.render();
    this.persist();
    // 让侧栏同步
    window.dispatchEvent(new CustomEvent('conversations-changed'));
    return conv;
  }

  openConversation(id, { scroll = true } = {}) {
    const conv = this.conversations.find((c) => c.id === id);
    if (!conv) return;
    this.activeId = id;
    this.pendingAnchor = null;
    if (conv.mode) this.setModeSilent(conv.mode);
    this.render();
    if (scroll && conv.anchor) {
      this.onJumpToAnchor(conv.anchor);
    }
    window.dispatchEvent(new CustomEvent('conversations-changed'));
  }

  setModeSilent(mode) {
    for (const b of document.querySelectorAll('#modeSwitch .mode-btn')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
    this._updateCtxBar();
    this._updateScopeLabel();
  }

  deleteConversation(id) {
    const idx = this.conversations.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const conv = this.conversations[idx];
    if (conv.annotated && this.doc) {
      // 同步移除 PDF 注记
      window.api.removeAnnotation({ filePath: this.doc.filePath, convId: conv.id }).then((r) => {
        if (r.ok && r.count) toast('已同步移除 PDF 上的注记', 'ok', 2000);
      });
    }
    // 重新编号
    this.conversations.splice(idx, 1);
    this._renumberAnnotations();
    if (this.activeId === id) {
      this.activeId = this.conversations.length ? this.conversations[this.conversations.length - 1].id : null;
      this.render();
    }
    this.persist();
    window.dispatchEvent(new CustomEvent('conversations-changed'));
  }

  _renumberAnnotations() {
    let n = 0;
    for (const c of [...this.conversations].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
      if (c.annotated) c.annotNo = ++n;
      else c.annotNo = null;
    }
  }

  persist() {
    if (!this.doc) return;
    // 截图以 base64 存在内存里供当场渲染，落盘时剥离，避免会话文件膨胀到几百 MB
    this.onPersist(this.doc.hash, stripImages(this.conversations));
  }

  // ================================================================ 锚点
  /**
   * 带着选区开启/补充一轮讨论。
   * @param {object} sel 选区解析结果
   * @param {string} [mode] 指定模式。若当前会话已经聊过，则新开一轮，不改动旧会话的模式。
   */
  setPendingAnchor(sel, mode) {
    if (!sel) return this.clearPendingAnchor();

    let conv = this.active;
    if (!conv || conv.messages.length > 0) {
      // 已有内容的会话不能复用，否则会覆盖上一轮讨论
      conv = this.newConversation(null, mode || this.currentMode);
    } else if (mode && conv.mode !== mode) {
      // 空会话可以就地改模式
      conv.mode = mode;
    }
    if (mode) this.setModeSilent(mode);

    conv.anchor = {
      page: sel.page,
      lineStart: sel.lineStart,
      lineEnd: sel.lineEnd,
      quote: sel.quote,
      rects: sel.rects,
      union: sel.union
    };
    conv.updatedAt = new Date().toISOString();
    this.render();
    this.persist();
    window.dispatchEvent(new CustomEvent('conversations-changed'));

    const input = $('#chatInput');
    input.focus();
  }

  clearPendingAnchor() {
    const conv = this.active;
    if (conv && conv.messages.length === 0) {
      conv.anchor = null;
      this.render();
      this.persist();
    }
    $('#quotePreview').classList.add('hidden');
  }

  // ================================================================ 上下文构建
  /** 按设置的范围策略取出 PDF 正文页 */
  _collectPages(conv) {
    const cfg = this.getConfig().context;
    const anchorPage = conv?.anchor?.page || this.viewer.currentPage || 1;
    const total = this.viewer.numPages || this.doc?.pageCount || 0;
    if (!total) return { pages: [], center: anchorPage, scopeNote: '' };

    let from;
    let to;
    let scopeNote = '';

    switch (cfg.scope) {
      case 'selection': {
        from = to = anchorPage;
        scopeNote = `仅第 ${anchorPage} 页`;
        break;
      }
      case 'range': {
        from = Math.max(1, Math.min(cfg.rangeFrom || 1, total));
        to = Math.max(from, Math.min(cfg.rangeTo || total, total));
        scopeNote = `第 ${from}-${to} 页`;
        break;
      }
      case 'whole': {
        from = 1;
        to = total;
        scopeNote = `全文 ${total} 页`;
        break;
      }
      case 'cursor': {
        from = to = this.viewer.currentPage || 1;
        scopeNote = `当前第 ${from} 页`;
        break;
      }
      default: {
        const span = Math.max(0, Number(cfg.aroundPages) || 0);
        from = Math.max(1, anchorPage - span);
        to = Math.min(total, anchorPage + span);
        scopeNote = span === 0 ? `第 ${anchorPage} 页` : `第 ${from}-${to} 页（选中位置 ±${span}）`;
      }
    }

    const pages = [];
    for (let n = from; n <= to; n++) {
      const text = this.viewer.getPageText(n);
      if (text) pages.push({ page: n, text });
    }
    return { pages, center: anchorPage, scopeNote, from, to };
  }

  /** 估算当前设置下会送多少 token，用于状态条实时显示 */
  estimateContextTokens() {
    const conv = this.active;
    const cfg = this.getConfig();
    if (!conv) return { tokens: 0, max: cfg.context.maxTokens, truncated: false };
    const { pages, center } = this._collectPages(conv);
    if (!pages.length) return { tokens: 0, max: cfg.context.maxTokens, truncated: false };

    const TU = window.TokenUtils;
    const built = TU.buildContext(pages, center, cfg.context.maxTokens);
    return {
      tokens: built.tokens,
      max: cfg.context.maxTokens,
      truncated: built.truncated,
      totalTokens: built.totalTokens,
      usedPages: built.usedPages
    };
  }

  async _buildMessages(conv, question) {
    const cfg = this.getConfig();
    const TU = window.TokenUtils;
    const mode = conv.mode === 'image' ? 'context' : conv.mode;

    // 历史（最近若干轮，控制长度）
    const history = conv.messages
      .filter((m) => m.role !== 'system')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    if (mode === 'web') {
      const query = this._buildSearchQuery(conv, question);
      this._setStatus('正在联网检索…');
      const searchResult = await window.api.webSearch(query);

      if (!searchResult.ok) {
        throw new Error(searchResult.error || '检索失败');
      }

      let block = `【检索词】${query}\n\n【检索结果】\n`;
      searchResult.results.forEach((r, i) => {
        block += `[${i + 1}] 《${r.title}》\n来源：${r.source || ''}${r.date ? ` · ${r.date}` : ''}\n链接：${r.url}\n摘要：${(r.snippet || '').slice(0, 700)}\n\n`;
      });
      if (searchResult.answer) block = `【检索概览】${searchResult.answer}\n\n${block}`;

      let pdfPart = '';
      if (cfg.search.includeSelectionContext !== false && conv.anchor?.quote) {
        pdfPart = `\n【我正在阅读的 PDF 片段】（${this.doc?.title || ''} 第 ${conv.anchor.page} 页 第 ${conv.anchor.lineStart ?? '-'} 行）\n"${conv.anchor.quote.slice(0, 1200)}"\n`;
      }

      const messages = [{ role: 'system', content: cfg.prompts.webSystem }];
      if (history.length) messages.push(...history);
      messages.push({ role: 'user', content: `${block}${pdfPart}\n【我的问题】${question}` });

      return { messages, sources: searchResult.results, query, meta: { tokens: TU.estimateMessages(messages) } };
    }

    // ---------- PDF 上下文模式 ----------
    const { pages, center, scopeNote } = this._collectPages(conv);
    if (!pages.length) {
      throw new Error('尚未完成正文提取，请等待左下角「文本提取」进度完成后再试');
    }

    const built = TU.buildContext(pages, center, cfg.context.maxTokens);
    const anchor = conv.anchor;

    let header = `【文档】${this.doc?.title || this.doc?.fileName || '未知'}`;
    header += `，共 ${this.viewer.numPages || this.doc?.pageCount || '?'} 页。\n`;
    if (anchor) {
      header += `【当前讨论位置】第 ${anchor.page} 页 第 ${anchor.lineStart ?? '-'}${anchor.lineEnd && anchor.lineEnd !== anchor.lineStart ? `-${anchor.lineEnd}` : ''} 行。`;
      if (anchor.quote) header += `\n【该处原文】"${anchor.quote.slice(0, 800)}"`;
    }
    header += `\n【本次送入的正文范围】${scopeNote}`;
    if (built.truncated) {
      header += `（因超出 ${cfg.context.maxTokens} token 上限，已按“靠近讨论位置优先”截断，实际送入第 ${built.usedPages[0]}-${built.usedPages[built.usedPages.length - 1]} 页）`;
    }
    header += `\n\n`;

    const body = `以下为正文摘录，每行开头的 <<<PAGE n>>> 标记该段所属页码：\n\n${built.text}`;
    const questionPart = `\n\n【我的问题】${question}\n\n请回答时引用具体位置，格式为【第 X 页 第 Y 行】。`;

    const combined = `${header}${body}${questionPart}`;

    // 若加上历史会超预算，就从最早的历史开始丢弃
    let keptHistory = history;
    const systemTokens = TU.estimateTokens(cfg.prompts.contextSystem);
    let budget = cfg.context.maxTokens + 4000; // 正文上限 + 一点余量
    while (keptHistory.length) {
      const total = systemTokens + TU.estimateTokens(combined) + TU.estimateMessages(keptHistory);
      if (total <= budget) break;
      keptHistory = keptHistory.slice(2);
    }

    const messages = [{ role: 'system', content: cfg.prompts.contextSystem }];
    if (keptHistory.length) messages.push(...keptHistory);
    messages.push({ role: 'user', content: combined });

    return {
      messages,
      sources: [],
      meta: {
        tokens: TU.estimateMessages(messages),
        bodyTokens: built.tokens,
        usedPages: built.usedPages,
        truncated: built.truncated,
        scopeNote
      }
    };
  }

  _buildSearchQuery(conv, question) {
    const q = String(question || '').trim();
    const anchor = conv?.anchor?.quote || '';
    // 问题过短时，用选区内容补强检索词
    if (q.length < 12 && anchor) {
      return truncate(`${q} ${anchor}`, 160).replace(/\s+/g, ' ');
    }
    return truncate(q, 200);
  }

  // ================================================================ 发送
  async submit() {
    if (this.streaming) return;
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    if (!this.doc) {
      toast('请先打开一个 PDF 文档', 'warn');
      return;
    }
    const cfg = this.getConfig();
    if (!cfg.ai.apiKey && !/127\.0\.0\.1|localhost/.test(cfg.ai.baseURL || '')) {
      toast('请先在设置中填写 API Key', 'warn', 3400);
      window.dispatchEvent(new CustomEvent('open-settings'));
      return;
    }

    let conv = this.active;
    if (!conv) conv = this.newConversation(null, this.currentMode);

    // 第一问时把锚点固定下来
    const userMsg = {
      role: 'user',
      content: text,
      at: new Date().toISOString(),
      anchor: conv.anchor ? { ...conv.anchor, rects: undefined } : null
    };
    conv.messages.push(userMsg);
    conv.updatedAt = new Date().toISOString();

    input.value = '';
    input.style.height = 'auto';
    this._appendMessage(userMsg);
    this._updateSendState();
    this._setStreaming(true);

    try {
      const built = await this._buildMessages(conv, text);
      // 保存本轮实际使用的来源，供渲染角标
      this._pendingSources = built.sources || [];
      this._pendingMeta = built.meta || {};

      this.requestId = uid('req');
      this._pendingText = '';
      this._lastUsage = null;

      const aiMsg = {
        role: 'assistant',
        content: '',
        model: cfg.ai.model,
        sources: built.sources || [],
        at: new Date().toISOString()
      };
      this._pendingMsg = aiMsg;
      this._appendMessage(aiMsg, { streaming: true });

      window.api.aiChat({
        requestId: this.requestId,
        messages: built.messages
      });
    } catch (e) {
      this._setStreaming(false);
      // 失败也要留痕：为什么这次没问成，本身就是有价值的阅读记录
      const errMsg = {
        role: 'assistant',
        content: '',
        error: e.message || String(e),
        at: new Date().toISOString()
      };
      conv.messages.push(errMsg);
      this._appendMessage(errMsg);
      this.persist();
      toast(e.message || String(e), 'err', 5000);
    }
  }

  stop() {
    if (!this.streaming || !this.requestId) return;
    window.api.aiAbort(this.requestId);
  }

  _scheduleStreamRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      if (this._pendingEl && this._pendingMsg) {
        this._pendingMsg.content = this._pendingText;
        const body = this._pendingEl.querySelector('.msg-body');
        if (body) {
          body.classList.add('cursor-blink');
          body.innerHTML = renderMarkdown(this._pendingText, {
            citations: (this._pendingSources || []).length > 0
          });
        }
        this._scrollToBottom();
      }
    }, 110);
  }

  _finishStream(content, { error, aborted, usage } = {}) {
    clearTimeout(this._renderTimer);
    this._renderTimer = null;

    const conv = this.active;

    if (this._pendingMsg) {
      this._pendingMsg.content = content || '';
      if (error) this._pendingMsg.error = error;
      if (usage) this._pendingMsg.usage = usage;
      if (aborted) this._pendingMsg.aborted = true;

      // 关键一步：AI 回复必须落进会话，否则刷新/切换后就丢了
      if (conv) {
        conv.messages.push(this._pendingMsg);
        conv.updatedAt = new Date().toISOString();
      }
    }

    if (this._pendingEl && this._pendingMsg) {
      // renderMessage 用「消息在会话中的下标」判断是否末条（末条才挂结论），
      // 所以必须取 push 之后的下标，不能拿会话在数组里的下标。
      const idx = conv ? conv.messages.length - 1 : 0;
      const fresh = this.renderMessage(this._pendingMsg, idx);
      this._pendingEl.replaceWith(fresh);
    }

    this._pendingEl = null;
    this._pendingMsg = null;
    this._pendingText = '';
    this._pendingSources = [];
    this.requestId = null;
    this._setStreaming(false);

    if (error) toast(error, 'err', 5200);
    this.persist();
    this._scrollToBottom();
    this._setStatus('');
  }

  _setStreaming(on) {
    this.streaming = on;
    $('#btnSend').classList.toggle('hidden', on);
    $('#btnStop').classList.toggle('hidden', !on);
    this._updateSendState();
    this._updateComposeState();
  }

  // ================================================================ 渲染
  render() {
    const host = $('#chatMessages');
    const conv = this.active;
    host.innerHTML = '';

    if (!conv) {
      this._renderEmpty();
      return;
    }

    $('#chatPlaceholder')?.remove();
    conv.messages.forEach((m, i) => {
      if (m.role === 'system') return;
      host.appendChild(this.renderMessage(m, i));
    });
    this._scrollToBottom();
    this._updateComposeState();
    this._updateCtxBar();
    this._updateScopeLabel();
  }

  _renderEmpty() {
    const host = $('#chatMessages');
    host.innerHTML = '';
    const ph = document.getElementById('chatPlaceholder');
    if (ph) host.appendChild(ph);
    ph?.classList.remove('hidden');
    $('#chatTitle').textContent = this.doc ? 'AI 讨论' : 'AI 讨论';
  }

  renderMessage(msg, index) {
    const conv = this.active;
    const isUser = msg.role === 'user';
    const wrap = el('div', { class: `msg ${isUser ? 'user' : 'ai'}${msg.error ? ' error' : ''}` });

    const head = el('div', { class: 'msg-head' });
    head.appendChild(
      el('span', { class: `msg-who ${isUser ? 'user' : 'ai'}`, text: isUser ? '我' : 'AI' })
    );
    if (!isUser && msg.model) head.appendChild(el('span', { class: 'msg-model', text: msg.model }));
    if (isUser && index === 0 && conv?.anchor) {
      head.appendChild(
        el('span', {
          class: 'msg-pos',
          text: `第 ${conv.anchor.page} 页 第 ${conv.anchor.lineStart ?? '-'} 行`
        })
      );
    }
    if (msg.at) head.appendChild(el('span', { text: fmtTime(msg.at) }));

    const actions = el('div', { class: 'msg-head-actions' });
    actions.appendChild(
      el('button', {
        class: 'icon-btn sm',
        title: '复制',
        html: '<svg viewBox="0 0 24 24" width="13" height="13"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>',
        onclick: async (e) => {
          e.stopPropagation();
          const { copyText } = await import('./utils.js');
          const ok = await copyText(msg.content || '');
          toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err', 1400);
        }
      })
    );
    head.appendChild(actions);
    wrap.appendChild(head);

    const body = el('div', { class: 'msg-body' });

    // 首次提问带上的原文引用
    if (isUser && index === 0 && conv?.anchor?.quote) {
      body.appendChild(
        el('div', { class: 'msg-quote' }, [
          el('span', {
            class: 'mq-label',
            text: `引用 · 第 ${conv.anchor.page} 页 第 ${conv.anchor.lineStart ?? '-'} 行`
          }),
          document.createTextNode(conv.anchor.quote.slice(0, 500))
        ])
      );
    }

    if (msg.error) {
      body.appendChild(el('div', { text: `⚠ ${msg.error}` }));
    } else if (isUser) {
      body.appendChild(el('div', { class: 'md', html: renderMarkdown(msg.content || '') }));
    } else {
      const hasSources = (msg.sources || []).length > 0;
      body.appendChild(
        el('div', { class: 'md', html: renderMarkdown(msg.content || '', { citations: hasSources }) })
      );
      if (hasSources) body.appendChild(this._renderSources(msg.sources));
      if (msg.usage) {
        body.appendChild(
          el('div', {
            class: 'form-hint',
            text: `tokens: ${msg.usage.prompt_tokens ?? '-'} in / ${msg.usage.completion_tokens ?? '-'} out`
          })
        );
      }
      if (msg.aborted) body.appendChild(el('div', { class: 'form-hint', text: '（已手动停止）' }));
    }

    // 结论
    if (!isUser && conv?.conclusion && index === conv.messages.length - 1) {
      body.appendChild(
        el('div', { class: 'msg-conclusion' }, [
          el('span', { class: 'mc-label', text: '本轮结论' }),
          el('span', { text: conv.conclusion })
        ])
      );
    }

    wrap.appendChild(body);

    if (!isUser && !msg.error && (msg.sources || []).length) {
      bindCitations(body, (n) => {
        const s = msg.sources[n - 1];
        if (s) window.api.openExternal(s.url);
      });
    }
    return wrap;
  }

  _renderSources(sources) {
    const box = el('div', { class: 'sources-box' });
    box.appendChild(el('div', { class: 'sources-title', text: `检索来源（${sources.length}）` }));
    sources.forEach((s, i) => {
      const item = el('div', {
        class: 'source-item',
        onclick: () => window.api.openExternal(s.url)
      });
      item.appendChild(el('span', { class: 'source-idx', text: `[${i + 1}]` }));
      const main = el('div', { class: 'source-main' });
      main.appendChild(el('div', { class: 'source-title', text: s.title || s.url }));
      main.appendChild(el('div', { class: 'source-url', text: s.url || '' }));
      item.appendChild(main);
      box.appendChild(item);
    });
    return box;
  }

  _appendMessage(msg, { streaming = false } = {}) {
    const host = $('#chatMessages');
    const ph = document.getElementById('chatPlaceholder');
    if (ph) ph.remove();

    if (streaming) {
      const node = el('div', { class: 'msg ai' });
      const head = el('div', { class: 'msg-head' });
      head.appendChild(el('span', { class: 'msg-who ai', text: 'AI' }));
      head.appendChild(el('span', { class: 'msg-model', text: this.getConfig().ai.model }));
      node.appendChild(head);
      const body = el('div', { class: 'msg-body' });
      body.appendChild(el('div', { class: 'thinking' }, [
        el('span', { text: this.active?.mode === 'web' ? '已获取检索结果，正在作答' : '正在阅读正文' }),
        el('span', { class: 'dot-pulse', html: '<i></i><i></i><i></i>' })
      ]));
      node.appendChild(body);
      host.appendChild(node);
      this._pendingEl = node;
      this._scrollToBottom();
      return node;
    }

    const node = this.renderMessage(msg, (this.active?.messages.length || 1) - 1);
    host.appendChild(node);
    this._scrollToBottom();
    return node;
  }

  _scrollToBottom() {
    const host = $('#chatMessages');
    host.scrollTop = host.scrollHeight;
  }

  // ================================================================ 结论 / 注记
  markConclusion() {
    const conv = this.active;
    if (!conv) return toast('还没有讨论内容', 'warn');
    const last = [...conv.messages].reverse().find((m) => m.role === 'assistant' && !m.error);
    if (!last) return toast('还没有 AI 回复', 'warn');

    const text = window.prompt('编辑本轮结论（留空则使用 AI 最后回复的开头部分）：', conv.conclusion || last.content.slice(0, 300));
    if (text === null) return;
    conv.conclusion = text.trim() || last.content.slice(0, 300);
    conv.updatedAt = new Date().toISOString();
    this.render();
    this.persist();
    window.dispatchEvent(new CustomEvent('conversations-changed'));
    toast('已标记结论，并写入笔记文件', 'ok');
  }

  async annotateActive() {
    const conv = this.active;
    if (!conv) return toast('请先开始一轮讨论', 'warn');
    if (!conv.anchor || !Array.isArray(conv.anchor.rects) || !conv.anchor.rects.length) {
      return toast('这一轮讨论没有选中位置，无法写入注记', 'warn');
    }
    if (!conv.messages.some((m) => m.role === 'assistant')) {
      return toast('还没有 AI 回复，先聊完再写入注记', 'warn');
    }

    const firstQ = conv.messages.find((m) => m.role === 'user')?.content || '';
    const lastA = [...conv.messages].reverse().find((m) => m.role === 'assistant' && !m.error)?.content || '';
    const contents = `AI 讨论：${truncate(firstQ, 90)} → ${truncate(conv.conclusion || lastA, 160)}`;

    const geom = await this.viewer.cssRectsToAnnotGeom(conv.anchor.page, conv.anchor.rects);
    if (!geom) return toast('无法确定注记位置', 'err');

    // 大文件写盘较慢，给出可见的忙碌提示
    this._setStatus('正在写回 PDF 注记…');
    window.dispatchEvent(new CustomEvent('busy', { detail: { text: '正在写回 PDF 注记…' } }));
    let res;
    try {
      res = await window.api.writeAnnotation({
        filePath: this.doc.filePath,
        convId: conv.id,
        hash: this.doc.hash,
        contents,
        items: [{ page: conv.anchor.page, rect: geom.rect, quadPoints: geom.quadPoints }]
      });
    } finally {
      window.dispatchEvent(new CustomEvent('busy-done'));
      this._setStatus('');
    }

    if (!res.ok) {
      return toast(res.error || '写入注记失败', 'err', 5000);
    }

    conv.annotated = true;
    this._renumberAnnotations();
    conv.updatedAt = new Date().toISOString();
    this.persist();
    window.dispatchEvent(new CustomEvent('conversations-changed'));
    this._setStatus('');
    toast(
      res.backupPath ? '已写入 PDF 注记（原文件已自动备份）' : '已写入 PDF 注记',
      'ok',
      3600
    );
    // 仅通知受影响的页码，上层据此做局部增量重绘（不再整体重载 PDF）
    window.dispatchEvent(
      new CustomEvent('pdf-dirty', { detail: { hash: this.doc.hash, pages: [conv.anchor.page] } })
    );
  }

  // ================================================================ 状态显示
  _updateComposeState() {
    const conv = this.active;
    const hasDoc = !!this.doc;
    $('#chatInput').disabled = !hasDoc || this.streaming;
    $('#btnSend').disabled = !hasDoc || this.streaming;
    $('#btnMarkConclusion').disabled = !conv || !conv.messages.some((m) => m.role === 'assistant');
    $('#btnAnnotate').disabled = !conv || !conv.anchor || !conv.messages.some((m) => m.role === 'assistant');

    const qp = $('#quotePreview');
    if (conv && conv.anchor && conv.messages.length === 0) {
      qp.classList.remove('hidden');
      $('#qpLabel').textContent = `第 ${conv.anchor.page} 页 第 ${conv.anchor.lineStart ?? '-'} 行`;
      $('#qpText').textContent = conv.anchor.quote || '';
    } else {
      qp.classList.add('hidden');
    }
  }

  _updateSendState() {
    const input = $('#chatInput');
    const btn = $('#btnSend');
    if (!btn) return;
    btn.disabled = this.streaming || !input.value.trim() || !this.doc;
  }

  _updateCtxBar() {
    const bar = $('#ctxBar');
    if (!bar) return;
    const isWeb = this.currentMode === 'web';
    const cfg = this.getConfig();
    if (isWeb) {
      $('#ctxScopeLabel').textContent = `${cfg.search.provider === 'tavily' ? 'Tavily' : '博查'} · 最多 ${cfg.search.maxResults} 条`;
      $('#ctxToken').textContent = `联网检索`;
      $('#ctxWarn').classList.add('hidden');
      return;
    }
    const est = this.estimateContextTokens();
    $('#ctxToken').textContent = `${est.tokens.toLocaleString()} / ${est.max.toLocaleString()}`;
    $('#ctxWarn').classList.toggle('hidden', !est.truncated);
    this._updateScopeLabel();
  }

  _updateScopeLabel() {
    const cfg = this.getConfig().context;
    const conv = this.active;
    const anchorPage = conv?.anchor?.page || this.viewer.currentPage || 1;
    const total = this.viewer.numPages || this.doc?.pageCount || 0;
    let label = '';
    switch (cfg.scope) {
      case 'selection': label = `仅第 ${anchorPage} 页`; break;
      case 'range': label = `第 ${cfg.rangeFrom}-${cfg.rangeTo} 页`; break;
      case 'whole': label = `全文（${total} 页）`; break;
      case 'cursor': label = `当前页`; break;
      default:
        label = cfg.aroundPages === 0 ? `第 ${anchorPage} 页` : `选中位置 ±${cfg.aroundPages} 页`;
    }
    const node = $('#ctxScopeLabel');
    if (node && this.currentMode !== 'web') node.textContent = label;
  }

  _setStatus(text) {
    this.onStatus(text);
    $('#composeHint').textContent = text || '';
  }
}

export { MODE_LABEL };
