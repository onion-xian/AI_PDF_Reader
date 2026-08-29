/**
 * 联网检索适配器：Tavily / 博查(Bocha)。
 * 统一返回 { ok, provider, query, results: [{title,url,snippet,source,date}], answer, error }
 */

async function searchTavily({ apiKey, query, maxResults, searchDepth }) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: Math.min(Math.max(Number(maxResults) || 5, 1), 20),
      search_depth: searchDepth === 'advanced' ? 'advanced' : 'basic',
      include_answer: true,
      include_raw_content: false,
      topic: 'general'
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.detail || json?.error || `Tavily 请求失败（${res.status}）`);
  }

  const results = (json.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    snippet: (r.content || '').replace(/\s+/g, ' ').trim(),
    source: 'Tavily',
    date: r.published_date || ''
  }));

  return { provider: 'tavily', query, results, answer: json.answer || '' };
}

async function searchBocha({ apiKey, query, maxResults }) {
  const res = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      count: Math.min(Math.max(Number(maxResults) || 5, 1), 20),
      summary: true,
      freshness: 'noLimit'
    })
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.message || json?.msg || `博查请求失败（${res.status}）`);
  }
  if (json.code && json.code !== 200) {
    throw new Error(json.message || json.msg || `博查返回错误码 ${json.code}`);
  }

  const pages = json?.data?.webPages?.value || [];
  const results = pages.map((p) => ({
    title: p.name || p.url,
    url: p.url,
    snippet: ((p.summary || p.snippet || '') + '').replace(/\s+/g, ' ').trim(),
    source: p.siteName || '博查',
    date: (p.dateLastCrawled || '').slice(0, 10)
  }));

  return { provider: 'bocha', query, results, answer: '' };
}

/**
 * @param {object} cfg config.search
 */
async function webSearch(cfg, query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '检索词为空', results: [] };

  const provider = cfg.provider || 'tavily';
  const maxResults = cfg.maxResults || 5;

  try {
    if (provider === 'tavily') {
      if (!cfg.tavilyKey) throw new Error('未配置 Tavily API Key（设置 → 联网检索）');
      const r = await searchTavily({ apiKey: cfg.tavilyKey, query: q, maxResults, searchDepth: cfg.searchDepth });
      return { ok: true, ...r };
    }
    if (provider === 'bocha') {
      if (!cfg.bochaKey) throw new Error('未配置博查 API Key（设置 → 联网检索）');
      const r = await searchBocha({ apiKey: cfg.bochaKey, query: q, maxResults });
      return { ok: true, ...r };
    }
    return { ok: false, error: `未知的检索服务商：${provider}`, results: [] };
  } catch (e) {
    return { ok: false, error: e.message || String(e), results: [], provider, query: q };
  }
}

/** 把检索结果压成给模型的参考块，控制长度 */
function formatSourcesForPrompt(searchResult, maxChars = 6000) {
  if (!searchResult || !searchResult.results?.length) return '';
  let total = 0;
  const lines = [];
  searchResult.results.forEach((r, i) => {
    const snippet = (r.snippet || '').slice(0, 900);
    const piece = `[${i + 1}] ${r.title}\nURL: ${r.url}${r.date ? `\n日期: ${r.date}` : ''}\n摘要: ${snippet}`;
    if (total + piece.length > maxChars) return;
    total += piece.length;
    lines.push(piece);
  });
  let out = lines.join('\n\n');
  if (searchResult.answer) out = `检索概览: ${searchResult.answer}\n\n${out}`;
  return out;
}

module.exports = { webSearch, formatSourcesForPrompt };
