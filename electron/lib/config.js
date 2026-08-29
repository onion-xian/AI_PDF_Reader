/**
 * 应用配置持久化。
 * 存放在 app.getPath('userData')/settings.json
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  ai: {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxOutputTokens: 4096,
    supportsVision: false,
    stream: true
  },
  // 预置服务商，设置面板里一键切换
  providers: [
    { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: false },
    { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: true },
    { id: 'moonshot', name: 'Moonshot / Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-128k', vision: false },
    { id: 'qwen', name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: false },
    { id: 'zhipu', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', vision: true },
    { id: 'siliconflow', name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', vision: false },
    { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', vision: false },
    { id: 'ollama', name: 'Ollama (本地)', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b', vision: false },
    { id: 'custom', name: '自定义 (OpenAI 兼容)', baseURL: '', model: '', vision: false }
  ],
  search: {
    provider: 'tavily', // tavily | bocha
    tavilyKey: '',
    bochaKey: '',
    maxResults: 5,
    searchDepth: 'basic', // tavily: basic | advanced
    // 联网模式下是否把 PDF 选区也作为背景带上
    includeSelectionContext: true
  },
  context: {
    // 上下文模式一次最多送多少 token 的 PDF 正文，防止长文档烧钱
    maxTokens: 12000,
    // 取文范围策略：selection | around | range | whole | cursor
    scope: 'around',
    // around 模式下，选中位置前后各取多少页
    aroundPages: 2,
    // range 模式
    rangeFrom: 1,
    rangeTo: 1,
    // 超出上限时的截断锚定方式：selection(以选中位置为中心) | start(从头截)
    truncateAnchor: 'selection',
    // 是否把整篇文档的目录/摘要一起带上
    includeOutline: true
  },
  prompts: {
    contextSystem:
      '你是一位严谨的学术论文与专业书籍阅读助手。\n' +
      '用户会给你一段从 PDF 中摘出的正文，以及用户的提问。\n' +
      '要求：\n' +
      '1. 优先依据给定正文作答，引用时标注【第 X 页 第 Y 行】。\n' +
      '2. 正文中找不到答案时，明确说明"正文未涉及"，再基于领域常识补充，并标注这是常识推断。\n' +
      '3. 解释概念时先给一句话结论，再展开；公式请逐符号解释。\n' +
      '4. 使用与用户相同的语言回答。',
    webSystem:
      '你是一位善于联网检索的研究助手。\n' +
      '你会拿到检索到的真实网页摘要，以及用户正在阅读的 PDF 片段作为背景。\n' +
      '要求：\n' +
      '1. 结论必须基于检索结果，并在句末用 [1][2] 标注来源编号。\n' +
      '2. 检索结果不足时，如实说明信息缺口，不要编造。\n' +
      '3. 优先给出可核查的事实（论文标题、年份、作者、指标数值），再给解读。\n' +
      '4. 使用与用户相同的语言回答。'
  },
  ui: {
    theme: 'dark',
    zoom: 1.25,
    // 聊天气泡里的 Markdown 是否渲染
    renderMarkdown: true
  },
  // 写注记前是否自动备份原 PDF
  backupBeforeAnnotate: true
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base === 'object' && typeof patch === 'object') {
    const out = { ...base };
    for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
    return out;
  }
  return patch;
}

class Config {
  constructor(userData) {
    this.file = path.join(userData, 'settings.json');
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return deepMerge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
      }
    } catch (e) {
      console.error('[config] load failed, fallback to defaults:', e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error('[config] save failed:', e.message);
      return false;
    }
  }

  get() {
    return this.data;
  }

  set(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }
}

module.exports = { Config, DEFAULTS };
