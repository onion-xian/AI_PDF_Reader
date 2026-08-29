/**
 * 每个 PDF 一份专属 Markdown 笔记：notes/<hash>.md
 * 记录每次讨论的时间、位置（页码+行号）、讨论内容与结论。
 *
 * 采用「全量重建」策略：以 conversations 数据为唯一真实来源重新生成 md，
 * 保证删除/编辑会话后笔记文件不会残留脏数据。
 */
const fs = require('fs');
const path = require('path');

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MODE_LABEL = {
  context: '上下文讨论',
  web: '联网检索讨论',
  image: '截图讨论'
};

function posLabel(anchor) {
  if (!anchor) return '未定位';
  const p = anchor.page != null ? `第 ${anchor.page} 页` : '未分页';
  if (anchor.lineStart == null) return p;
  const ls = anchor.lineStart;
  const le = anchor.lineEnd && anchor.lineEnd !== ls ? `-${anchor.lineEnd}` : '';
  return `${p} 第 ${ls}${le} 行`;
}

function quoteBlock(text, limit = 400) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const clipped = t.length > limit ? `${t.slice(0, limit)}…` : t;
  // 转义会破坏 markdown 引用的字符
  return clipped.replace(/\r/g, ' ').replace(/\n/g, ' ');
}

function escapeCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeQuote(s) {
  return String(s == null ? '' : s).replace(/\n/g, '\n> ');
}

class Notes {
  constructor(userData) {
    this.dir = path.join(userData, 'notes');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  notePath(hash) {
    return path.join(this.dir, `${hash}.md`);
  }

  /** 生成完整 markdown 文本 */
  render(meta, conversations) {
    const title = meta.title || meta.fileName || '未命名文档';
    const lines = [];

    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`> 本文件由 **AI PDF Reader** 自动生成并维护，随讨论实时同步。`);
    lines.push(`> 手动修改可能在下次讨论后被覆盖，如需留存请另存副本。`);
    lines.push('');
    lines.push('| 项目 | 内容 |');
    lines.push('| --- | --- |');
    lines.push(`| 文件 | \`${escapeCell(meta.filePath || '')}\` |`);
    lines.push(`| 文件指纹 | \`${escapeCell(meta.hash || '')}\` |`);
    lines.push(`| 总页数 | ${meta.pageCount != null ? meta.pageCount : '-'} |`);
    lines.push(`| 首次记录 | ${fmtTime(meta.createdAt)} |`);
    lines.push(`| 最近更新 | ${fmtTime(meta.updatedAt)} |`);
    lines.push(`| 讨论轮次 | ${(conversations || []).length} |`);
    lines.push('');
    lines.push('---');
    lines.push('');

    const sorted = [...(conversations || [])].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );

    if (!sorted.length) {
      lines.push('_还没有讨论记录。在 PDF 中选中一段文字，点击「与 AI 讨论」即可开始。_');
      lines.push('');
      return lines.join('\n');
    }

    // 索引
    lines.push('## 讨论索引');
    lines.push('');
    lines.push('| # | 时间 | 位置 | 模式 | 首问 | 结论 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    sorted.forEach((c, i) => {
      const firstQ = (c.messages || []).find((m) => m.role === 'user');
      const concl = c.conclusion || '';
      lines.push(
        `| ${i + 1} | ${fmtTime(c.createdAt)} | ${escapeCell(posLabel(c.anchor))} | ` +
          `${MODE_LABEL[c.mode] || c.mode || '-'} | ${escapeCell(quoteBlock(firstQ?.content, 40))} | ` +
          `${escapeCell(quoteBlock(concl, 50))} |`
      );
    });
    lines.push('');
    lines.push('---');
    lines.push('');

    // 正文
    lines.push('## 讨论详情');
    lines.push('');

    sorted.forEach((c, i) => {
      const idx = i + 1;
      const modeLabel = MODE_LABEL[c.mode] || c.mode || '讨论';
      lines.push(`### ${idx}. ${fmtTime(c.createdAt)} · ${posLabel(c.anchor)} · ${modeLabel}`);
      lines.push('');

      if (c.anchor && c.anchor.quote) {
        lines.push('**原文锚点**');
        lines.push('');
        lines.push(`> ${quoteBlock(c.anchor.quote, 600)}`);
        lines.push('');
      }

      let turn = 0;
      for (const m of c.messages || []) {
        if (m.role === 'system') continue;
        if (m.role === 'user') {
          turn += 1;
          lines.push(`**Q${turn}（我）**`);
          lines.push('');
          lines.push(m.content || '');
          lines.push('');
        } else if (m.role === 'assistant') {
          lines.push(`**A${turn}（AI · ${m.model || '-'}）**`);
          lines.push('');
          if (m.error) {
            lines.push(`> ⚠ 本条请求失败：${escapeQuote(m.error)}`);
            if (m.aborted) lines.push('> \n> （已手动停止生成）');
          } else {
            lines.push(m.content || '');
          }
          lines.push('');
          if (m.sources && m.sources.length) {
            lines.push(`<details><summary>检索来源（${m.sources.length}）</summary>`);
            lines.push('');
            m.sources.forEach((s, si) => {
              lines.push(`${si + 1}. [${s.title}](${s.url})${s.date ? ` — ${s.date}` : ''}`);
              if (s.snippet) lines.push(`   > ${s.snippet.slice(0, 200)}`);
            });
            lines.push('');
            lines.push('</details>');
            lines.push('');
          }
          if (m.usage) {
            lines.push(
              `<sub>用量：prompt ${m.usage.prompt_tokens ?? '-'} / completion ${m.usage.completion_tokens ?? '-'}</sub>`
            );
            lines.push('');
          }
        }
      }

      if (c.conclusion) {
        lines.push('**结论**');
        lines.push('');
        lines.push(`> ${c.conclusion.replace(/\n/g, '\n> ')}`);
        lines.push('');
      }

      lines.push(
        `<sub>会话 ID \`${c.id}\` · 模型 \`${c.model || '-'}\` · ` +
          `[在应用中打开](aidiscuss://conv/${encodeURIComponent(c.id)}?file=${encodeURIComponent(meta.hash || '')})</sub>`
      );
      lines.push('');
      lines.push('---');
      lines.push('');
    });

    return lines.join('\n');
  }

  /** 全量写入 */
  write(meta, conversations) {
    const p = this.notePath(meta.hash);
    fs.writeFileSync(p, this.render(meta, conversations), 'utf8');
    return p;
  }

  read(hash) {
    const p = this.notePath(hash);
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  }

  exists(hash) {
    return fs.existsSync(this.notePath(hash));
  }
}

module.exports = { Notes, fmtTime, fmtDate, posLabel };
