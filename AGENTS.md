# AGENTS.md — AI PDF Reader（面向接手 agent 的说明书）

> 本文件随仓库走。任何克隆本仓库的编码 agent（Claude Code / Codex / Cursor / WorkBuddy 等）都应**先读本文件再动手**。
> 约定以本文件为准；WorkBuddy 工作区记忆 `D:\workbuddy\.workbuddy\memory\MEMORY.md` 另有补充。
> 最后更新：2026-08-30（版本 alpha-20260830a）。

## 1. 项目一句话

基于 Electron 的「AI 辅助学习」PDF 阅读器：左侧 PDF（VSCode 风格双栏），右侧与 AI 讨论；讨论可写回 PDF 注记并生成 Markdown 笔记；同时支持用户手动标注。

## 2. 仓库与分支

- 仓库：`https://github.com/onion-xian/AI_PDF_Reader`（**已 public**，任何人可读 / 下载 Release）
- 默认分支：`main`
- Owner：`onion-xian`（个人账号）
- 技术栈：Electron 33.3.1 + pdf.js 4.8.69（vendor 内置）+ pdf-lib 写注记 + electron-builder 25.1.8 打包
- 权限说明：公开**只放开读权限**。陌生人无法 push 或直改仓库，只能 fork / 提 PR，由 owner 决定是否合并。

## 3. 日常构建 / 运行

```bash
npm install                      # 装依赖（含 electron / electron-builder）
npm run make-icon                # 重新生成 build/icon.ico（勿用 Pillow 直出，见 §6）
npm start                        # 开发模式
npm run dist                     # 产出 NSIS 安装包 dist/*.exe
npm run smoke                    # 主自测 42 项（scripts/selftest.js）
npm run test:manual              # 手动标注自测 28 项（scripts/selftest-manual.js）
```

## 4. 发版流程（必守）

1. **版本号规则**：`alpha-YYYYMMDD`（按**实际提交日期**命名）。
   同一天多次发版，末尾追加字母表示当日第几个：
   - `alpha-20260830`（当日第 1 个，无字母）→ `alpha-20260830a`（第 2 个）→ `alpha-20260830b`…
   - `package.json` 受 semver 约束，须写成 `1.0.0-alpha.20260830a` 形式；
     **提交信息 / git 标签仍用** `alpha-20260830a`（不带 `1.0.0-` 前缀）。
2. **提交协议（用户硬性要求）**：
   - 每次改动**先向用户说明内容，等其明确确认后**再推送；**绝不自行 push**。
   - 提交信息**必须含版本号**，例：`alpha-20260830: 新增 AGENTS.md 交接说明书`。
3. 推送 `main` 并打同名附注标签：
   `git tag -a <版本号> -m "..."` → `git push origin main` → `git push origin <版本号>`。
4. **上传 GitHub Release**（本机**没有** `gh` CLI，走 API）：
   - 取令牌：`printf 'protocol=https\nhost=github.com\n' | git credential fill` → 取 `password` 行。
   - 创建 Release：`POST /repos/onion-xian/AI_PDF_Reader/releases`（`prerelease: true`，正文写更新内容 + 版本号规则）。若 tag 已存在会返回 `422 already_exists`，属正常，直接查 upload_url 传附件即可。
   - 传附件：`POST https://uploads.github.com/repos/onion-xian/AI_PDF_Reader/releases/<id>/assets?name=<文件名>`，`Content-Type: application/octet-stream` + `--upload-file`。
   - ⚠️ **Bash 临时文件不跨命令持久化**：写 JSON / 凭据与 `curl` 必须放在**同一条命令**里。
   - 令牌用完即删，绝不留存。
5. **每次版本更新必须同步更新本文件**（见 §9）。

## 5. 架构红线（避免改坏）

- **注记写回走增量重绘**：`chat.js` 派发 `pdf-dirty`（带受影响的页码数组）→ `app.js` 的 `refreshAnnotationsIncremental()`（快照页码 / 缩放 / 滚动 → 只重绘受影响页的注记层 → 还原视图状态）。
  **禁止改回整体 `reloadPdf()`**：旧版会重解析 PDF + 重抽全文 + 重建缩略图，明显卡顿，且滚动位置必丢。
- **AI 注记与手动标注共用同一个 `.annot-layer`**，必须统一经 `viewer.js` 的 `_paintAllAnnotations()` 一个入口绘制；分开画会互相清空。
- **手动标注**：本地 JSON 存 `<userData>/annotations/<指纹>.json`，**默认不碰原文件**；仅用户点「写回 PDF」才改，写回前自动 `.bak` 备份，且须**幂等**（重复写回不叠加多层高亮）。
- 注记覆盖层是**纯 DOM**，与 PDF 字节无关——写回只需增量重绘，勿 `reloadPdf`。

## 6. 已知天坑

- **图标**：旧的 `build/icon.ico` 曾只有 829 字节。根因是 Pillow 的 `Image.save(ico, sizes=[...])` 在多数版本里**只写最小的 16×16 帧**，而 electron-builder 要求含 256×256 否则直接报错。
  修复三件套（缺一不可）：
  1. `scripts/make-icon.js` 手工拼 ICO 二进制（16/32/48/64/128/256；尺寸 ≥256 时宽高字节写 0）；
  2. `package.json` 的 `build.files` 必须含 `"build/**/*"`（否则图标进不了 asar）；
  3. `BrowserWindow` 必须**显式传 `icon`**（否则只换 exe 图标，标题栏 / 任务栏仍是 Electron 默认图标）。
