# AI PDF Reader · 论文与专业书籍的 AI 辅助学习阅读器

一个面向**学术论文 / 专业书籍**的离线优先 PDF 阅读器。左侧看文档、右侧与 AI 讨论，
所有讨论都会以**标准 PDF 注记（高亮 + 链接）**的形式写回原文件，并自动维护一份
**每个 PDF 专属的 Markdown 笔记**，记录每次讨论的时间、位置（页码 + 行号）、内容与结论。

> 界面参考 VS Code：左 PDF、右对话、活动栏切换 页面 / 大纲 / 讨论 / 书库。

---

## 功能特性

- **双模式 AI 讨论**
  - `上下文讨论`：仅把 PDF 正文（按 token / 篇幅上限截取）送给模型，不联网。
  - `联网检索讨论`：调用搜索 API（Tavily / 博查可选），把真实网页摘要作为证据，句末标注 `[1][2]` 来源。
- **选中即讨论**：直接拖选 PDF 文本发起讨论；若文档无文本层（扫描件 / 图片），自动退回**区域截图**，走视觉多模态模型。
- **上下文预算可控**：可设置 `maxTokens`、取文范围（around / selection / cursor / range / whole）、截断锚定策略，避免长文档烧钱。
- **一轮讨论 = 一段会话**：每次完整讨论独立成一轮，新讨论生成新会话；会话是笔记的唯一数据源。
- **注记写回 PDF**：用标准 PDF `Highlight` + 透明 `Link` 注记，点击可在 Adobe / Chrome 等阅读器里打开 `aidiscuss://` 深链回到本应用并恢复该段历史对话。
- **专属 Markdown 笔记**：每个 PDF 一份 `<指纹>.md`，顶部是元信息表 + 讨论索引表，下方是逐轮详情（原文锚点、问答、检索来源、用量、结论、深链）。
- **兼容多服务商**：内置 DeepSeek / OpenAI / Kimi / 通义 / 智谱 / 硅基流动 / OpenRouter / Ollama，以及自定义 OpenAI 兼容端点。视觉模型（截图讨论）自动识别。
- **深色 / 浅色主题**、缩放、书库管理、拖拽打开、纯键盘操作。

---

## 环境要求

- Node.js 18+（开发机用 22.x 验证通过）
- 自行提供 AI 服务商 API Key（默认 DeepSeek）
- 任选其一的联网搜索 Key：Tavily 或 博查（仅联网模式需要）

---

## 快速开始

```bash
# 1. 安装依赖（会自动把 pdf.js 的 cmaps / 字体 / ESM 构建复制到 vendor/）
npm install

# 2. 启动开发模式
npm start
```

首次启动后，在右侧设置里填入：

- `AI` 标签页：选择服务商（或「自定义」）并填写 API Key 与模型名；
- `搜索` 标签页：选择 Tavily / 博查，填入对应 Key（不联网可跳过）；
- `上下文` 标签页：调整 token 上限、取文范围等。

打开任意 PDF，选中一段文字即可发起讨论。

---

## 测试

无需 API Key 也能跑通整条链路——内置一个会“回显”请求内容的本地 Mock 模型服务，
用于断言「正文 `<<<PAGE n>>>` 标记、问题、原文引用」确实被送到模型。

```bash
# Node 侧单测：注记读写 / 幂等 / 去重 / 指纹稳定 / 笔记 / token 截断 / 深链反查
npm run smoke           # 42 项断言（selftest.js）

# 渲染侧端到端：生成 5 页样例 PDF → 启动 Mock 服务 → 启动 Electron → 跑 74 项断言
# 见 scripts/uitest.js，需在本机有显示器 / 能跑 Electron 的环境执行
```

> 注：`uitest.js` 会在无头 / 沙箱环境需要额外 flag（已内置 `--no-sandbox --disable-gpu` 等）。
> 若 `ELECTRON_RUN_AS_NODE` 被外部注入，脚本会自动清除，避免 Electron 退化成纯 Node。

---

## 目录结构

