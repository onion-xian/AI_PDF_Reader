# AI PDF Reader · 论文与专业书籍的 AI 辅助学习阅读器

一个面向**学术论文 / 专业书籍**的离线优先 PDF 阅读器。左侧看文档、右侧与 AI 讨论，
所有讨论都会以**标准 PDF 注记（高亮 + 链接）**的形式写回原文件，并自动维护一份
**每个 PDF 专属的 Markdown 笔记**，记录每次讨论的时间、位置（页码 + 行号）、内容与结论。

> 界面参考 VS Code：左 PDF、右对话、活动栏切换 页面 / 大纲 / 讨论 / 书库。

> **给 AI / 协作者**：仓库根目录的 [`AGENTS.md`](./AGENTS.md) 是面向编码 agent 的交接说明书，
> 记录了发版流程、版本号规则、架构红线与已知天坑。接手开发前请先读它。

---

## 功能特性

- **双模式 AI 讨论**
  - `上下文讨论`：仅把 PDF 正文（按 token / 篇幅上限截取）送给模型，不联网。
  - `联网检索讨论`：调用搜索 API（Tavily / 博查可选），把真实网页摘要作为证据，句末标注 `[1][2]` 来源。
- **选中即讨论**：直接拖选 PDF 文本发起讨论；若文档无文本层（扫描件 / 图片），自动退回**区域截图**，走视觉多模态模型。
- **上下文预算可控**：可设置 `maxTokens`、取文范围（around / selection / cursor / range / whole）、截断锚定策略，避免长文档烧钱。
- **一轮讨论 = 一段会话**：每次完整讨论独立成一轮，新讨论生成新会话；会话是笔记的唯一数据源。
- **注记写回 PDF**：用标准 PDF `Highlight` + 透明 `Link` 注记，点击可在 Adobe / Chrome 等阅读器里打开 `aidiscuss://` 深链回到本应用并恢复该段历史对话。
- **手动标注（普通阅读器能力）**：工具栏提供 `高亮 / 下划线 / 删除线 / 批注` 四种类型 × `黄 / 绿 / 蓝 / 粉 / 紫 / 橙` 六种颜色；
  拖选文字后点类型即可落标，批注可点开气泡编辑文本，支持选中、`Delete` 删除、橡皮擦定点擦除。
  标注先存本地 JSON（即时生效、零等待），需要分享或归档时再点「写回 PDF」一次性烧进原文件（标准 `Highlight` / `Underline` / `StrikeOut` 注记，Adobe 可识别）。
- **增量刷新**：AI 写回注记后只重绘受影响的页面注记层，不再重新解析 PDF、不重建缩略图，页码 / 缩放 / 滚动位置原样保留。
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
npm run smoke           # 42 项断言（scripts/selftest.js）

# Node 侧单测：手动标注——存储层 / 脏数据过滤 / 类型与色板常量 / 写回 PDF / 幂等 / 擦除
npm run test:manual     # 28 项断言（scripts/selftest-manual.js）

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
│       ├── manual-annot.js  # 手动标注本地存储层（<userData>/annotations/<指纹>.json）
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
│       ├── manual-annot.js  # 标注工具栏状态机（类型 / 颜色 / 擦除 / 气泡编辑 / 写回）
│       └── app.js           # 入口装配、快捷键、拖拽、深链处理、增量刷新
├── vendor/pdfjs/            # 内置的 pdf.js ESM + cmaps + standard_fonts（postinstall 复制）
├── scripts/                 # 复制依赖、自测、Mock 模型、示例生成、图标制作
│   ├── make-icon.js         # 由 build/icon.png 生成 16~256 六尺寸 ICO
│   └── check-icon.js        # 解析 PE 资源段，验证 exe 内嵌图标尺寸
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
| 手动标注 | `<userData>/annotations/<指纹>.json` |
| Markdown 笔记 | `<userData>/notes/<指纹>.md` |
| 原 PDF 备份 | 写注记前在 PDF 同目录生成 `<原名>.bak`（可在设置关闭） |

> 手动标注**默认只存本地**，不会动原 PDF；点「写回 PDF」时才烧进文件，且烧写前会
> 先清掉同名前缀的旧注记（幂等），因此重复写回不会产生叠加的高亮。

> 注记是直接写回**原 PDF 文件**的（先写临时文件再重命名，异常可回退）。
> 若 PDF 被其它程序占用会给出明确提示。

---

## 打包（可选）

