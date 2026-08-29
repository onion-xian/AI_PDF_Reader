/**
 * 轻量 token 估算 + 上下文截断。
 * 主进程与渲染进程共用（UMD-lite 包装）。
 *
 * 估算口径：
 *  - CJK 字符按 0.75 token/字（中文模型通常 1 字 ≈ 0.6~1 token）
 *  - 其余按 4 字符 ≈ 1 token，并额外计入数字/符号的切分开销
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TokenUtils = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

  function estimateTokens(text) {
    if (!text) return 0;
    const s = String(text);
    const cjk = (s.match(CJK) || []).length;
    const rest = s.length - cjk;
    // 非 CJK 部分：单词比单字符更省，这里用 3.6 字符/token 略保守
    return Math.ceil(cjk * 0.75 + rest / 3.6) + 4;
  }

  /**
   * 以 centerPage 为中心向两侧扩展地选取页面，直到逼近 token 上限。
   * @param {Array<{page:number, text:string}>} pages 已按页码升序
   * @param {number} centerPage 锚点页（通常就是选中所在的页）
   * @param {number} maxTokens
   * @returns {{text:string, tokens:number, usedPages:number[], truncated:boolean, totalTokens:number}}
   */
  function buildContext(pages, centerPage, maxTokens) {
    const list = (pages || []).filter((p) => p && p.text);
    if (!list.length) return { text: '', tokens: 0, usedPages: [], truncated: false, totalTokens: 0 };

    const totalTokens = list.reduce((a, p) => a + estimateTokens(p.text), 0);

    // 按到锚点页的距离排序，同距离时小页在前
    const order = list
      .map((p) => ({ p, d: Math.abs(p.page - centerPage) }))
      .sort((a, b) => (a.d - b.d) || (a.p.page - b.p.page))
      .map((x) => x.p);

    let used = 0;
    const chosen = [];
    for (const p of order) {
      const t = estimateTokens(p.text);
      if (chosen.length && used + t > maxTokens) break;
      chosen.push(p);
      used += t;
    }

    // 若单页就超限，对该页做字符级硬截断
    let truncated = chosen.length < list.length;
    let text = chosen
      .sort((a, b) => a.page - b.page)
      .map((p) => `<<<PAGE ${p.page}>>>\n${p.text}`)
      .join('\n');

    if (!chosen.length) {
      const anchor = list.reduce((best, p) =>
        Math.abs(p.page - centerPage) < Math.abs(best.page - centerPage) ? p : best
      );
      const budget = Math.floor(maxTokens * 3.2); // 近似字符预算
      text = `<<<PAGE ${anchor.page}>>>\n` + anchor.text.slice(0, budget);
      used = estimateTokens(text);
      truncated = true;
      chosen.push(anchor);
    } else if (used > maxTokens) {
      const over = used - maxTokens;
      const cut = Math.floor(over * 3.2);
      if (cut > 0 && text.length > cut) {
        text = text.slice(0, text.length - cut);
        used = estimateTokens(text);
        truncated = true;
      }
    }

    return {
      text,
      tokens: used,
      usedPages: chosen.map((p) => p.page).sort((a, b) => a - b),
      truncated,
      totalTokens
    };
  }

  /** 估算一组 messages 的 token 数（含对话开销） */
  function estimateMessages(messages) {
    let n = 0;
    for (const m of messages || []) {
      n += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      n += 4; // role / 分隔开销
    }
    return n;
  }

  return { estimateTokens, estimateMessages, buildContext, CJK };
});
