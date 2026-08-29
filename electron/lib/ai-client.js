/**
 * OpenAI 兼容的聊天客户端（流式）。
 * 目标是同一套代码接 DeepSeek / OpenAI / Moonshot / Qwen / GLM / Ollama / OpenRouter 等。
 */

function normalizeBaseURL(baseURL) {
  let u = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  // 用户可能填了 https://api.deepseek.com 或 .../v1 或 .../chat/completions
  if (/\/chat\/completions$/.test(u)) u = u.replace(/\/chat\/completions$/, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/**
 * 发起一次流式对话。
 * @param {object} opts
 * @param {object} opts.cfg   config.ai
 * @param {Array}  opts.messages [{role, content}]
 * @param {(text:string)=>void} opts.onDelta
 * @param {(info:object)=>void} [opts.onUsage]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content:string, usage:object|null, reasoning:string}>}
 */
async function chatStream({ cfg, messages, onDelta, onUsage, signal }) {
  const baseURL = normalizeBaseURL(cfg.baseURL);
  if (!baseURL) throw new Error('未配置 API Base URL，请到设置中填写。');
  if (!cfg.apiKey && !/127\.0\.0\.1|localhost|0\.0\.0\.0/.test(baseURL)) {
    throw new Error('未配置 API Key，请到设置中填写。');
  }
  if (!cfg.model) throw new Error('未配置模型名称，请到设置中填写。');

  const url = `${baseURL}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  // OpenRouter 可选头
  if (/openrouter\.ai/.test(baseURL)) {
    headers['HTTP-Referer'] = 'https://local.pdf-ai-reader';
    headers['X-Title'] = 'AI PDF Reader';
  }

  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.3,
    max_tokens: cfg.maxOutputTokens ?? 4096,
    stream: cfg.stream !== false
  };
  // 让支持的服务返回用量统计
  body.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new AbortError();
    throw new Error(`网络请求失败：${e.message}`);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(parseAPIError(res.status, txt));
  }

  if (!cfg.stream || !res.body) {
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || '';
    if (onDelta) onDelta(content);
    if (onUsage && json?.usage) onUsage(json.usage);
    return { content, usage: json?.usage || null, reasoning: '' };
  }

  return readSSE(res.body, { onDelta, onUsage, signal });
}

async function readSSE(body, { onDelta, onUsage, signal }) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';

  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal && signal.aborted) throw new AbortError();
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = rawEvent
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') return;

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // 半包或心跳，跳过
        }
        // 部分服务把错误放在 data 里
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

        const choice = json.choices && json.choices[0];
        if (choice) {
          const delta = choice.delta || {};
          // 兼容 reasoning_content（DeepSeek-R1 / GLM）
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
          }
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            if (onDelta) onDelta(delta.content);
          }
        }
        if (json.usage && onUsage) onUsage(json.usage);
      }
    }
  };

  await pump();

  if (signal && signal.aborted) throw new AbortError();
  return { content, reasoning, usage: null };
}

function parseAPIError(status, text) {
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || j?.message || j?.msg || text;
  } catch {
    /* 不是 JSON，用原文 */
  }
  const tail = String(msg).slice(0, 300);
  const known = {
    401: 'API Key 无效或已过期（401）',
    403: '无访问权限，请检查 Key 的权限或余额（403）',
    404: '接口地址不存在，请检查 Base URL 与模型名（404）',
    429: '触发限流或余额不足（429）',
    500: '服务端错误，请稍后重试（500）',
    503: '服务暂时不可用（503）'
  };
  return `${known[status] || `请求失败（${status}）`}：${tail}`;
}

/** 拉取模型列表，用于设置面板的下拉提示 */
async function listModels(cfg) {
  const baseURL = normalizeBaseURL(cfg.baseURL);
  if (!baseURL || !cfg.apiKey) return [];
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data || []).map((m) => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { chatStream, listModels, normalizeBaseURL, AbortError };
