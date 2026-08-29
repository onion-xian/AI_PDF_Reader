/**
 * 渲染进程唯一入口：contextBridge 暴露受控 API。
 * 渲染侧拿不到 Node 与任何 Key 之外的能力，所有敏感操作都在主进程完成。
 */
const { contextBridge, ipcRenderer } = require('electron');
const TokenUtils = require('./lib/tokens.js');

const EVENTS = [
  'ai:chunk',
  'ai:done',
  'ai:error',
  'ai:aborted',
  'ai:usage',
  'app:deepLink',
  'app:openFile',
  'app:menu'
];

contextBridge.exposeInMainWorld('api', {
  // ---------- 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  getPaths: () => ipcRenderer.invoke('app:paths'),

  // ---------- 文件 / 文档库
  openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
  readPdf: (filePath) => ipcRenderer.invoke('fs:readPdf', filePath),
  showInFolder: (filePath) => ipcRenderer.invoke('fs:showInFolder', filePath),
  openLibrary: (filePath, extra) => ipcRenderer.invoke('library:open', filePath, extra),
  listLibrary: () => ipcRenderer.invoke('library:list'),
  getDoc: (hash) => ipcRenderer.invoke('library:get', hash),
  updateDoc: (hash, patch) => ipcRenderer.invoke('library:update', hash, patch),
  removeDoc: (hash) => ipcRenderer.invoke('library:remove', hash),

  // ---------- 会话 / 笔记
  saveConversations: (hash, list) => ipcRenderer.invoke('conv:save', hash, list),
  syncNote: (hash, list) => ipcRenderer.invoke('conv:syncNote', hash, list),
  findConversation: (convId, hintHash) => ipcRenderer.invoke('conv:find', convId, hintHash),
  readNote: (hash) => ipcRenderer.invoke('notes:read', hash),
  notePath: (hash) => ipcRenderer.invoke('notes:path', hash),
  exportNote: (hash, name) => ipcRenderer.invoke('notes:export', hash, name),

  // ---------- 注记
  writeAnnotation: (opts) => ipcRenderer.invoke('annot:write', opts),
  removeAnnotation: (opts) => ipcRenderer.invoke('annot:remove', opts),

  // ---------- 手动注记（本地存储 + 按需写回 PDF）
  listManualAnnots: (hash) => ipcRenderer.invoke('manualAnnot:list', hash),
  saveManualAnnots: (hash, items) => ipcRenderer.invoke('manualAnnot:save', hash, items),
  writeManualAnnotsToPdf: (opts) => ipcRenderer.invoke('manualAnnot:writeToPdf', opts),
  removeManualAnnotsFromPdf: (opts) => ipcRenderer.invoke('manualAnnot:removeFromPdf', opts),

  // ---------- 联网检索
  webSearch: (query) => ipcRenderer.invoke('search:web', query),

  // ---------- AI
  aiChat: (payload) => ipcRenderer.send('ai:chat', payload),
  aiAbort: (requestId) => ipcRenderer.send('ai:abort', requestId),
  aiModels: () => ipcRenderer.invoke('ai:models'),
  aiTest: () => ipcRenderer.invoke('ai:testConnection'),

  // ---------- 其它
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  captureRegion: (rect) => ipcRenderer.invoke('capture:region', rect),

  // ---------- 事件订阅，返回取消函数
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) throw new Error(`不允许订阅该频道: ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});

// token 估算 / 上下文截断（主进程与渲染进程共用同一份实现）
contextBridge.exposeInMainWorld('TokenUtils', {
  estimateTokens: TokenUtils.estimateTokens,
  estimateMessages: TokenUtils.estimateMessages,
  buildContext: TokenUtils.buildContext
});
