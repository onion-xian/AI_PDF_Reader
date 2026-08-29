/**
 * 文档库与会话存储。
 *
 * {userData}/library.json                 -> 文档索引（hash -> meta）
 * {userData}/conversations/<hash>.json    -> 该文档的会话列表
 *
 * 指纹策略：文件名 + 体积 + 头部 64KB 做 sha256，取前 16 位。
 * 这样文件被移动/重命名后仍能匹配到同一份笔记，且不用全量哈希大部头。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[store] read failed', file, e.message);
  }
  return fallback;
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function fileHash(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(Math.min(stat.size, 65536));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const h = crypto.createHash('sha256');
  h.update(path.basename(filePath));
  h.update(String(stat.size));
  h.update(buf);
  return h.digest('hex').slice(0, 16);
}

class Store {
  constructor(userData) {
    this.userData = userData;
    this.libraryFile = path.join(userData, 'library.json');
    this.convDir = path.join(userData, 'conversations');
    fs.mkdirSync(this.convDir, { recursive: true });
    this.library = readJSON(this.libraryFile, {});
  }

  convFile(hash) {
    return path.join(this.convDir, `${hash}.json`);
  }

  saveLibrary() {
    writeJSON(this.libraryFile, this.library);
  }

  /**
   * 定位文档记录。
   *
   * 关键：写注记会改写 PDF 字节，文件指纹会变。因此优先按路径命中并**复用原指纹**，
   * 只有路径没命中时才重新计算指纹（覆盖文件被移动/重命名的情况）。
   * 这样笔记文件与 PDF 内注记里的 file 参数在整个生命周期内保持一致。
   */
  upsertDoc(filePath, extra = {}) {
    const now = new Date().toISOString();
    const fileName = path.basename(filePath);
    const norm = String(filePath).replace(/\\/g, '/').toLowerCase();

    // 1) 路径命中 —— 复用原 hash
    let meta = Object.values(this.library).find(
      (m) => String(m.filePath || '').replace(/\\/g, '/').toLowerCase() === norm
    );

    // 2) 指纹命中 —— 文件被移动或重命名过
    if (!meta) {
      let hash = null;
      try {
        hash = fileHash(filePath);
      } catch {
        hash = null;
      }
      if (hash && this.library[hash]) meta = this.library[hash];
      else if (hash) {
        meta = {
          hash,
          filePath,
          fileName,
          title: extra.title || fileName.replace(/\.pdf$/i, ''),
          pageCount: extra.pageCount ?? null,
          createdAt: now,
          updatedAt: now
        };
        this.library[hash] = meta;
        this.saveLibrary();
        return meta;
      }
    }

    if (!meta) {
      // 3) 兜底：无法计算指纹时以路径派生一个稳定 key
      const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
      meta = {
        hash,
        filePath,
        fileName,
        title: extra.title || fileName.replace(/\.pdf$/i, ''),
        pageCount: extra.pageCount ?? null,
        createdAt: now,
        updatedAt: now
      };
      this.library[hash] = meta;
      this.saveLibrary();
      return meta;
    }

    meta.filePath = filePath;
    meta.fileName = fileName;
    if (extra.title) meta.title = extra.title;
    if (extra.pageCount != null) meta.pageCount = extra.pageCount;
    meta.updatedAt = now;
    this.saveLibrary();
    return meta;
  }

  getDoc(hash) {
    return this.library[hash] || null;
  }

  listDocs() {
    return Object.values(this.library).sort(
      (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
    );
  }

  removeDoc(hash) {
    delete this.library[hash];
    this.saveLibrary();
    try {
      fs.rmSync(this.convFile(hash), { force: true });
    } catch {
      /* ignore */
    }
  }

  loadConversations(hash) {
    return readJSON(this.convFile(hash), []);
  }

  saveConversations(hash, list) {
    writeJSON(this.convFile(hash), list);
  }

  /** 由会话 ID 反查所属文档（供 aidiscuss:// 深链使用） */
  findConversation(convId, hintHash) {
    const candidates = hintHash && this.library[hintHash] ? [hintHash] : Object.keys(this.library);
    for (const hash of candidates) {
      const list = this.loadConversations(hash);
      const conv = list.find((c) => c.id === convId);
      if (conv) return { hash, meta: this.library[hash], conversation: conv };
    }
    // 兜底：全量扫
    if (hintHash) {
      for (const hash of Object.keys(this.library)) {
        const list = this.loadConversations(hash);
        const conv = list.find((c) => c.id === convId);
        if (conv) return { hash, meta: this.library[hash], conversation: conv };
      }
    }
    return null;
  }
}

module.exports = { Store, fileHash };
