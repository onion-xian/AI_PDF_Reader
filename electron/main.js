/**
 * AI PDF Reader —— Electron 主进程
 *
 * 职责：
 *  - 通过自定义 app:// 协议提供前端资源（标准 scheme，ESM 可用）
 *  - 文件/笔记/会话/注记的本地读写
 *  - AI 流式对话与联网检索（放在主进程，避免渲染进程 CORS 与 Key 暴露）
 *  - aidiscuss:// 深链：外部阅读器点击 PDF 注记可唤起本应用并恢复对话
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { Config } = require('./lib/config');
const { Store } = require('./lib/store');
const { Notes } = require('./lib/notes');
const { writeAnnotation, removeAnnotation } = require('./lib/annotations');
const { chatStream, listModels, normalizeBaseURL } = require('./lib/ai-client');
const { webSearch, formatSourcesForPrompt } = require('./lib/search');

const APP_ROOT = path.join(__dirname, '..');
const PROTO_SCHEME = 'app';
const PROTO_HOST = 'local';
const DEEP_LINK_PROTO = 'aidiscuss';

let win = null;
let config = null;
let store = null;
let notes = null;
let pendingDeepLink = null;
const abortControllers = new Map(); // requestId -> AbortController

// ---------------------------------------------------------------- 协议
function registerProtocols() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PROTO_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
        stream: true
      }
    }
  ]);
}

function handleAppProtocol(request) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (!pathname || pathname === '/' || pathname.endsWith('/')) {
    pathname = pathname ? `${pathname}src/index.html` : '/src/index.html';
  }
  const filePath = path.normalize(path.join(APP_ROOT, pathname));
  if (!filePath.startsWith(APP_ROOT)) {
    return new Response('Forbidden', { status: 403 });
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return new Response('Not Found', { status: 404 });
  }
  return net.fetch(pathToFileURL(filePath).toString());
}

// ---------------------------------------------------------------- 深链
function parseDeepLink(raw) {
  if (!raw) return null;
  const m = /^aidiscuss:\/\/conv\/([^/?#]+)(?:\?([^#]*))?/i.exec(String(raw).trim());
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const params = new URLSearchParams(m[2] || '');
  return { convId: id, hash: params.get('file') || '', raw };
}

function dispatchDeepLink(payload) {
  if (!payload) return;
  if (win && win.webContents) {
    win.webContents.send('app:deepLink', payload);
    if (win.isMinimized()) win.restore();
    win.focus();
    win.show();
  } else {
    pendingDeepLink = payload;
  }
}

function scanArgv(argv) {
  if (!Array.isArray(argv)) return null;
  const hit = argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${DEEP_LINK_PROTO}://`));
  return parseDeepLink(hit);
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1080,
    minHeight: 680,
    title: 'AI PDF Reader',
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  // 自测模式：PDFAI_AUTOTEST 指向一个 PDF 时，启动后自动打开并跑渲染侧用例
  const qs = [];
  if (process.env.PDFAI_AUTOTEST) qs.push(`autotest=${encodeURIComponent(process.env.PDFAI_AUTOTEST)}`);
  if (process.env.PDFAI_MOCK_PORT) qs.push(`mockport=${encodeURIComponent(process.env.PDFAI_MOCK_PORT)}`);
  const entry = `${PROTO_SCHEME}://${PROTO_HOST}/src/index.html${qs.length ? `?${qs.join('&')}` : ''}`;
  win.loadURL(entry);

  win.once('ready-to-show', () => win.show());

  win.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      win.webContents.send('app:deepLink', pendingDeepLink);
      pendingDeepLink = null;
    }
  });

  win.on('closed', () => {
    win = null;
  });

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const p = await pickPdf();
            if (p) win?.webContents.send('app:openFile', p);
          }
        },
        {
          label: '打开笔记文件夹',
          click: () => shell.openPath(path.join(app.getPath('userData'), 'notes'))
        },
        { type: 'separator' },
        { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('app:menu', 'settings') },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => win?.webContents.send('app:menu', 'zoom-in') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => win?.webContents.send('app:menu', 'zoom-out') },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => win?.webContents.send('app:menu', 'zoom-reset') },
        { type: 'separator' },
        { label: '切换主题', click: () => win?.webContents.send('app:menu', 'toggle-theme') },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'reload', label: '重新加载' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 AI PDF Reader',
              message: 'AI PDF Reader',
              detail: `版本 ${app.getVersion()}\n面向论文与专业书籍的 AI 辅助阅读器。\n\n数据目录：${app.getPath('userData')}`
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function pickPdf() {
  const res = await dialog.showOpenDialog(win, {
    title: '选择 PDF 文档',
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
}

// ---------------------------------------------------------------- IPC
function setupIPC() {
  // ---- 配置
  ipcMain.handle('config:get', () => config.get());
  ipcMain.handle('config:set', (_e, patch) => config.set(patch));
  ipcMain.handle('app:paths', () => ({
    userData: app.getPath('userData'),
    notes: path.join(app.getPath('userData'), 'notes')
  }));

  // ---- 文件
  ipcMain.handle('dialog:openPdf', pickPdf);

  ipcMain.handle('fs:readPdf', async (_e, filePath) => {
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
      const buf = fs.readFileSync(filePath);
      return { ok: true, data: new Uint8Array(buf), name: path.basename(filePath) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('fs:showInFolder', (_e, filePath) => {
    if (fs.existsSync(filePath)) shell.showItemInFolder(filePath);
    else shell.openPath(path.dirname(filePath));
  });

  // ---- 文档库
  ipcMain.handle('library:open', (_e, filePath, extra) => {
    try {
      if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
      const meta = store.upsertDoc(filePath, extra);
      return { ok: true, meta, conversations: store.loadConversations(meta.hash) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('library:list', () => store.listDocs());
  ipcMain.handle('library:get', (_e, hash) => store.getDoc(hash));
  ipcMain.handle('library:remove', (_e, hash) => {
    store.removeDoc(hash);
    return true;
  });
  ipcMain.handle('library:update', (_e, hash, patch) => {
    const meta = store.getDoc(hash);
    if (!meta) return null;
    Object.assign(meta, patch, { updatedAt: new Date().toISOString() });
    store.saveLibrary();
    return meta;
  });

  // ---- 会话
  ipcMain.handle('conv:save', (_e, hash, list) => {
    store.saveConversations(hash, list);
    return true;
  });

  ipcMain.handle('conv:syncNote', (_e, hash, list) => {
    const meta = store.getDoc(hash);
    if (!meta) return { ok: false, error: '文档不存在' };
    try {
      const p = notes.write(meta, list);
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('conv:find', (_e, convId, hintHash) => {
    const hit = store.findConversation(convId, hintHash);
    if (!hit) return null;
    return {
      hash: hit.hash,
      meta: hit.meta,
      conversation: hit.conversation,
      conversations: store.loadConversations(hit.hash)
    };
  });

  // ---- 笔记
  ipcMain.handle('notes:read', (_e, hash) => notes.read(hash));
  ipcMain.handle('notes:path', (_e, hash) => notes.notePath(hash));

  ipcMain.handle('notes:export', async (_e, hash, suggestedName) => {
    const meta = store.getDoc(hash);
    const content = notes.read(hash);
    if (!content) return { ok: false, error: '笔记为空' };
    const res = await dialog.showSaveDialog(win, {
      title: '导出笔记',
      defaultPath: suggestedName || `${(meta?.title || 'notes').replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, path: res.filePath };
  });

  // ---- 区域截图（供扫描件提问使用）
  ipcMain.handle('capture:region', async (_e, rect) => {
    if (!win || win.webContents.isDestroyed()) return '';
    try {
      const r = {
        x: Math.max(0, Math.round(rect?.x || 0)),
        y: Math.max(0, Math.round(rect?.y || 0)),
        width: Math.max(1, Math.round(rect?.width || 1)),
        height: Math.max(1, Math.round(rect?.height || 1))
      };
      const image = await win.webContents.capturePage(r);
      return image.toPNG().toString('base64');
    } catch (e) {
      console.error('[main] capturePage failed:', e);
      return '';
    }
  });

  // ---- 注记
  ipcMain.handle('annot:write', async (_e, opts) => {
    const cfg = config.get();
    return writeAnnotation({
      ...opts,
      backup: cfg.backupBeforeAnnotate !== false,
      backupDir: path.join(app.getPath('userData'), 'backups')
    });
  });

  ipcMain.handle('annot:remove', async (_e, opts) => {
    const cfg = config.get();
    return removeAnnotation({
      ...opts,
      backup: cfg.backupBeforeAnnotate !== false,
      backupDir: path.join(app.getPath('userData'), 'backups')
    });
  });

  // ---- 联网检索
  ipcMain.handle('search:web', async (_e, query) => {
    return webSearch(config.get().search, query);
  });

  // ---- 模型列表
  ipcMain.handle('ai:models', async () => {
    try {
      return await listModels(config.get().ai);
    } catch (e) {
      return [];
    }
  });

  // ---- AI 对话（流式，事件回推）
  ipcMain.on('ai:chat', async (event, payload) => {
    const id = payload?.requestId;
    if (!id) return;
    const controller = new AbortController();
    abortControllers.set(id, controller);
    const send = (channel, data) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { ...data, requestId: id });
    };

    try {
      const cfg = config.get();
      const result = await chatStream({
        cfg: { ...cfg.ai, ...(payload.overrides || {}) },
        messages: payload.messages,
        signal: controller.signal,
        onDelta: (delta) => send('ai:chunk', { delta }),
        onUsage: (usage) => send('ai:usage', { usage })
      });
      send('ai:done', { content: result.content, reasoning: result.reasoning, usage: result.usage });
    } catch (e) {
      if (e && e.name === 'AbortError') send('ai:aborted', {});
      else send('ai:error', { message: e?.message || String(e) });
    } finally {
      abortControllers.delete(id);
    }
  });

  ipcMain.on('ai:abort', (_e, requestId) => {
    const c = abortControllers.get(requestId);
    if (c) c.abort();
  });

  ipcMain.handle('ai:testConnection', async () => {
    const cfg = config.get();
    try {
      await chatStream({
        cfg: cfg.ai,
        messages: [{ role: 'user', content: 'ping' }],
        onDelta: () => {}
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---- 杂项
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });
}

// ---------------------------------------------------------------- 生命周期
const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const payload = scanArgv(argv);
    if (payload) dispatchDeepLink(payload);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      win.show();
    }
  });

  registerProtocols();

  app.whenReady().then(() => {
    protocol.handle(PROTO_SCHEME, handleAppProtocol);

    // 自测时把数据目录指到临时目录，避免污染真实配置与笔记
    if (process.env.PDFAI_USER_DATA) {
      app.setPath('userData', process.env.PDFAI_USER_DATA);
    }

    config = new Config(app.getPath('userData'));
    store = new Store(app.getPath('userData'));
    notes = new Notes(app.getPath('userData'));

    if (process.platform !== 'darwin') {
      try {
        app.setAsDefaultProtocolClient(DEEP_LINK_PROTO);
      } catch (e) {
        console.warn('[main] 注册自定义协议失败：', e.message);
      }
    }

    setupIPC();
    createWindow();

    // 冷启动时通过注记唤起
    const boot = scanArgv(process.argv);
    if (boot) dispatchDeepLink(boot);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // macOS: aidiscuss:// 通过 open-url 送达
  app.on('open-url', (_e, url) => {
    const payload = parseDeepLink(url);
    if (payload) dispatchDeepLink(payload);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
