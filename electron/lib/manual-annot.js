/**
 * 手动注记存储层。
 *
 * {userData}/annotations/<hash>.json
 *
 * 与 AI 会话注记（conversations/<hash>.json）分开存放：
 * 两者生命周期不同——会话注记跟随讨论，手动注记跟随阅读行为，
 * 混在一起会让"写回 PDF"时的幂等处理变得复杂。
 *
 * 数据形状：
 *   { version: 1, items: [ ManualItem, ... ] }
 *
 * ManualItem:
 *   {
 *     id:        string  唯一 id
 *     type:      'highlight' | 'underline' | 'strikeout' | 'note'
 *     color:     'yellow'|'green'|'blue'|'pink'|'purple'|'orange'
 *     page:      number  1-based
 *     rects:     [{x,y,w,h}] CSS 坐标（scale=1），与 AI 注记同一坐标系
 *     quote:     string  被标注的原文
 *     note:      string  批注内容（type='note' 时才有意义）
 *     createdAt: ISO 字符串
 *     updatedAt: ISO 字符串
 *   }
 */
const fs = require('fs');
const path = require('path');

const VERSION = 1;

const TYPES = ['highlight', 'underline', 'strikeout', 'note'];
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange'];

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[manual-annot] read failed:', file, e.message);
  }
  return fallback;
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 归一化单条注记，过滤掉结构损坏的项（手工编辑过 JSON 时可能发生） */
function normalize(item) {
  if (!item || typeof item !== 'object') return null;
  if (!TYPES.includes(item.type)) return null;
  if (!Array.isArray(item.rects) || !item.rects.length) return null;
  const page = Number(item.page);
  if (!Number.isFinite(page) || page < 1) return null;

  const rects = item.rects
    .map((r) => ({
      x: Number(r?.x),
      y: Number(r?.y),
      w: Number(r?.w),
      h: Number(r?.h)
    }))
    .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite));
  if (!rects.length) return null;

  const now = new Date().toISOString();
  return {
    id: String(item.id || ''),
    type: item.type,
    color: COLORS.includes(item.color) ? item.color : 'yellow',
    page,
    rects,
    quote: String(item.quote || ''),
    note: String(item.note || ''),
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now
  };
}

class ManualAnnotations {
  constructor(userData) {
    this.dir = path.join(userData, 'annotations');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(hash) {
    return path.join(this.dir, `${String(hash)}.json`);
  }

  list(hash) {
    const d = readJSON(this.file(hash), { version: VERSION, items: [] });
    const items = Array.isArray(d.items) ? d.items : [];
    return items.map(normalize).filter(Boolean);
  }

  save(hash, items) {
    const clean = (Array.isArray(items) ? items : []).map(normalize).filter(Boolean);
    writeJSON(this.file(hash), { version: VERSION, items: clean });
    return clean.length;
  }
}

module.exports = { ManualAnnotations, TYPES, COLORS, normalize };
