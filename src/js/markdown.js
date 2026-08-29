/**
 * 轻量 Markdown 渲染器（零依赖 + 先转义，避免 XSS）。
 * 针对 AI 回答做了增强：
 *  - 【第 X 页 第 Y 行】渲染成高亮的页码引用
 *  - [1] [2] 渲染成可点击的来源角标（联网模式）
 *  - $...$ / $$...$$ 渲染成等宽公式块
 */
import { escapeHtml } from './utils.js';

const CODE_PLACEHOLDER = '\u0000CODE';

function inline(text, opts) {
  let s = escapeHtml(text);

  // 行内代码优先，避免内部被二次解析
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);

  // 公式 $$...$$ 与 $...$
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_m, f) => `<span class="formula">${f.trim()}</span>`);
  s = s.replace(/(^|[^\\$])\$([^$\n]{1,80}?)\$(?!\d)/g, (_m, pre, f) => `${pre}<span class="formula">${f}</span>`);

  // 页码引用：【第 3 页 第 12 行】/【P3】
  s = s.replace(
    /【\s*第?\s*(\d+)\s*页\s*(?:第\s*(\d+)(?:\s*[-~至]\s*(\d+))?\s*行)?\s*】/g,
    (_m, p, l1, l2) => {
      const label = l1 ? `第 ${p} 页 第 ${l1}${l2 ? `-${l2}` : ''} 行` : `第 ${p} 页`;
      return `<span class="page-ref">【${label}】</span>`;
    }
  );
  s = s.replace(/【\s*P\.?\s*(\d+)\s*】/gi, (_m, p) => `<span class="page-ref">【第 ${p} 页】</span>`);

  // 来源角标 [1]（仅 1-2 位数字，避免误伤数组下标）
  if (opts.citations) {
    s = s.replace(/(^|[\s，。（(])\[(\d{1,2})\](?=[\s，。；）),.]|$)/g,
      (_m, pre, n) => `${pre}<span class="cite" data-cite="${n}">[${n}]</span>`);
  }

  // 链接 [text](url) —— 仅允许 http/https，防止 javascript: 注入
  s = s.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, url) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`);

  // 强调
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return s;
}

export function renderMarkdown(src, opts = {}) {
  const options = { citations: false, ...opts };
  if (!src) return '';

  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const codes = [];
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾围栏
      const code = escapeHtml(buf.join('\n'));
      codes.push(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${code}</code></pre>`);
      out.push(`${CODE_PLACEHOLDER}${codes.length - 1}\u0000`);
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (l) => l.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      const th = header.map((c) => `<th>${inline(c, options)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c, options)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inline(h[2], options)}</h${lv}>`);
      i++;
      continue;
    }

    // 分割线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr/>');
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), options)}</blockquote>`);
      continue;
    }

    // 列表（有序/无序，支持一级嵌套）
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      const baseIndent = line.match(/^\s*/)[0].length;
      while (i < lines.length) {
        const l = lines[i];
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (!m) {
          // 续行（缩进更深且不是新列表项）
          if (items.length && /^\s{2,}\S/.test(l) && l.match(/^\s*/)[0].length > baseIndent) {
            items[items.length - 1] += ` ${l.trim()}`;
            i++;
            continue;
          }
          break;
        }
        const indent = m[1].length;
        if (indent > baseIndent + 1) {
          items[items.length - 1] += ` ${m[3]}`;
        } else {
          items.push(m[3]);
        }
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t, options)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落：合并连续非空行
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|\s*([-*+]|\d+[.)])\s|\s*\|)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join('\n'), options)}</p>`);
  }

  let html = out.join('\n');
  // 还原代码块
  html = html.replace(new RegExp(`${CODE_PLACEHOLDER}(\\d+)\u0000`, 'g'), (_m, idx) => codes[Number(idx)] || '');
  return html;
}

/** 把 markdown 渲染结果里的 [n] 角标绑定点击事件 */
export function bindCitations(container, onCite) {
  container.querySelectorAll('.cite').forEach((node) => {
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => onCite(Number(node.dataset.cite)));
  });
}