```
pdf-ai-reader/
├── electron/                # 主进程 / 预加载脚本 / 核心库
│   ├── main.js              # 协议(app://)、深链(aidiscuss://)、单实例锁、IPC、菜单、区域截图
│   ├── preload.js           # contextBridge 白名单 API + 事件频道
│   └── lib/
│       ├── config.js        # 设置持久化（9 个预置服务商、搜索、上下文预算、提示词）
│       ├── ai-client.js     # OpenAI 兼容流式客户端（SSE + reasoning_content + usage）
│       ├── search.js        # Tavily / 博查 适配层
│       ├── tokens.js        # CJK 感知 token 估算 + 以锚点页为中心的上下文截断
│       ├── annotations.js   # PDF 高亮 + 链接注记写入（pdf-lib，幂等 / 临时文件重命名）
│       ├── notes.js         # 满量重建式 Markdown 笔记生成
│       └── store.js         # 书库 + 会话存储（按路径优先匹配，保持指纹稳定）
├── src/
│   ├── index.html           # VS Code 风格骨架（标题栏 / 活动栏 / 侧栏 / 视图区 / 对话 / 状态栏）
│   ├── css/main.css         # 主题变量 + pdf.js textLayer 规则 + 标注 / Markdown 样式
│   └── js/
│       ├── viewer.js        # PdfViewer：虚拟滚动、文本层、坐标换算(PDF↔CSS)、标注覆盖层
│       ├── selection.js     # 选区 / 区域截图管理（CSS 矩形 → 页码/行号/引用）
│       ├── chat.js          # 对话面板（流式、历史、上下文装配、笔记同步、中止）
│       ├── settings.js      # 设置面板（即时写入）+ 取文范围弹层
│       └── app.js           # 入口装配、快捷键、拖拽、深链处理
├── vendor/pdfjs/            # 内置的 pdf.js ESM + cmaps + standard_fonts（postinstall 复制）
├── scripts/                 # 复制依赖、自测、Mock 模型、示例生成
└── examples/notes/          # 一份示例笔记（见 a1b2c3d4e5f60718.md）
```

---

## 数据落在哪里

所有用户数据存放在 `app.getPath('userData')`（默认 Windows 在
`%APPDATA%\ai-pdf-reader`，可通过 `PDFAI_USER_DATA` 环境变量重定向，便于测试）：

| 内容 | 路径 |
| --- | --- |
| 全局设置 | `<userData>/settings.json` |
| 书库索引 | `<userData>/library.json` |
| 会话记录 | `<userData>/conversations/<指纹>.json` |
| Markdown 笔记 | `<userData>/notes/<指纹>.md` |
| 原 PDF 备份 | 写注记前在 PDF 同目录生成 `<原名>.bak`（可在设置关闭） |

> 注记是直接写回**原 PDF 文件**的（先写临时文件再重命名，异常可回退）。
> 若 PDF 被其它程序占用会给出明确提示。

---

## 打包（可选）

```bash
npm i -D electron-builder   # 若尚未安装
npm run dist                 # 产出 dist/ 下的 NSIS 安装包（x64）
```

`package.json` 中的 `build` 段已配置好 `appId`、文件清单、NSIS 选项与图标位置
（`build/icon.ico`，缺省不影响打包）。

---

## 已知边界 / 设计取舍

- **坐标系统**：PDF 用户坐标（左下原点，y 向上）与 CSS 坐标（左上原点，y 向下）不同，
  `viewer.js` 用 `viewport.transform` 矩阵统一换算，多矩形高亮用 `QuadPoints`（LB→RB→LT→RT）。
- **指纹稳定**：写注记会改变文件字节，因此 `store.js` 以**归一化路径优先**匹配书库，
  仅在路径变化时回退到内容指纹，避免笔记 / 会话被“孤儿化”。
- **截图讨论**走视觉模型，会剥离 base64 图片再持久化会话，避免单文件膨胀到数百 MB。
- **深链恢复**：点击注记在外部阅读器里打开 `aidiscuss://conv/<id>?file=<指纹>`，
  本应用通过单实例锁接收并定位到对应会话。

---

## 许可

MIT