- **`npm run dist` 退出码 1 是误报**：本机「安全删除」包装会拦截清理 `*.nsis.7z` 临时文件，导致退出码非 0，但**安装包本体已生成**。
  判断是否成功以 `dist/*.exe` 是否产出为准，别被退出码骗；残留的 `*.nsis.7z` 用 PowerShell `Remove-Item -LiteralPath <绝对路径>` 清掉。
- **exe 文件被占用**：重建前先 `taskkill //F //IM "AI PDF Reader.exe"`，并用绝对路径删 `dist`（Bash 的相对路径删除会被安全包装解析错）。
- **`git push` 走不通时的兜底（本机高频）**：代理只对 `api.github.com` 放行，对 `github.com` 返回 `502 CONNECT tunnel failed`，于是 git 的 https 传输直接卡死（表现为长时间无输出）。
  判断方法：`curl https://api.github.com` 通、而 `git ls-remote https://github.com/...` 报 CONNECT 502 → 就是这种情况。
  解决办法：用 `node scripts/push-via-api.js [--tag <版本号>]` 走 REST API 推送（建 blob → tree → commit → 更新 ref → 建附注标签）。
  ⚠️ 该脚本会在远端**生成新的 commit sha**（与本地 sha 不同，内容一致），因此本地与远端历史会一次性分叉。**待网络恢复后请执行** `git fetch origin && git reset --soft origin/main` 重新对齐，之后照常用 `git push`。
- **Windows 环境杂项**：Git Bash 里没有 `sleep`；`timeout` 会解析到 CMD 的 TIMEOUT 而报错；从 Bash 调 `powershell.exe` 会被安全策略拦，要用 PowerShell 工具。
- **不要提交**：`dist/`、`node_modules/`、`.env*`、`*.bak`、`*.nsis.7z`、`.release_body.json`、用户数据（`%APPDATA%`）。`.gitignore` 已覆盖。

## 7. 目录速查

| 路径 | 作用 |
| --- | --- |
| `electron/main.js` | 主进程；窗口图标、手动标注 IPC（`manualAnnot:list/save/writeToPdf/removeFromPdf`） |
| `electron/lib/annotations.js` | PDF 注记写入（AI + 手动），pdf-lib，幂等 / 按 `/NM` 前缀移除 |
| `electron/lib/manual-annot.js` | 手动标注本地存储层（`<userData>/annotations/<指纹>.json`） |
| `electron/preload.js` | 暴露 `api.*`（含 `listManualAnnots` / `saveManualAnnots` / `writeManualAnnotsToPdf` / `removeManualAnnotsFromPdf`） |
| `src/js/viewer.js` | PDF 渲染 + 注记层统一绘制入口 `_paintAllAnnotations()`、视图状态快照/还原 |
| `src/js/app.js` | 入口装配；增量刷新 `refreshAnnotationsIncremental`、忙遮罩、标注工具栏 |
| `src/js/chat.js` | 讨论与 AI 注记写回；`pdf-dirty` 带受影响的页码数组 |
| `src/js/manual-annot.js` | 渲染层手动标注状态机（4 类型 × 6 色、编辑气泡、写回 PDF） |
| `scripts/make-icon.js` | 手工生成多尺寸 ICO（绕开 Pillow 缺陷） |
| `scripts/push-via-api.js` | `git push` 不通时的兜底：走 GitHub REST API 推送 HEAD 并打标签 |
| `scripts/selftest.js` / `selftest-manual.js` / `check-icon.js` | 主自测 42 项 / 手动标注自测 28 项 / exe 图标校验 |
| `build/icon.ico` | 应用图标（由 `make-icon.js` 生成，勿手工改） |
| `README.md` | 完整架构、功能、下载章节、版本号规则 |

## 8. 版本历史

| 版本 | 日期 | 要点 |
| --- | --- | --- |
| `alpha-20260829` | 2026-08-29 | 性能优化（注记写回增量刷新）+ 手动标注（4 类型 × 6 色）+ 图标修复 + NSIS 安装包 |
| `alpha-20260830` | 2026-08-30 | 新增 `AGENTS.md` 交接说明书；清理残留临时文件并补 `.gitignore`（文档版本，无二进制变更） |
| `alpha-20260830a` | 2026-08-30 | 新增 `scripts/push-via-api.js`（代理只放行 api.github.com 时的推送兜底），并同步 `AGENTS.md` |

## 9. 版本更新时同步本文件（硬性要求）

**每次发版都必须同步更新 `AGENTS.md`**，且文档更新与代码改动放进**同一笔 commit**，防止文档与实现脱节。至少检查并更新：

1. 顶部的「最后更新」日期与版本号；
2. §8 版本历史表 —— 追加一行（版本 / 日期 / 要点）；
3. §4 发版流程 —— 若版本号规则或发版步骤有变；
4. §5 架构红线 —— 若新增了容易被改坏的设计约束；
5. §6 已知天坑 —— 若本次踩了新坑（**这是本文件最有价值的部分，务必记录**）；
6. §7 目录速查 —— 若新增 / 删除 / 重命名了源文件。

## 10. 交接说明

- 若由 **WorkBuddy 在同一工作区（`D:\workbuddy`）**续接：工作区记忆 `D:\workbuddy\.workbuddy\memory\MEMORY.md` 与每日日志（`.workbuddy/memory/YYYY-MM-DD.md`）另有补充细节，新会话会自动加载 `MEMORY.md`。
- 若移交**其他 AI 产品**：以本 `AGENTS.md` + `README.md` + 仓库代码为准，无需额外口述。