```bash
npm i -D electron-builder   # 若尚未安装
npm run dist                 # 产出 dist/win-unpacked/ 下的免安装目录（x64）
```

`package.json` 中的 `build` 段已配置好 `appId`、文件清单、NSIS 选项与图标位置
（`build/icon.ico`）。

图标有三个坑，都已处理：

1. **ICO 必须含 256×256**，否则 electron-builder 直接报错。
   Pillow 的 `Image.save(format='ICO')` 在多数版本里只写最小的 16×16 帧，
   所以改用 `npm run make-icon` 手工拼 ICO 二进制（ICONDIR + 6 个 ICONDIRENTRY + PNG 数据块）。
2. **`files` 必须包含 `build/**/*`**，否则图标进不了 asar，
   exe 图标对但窗口标题栏 / 任务栏仍是 Electron 默认图标。
3. **`BrowserWindow` 要显式传 `icon`**，只改 exe 图标不会影响标题栏与任务栏。

验证：`node scripts/check-icon.js "dist/win-unpacked/AI PDF Reader.exe"`
会解析 PE 资源段并打印内嵌图标尺寸（应看到 16 / 32 / 48 / 256）。

---

## 下载安装包（Release）

打包产物会作为 **GitHub Release** 附件发布，直接下载即可分发：

- **最新安装包**：[AI-PDF-Reader-Setup-1.0.0-alpha.20260829.exe](https://github.com/onion-xian/AI_PDF_Reader/releases/download/alpha-20260829/AI-PDF-Reader-Setup-1.0.0-alpha.20260829.exe)（约 99.7 MB，NSIS 安装包，含可选安装路径、桌面/开始菜单快捷方式、卸载入口）
- **全部 Release**：<https://github.com/onion-xian/AI_PDF_Reader/releases>

> `alpha-20260830` 为**文档版本**（新增 `AGENTS.md` 交接说明书），无代码与二进制变更，因此未重新打包；安装包仍沿用上述 `alpha-20260829` 的产物。
> 仓库已设为 **Public**，Release 任何人可见可下载。
> 安装包**未做代码签名**，首次在他人机器运行会被 Windows SmartScreen 拦截（显示“未知发布者”），点“仍要运行”即可；如需消除该提示需自行购买代码签名证书。

### 版本号规则

- 主版本号格式：`alpha-YYYYMMDD`（按**实际提交/上传日期**命名，例如 `alpha-20260829`）。
- **若同一天向仓库上传了多个版本**，在日期后缀后再追加英文字母表示“当日第几个”：
  `alpha-20260829`（第 1 个）→ `alpha-20260829a`（第 2 个）→ `alpha-20260829b`（第 3 个）…依此类推。
- 对应的 `package.json` 版本号取 semver 形式：`1.0.0-alpha.20260829`、`1.0.0-alpha.20260829a` …（electron-builder 要求合法 semver）。
- 提交信息与 git tag 均使用上述 `alpha-...` 版本号。

---

## 已知边界 / 设计取舍

- **坐标系统**：PDF 用户坐标（左下原点，y 向上）与 CSS 坐标（左上原点，y 向下）不同，
  `viewer.js` 用 `viewport.transform` 矩阵统一换算，多矩形高亮用 `QuadPoints`（LB→RB→LT→RT）。
- **指纹稳定**：写注记会改变文件字节，因此 `store.js` 以**归一化路径优先**匹配书库，
  仅在路径变化时回退到内容指纹，避免笔记 / 会话被“孤儿化”。
- **截图讨论**走视觉模型，会剥离 base64 图片再持久化会话，避免单文件膨胀到数百 MB。
- **深链恢复**：点击注记在外部阅读器里打开 `aidiscuss://conv/<id>?file=<指纹>`，
  本应用通过单实例锁接收并定位到对应会话。
- **注记层不依赖文件内容**：AI 注记与手动标注的覆盖层都是纯 DOM，由会话对象 / 标注 JSON 驱动，
  与 PDF 文件字节无关。因此写回注记后只需重绘注记层，无需重载 PDF。
  两类注记共用同一个 `.annot-layer`，所以必须走 `_paintAllAnnotations()` 统一重绘——
  分开绘制会互相清空。
- **手动标注与 AI 注记互不干扰**：PDF 里用 `/NM` 前缀区分（`manual-` vs AI 的会话 id），
  擦除时只删匹配前缀的注记。

---

## 许可

MIT
