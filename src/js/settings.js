/**
 * 设置抽屉 + 上下文范围气泡
 * 所有改动即时写回 settings.json，无需点保存。
 */
import { $, el, toast } from './utils.js';

const SCOPES = [
  { id: 'around', label: '选中位置前后 N 页', hint: '默认。围绕你选中的地方取文，兼顾相关性与成本。' },
  { id: 'selection', label: '仅选中所在页', hint: '只看当前页，最省 token。' },
  { id: 'cursor', label: '仅当前阅读页', hint: '以左侧正在看的那一页为准。' },
  { id: 'range', label: '指定页码范围', hint: '自己填起止页，适合章节级讨论。' },
  { id: 'whole', label: '整篇文档', hint: '仍受 token 上限约束，超了会自动截断。' }
];

export class SettingsPanel {
  constructor({ getConfig, onChange }) {
    this.getConfig = getConfig;
    this.onChange = onChange || (() => {});
    this.drawer = $('#settingsDrawer');
    this.mask = $('#drawerMask');
    this.cfg = null;

    this.mask.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.drawer.classList.contains('hidden')) this.close();
    });
  }

  open() {
    this.cfg = JSON.parse(JSON.stringify(this.getConfig()));
    this.render();
    this.drawer.classList.remove('hidden');
    this.mask.classList.remove('hidden');
  }

  close() {
    this.drawer.classList.add('hidden');
    this.mask.classList.add('hidden');
  }

  _patch(path, value) {
    // 按 a.b.c 路径写回并保存
    const parts = path.split('.');
    const patch = {};
    let node = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    window.api.setConfig(patch).then((fresh) => {
      this.cfg = JSON.parse(JSON.stringify(fresh));
      this.onChange(fresh);
    });
  }

  render() {
    const cfg = this.cfg;
    const d = this.drawer;
    d.innerHTML = '';

    // ---------- 头
    const head = el('div', { class: 'drawer-head' }, [
      el('span', { text: '设置' }),
      el('button', {
        class: 'icon-btn sm',
        html: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>',
        onclick: () => this.close()
      })
    ]);
    d.appendChild(head);

    const body = el('div', { class: 'drawer-body' });

    // ================= AI 模型 =================
    body.appendChild(el('div', { class: 'form-section', style: { borderTop: 'none', marginTop: '0', paddingTop: '0' } }, [
      el('div', { class: 'form-section-title', text: 'AI 模型' }),

      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: '服务商（OpenAI 兼容）' }),
        el('select', {
          class: 'form-select',
          onchange: (e) => {
            const p = cfg.providers.find((x) => x.id === e.target.value);
            this._patch('ai.provider', e.target.value);
            if (p && p.id !== 'custom') {
              this._patch('ai.baseURL', p.baseURL);
              this._patch('ai.model', p.model);
              this._patch('ai.supportsVision', !!p.vision);
              this.cfg.ai.baseURL = p.baseURL;
              this.cfg.ai.model = p.model;
              this.cfg.ai.supportsVision = !!p.vision;
              this.render();
              toast(`已切换到 ${p.name}，请填写 API Key`, 'info', 2600);
            } else {
              this.render();
            }
          }
        }, cfg.providers.map((p) =>
          el('option', { value: p.id, selected: cfg.ai.provider === p.id, text: p.name })
        ))
      ]),

      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [
          el('label', { class: 'form-label', text: 'Base URL' }),
          el('input', {
            class: 'form-input',
            value: cfg.ai.baseURL || '',
            placeholder: 'https://api.deepseek.com/v1',
            onchange: (e) => this._patch('ai.baseURL', e.target.value.trim())
          })
        ]),
        el('div', { class: 'form-group' }, [
          el('label', { class: 'form-label', text: '模型名' }),
          el('input', {
            class: 'form-input',
            value: cfg.ai.model || '',
            placeholder: 'deepseek-chat',
            onchange: (e) => this._patch('ai.model', e.target.value.trim())
          })
        ])
      ]),

      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: 'API Key' }),
        el('input', {
          class: 'form-input',
          type: 'password',
          value: cfg.ai.apiKey || '',
          placeholder: 'sk-…（只保存在本机）',
          onchange: (e) => this._patch('ai.apiKey', e.target.value.trim())
        }),
        el('div', { class: 'form-hint', text: '密钥保存在本机 userData/settings.json，不会上传任何第三方。' })
      ]),

      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: `随机性 temperature：${cfg.ai.temperature}` }),
        el('div', { class: 'range-row' }, [
          el('input', {
            type: 'range', min: '0', max: '1.2', step: '0.05', value: String(cfg.ai.temperature),
            oninput: (e) => {
              const v = Number(e.target.value);
              this._patch('ai.temperature', v);
              e.target.previousElementSibling && (e.target.previousElementSibling.textContent = '');
              const lbl = d.querySelector('#tempVal');
              if (lbl) lbl.textContent = v.toFixed(2);
            }
          }),
          el('span', { class: 'range-val', id: 'tempVal', text: Number(cfg.ai.temperature).toFixed(2) })
        ]),
        el('div', { class: 'form-hint', text: '论文精读建议 0.1–0.3，越低越严谨、越少发挥。' })
      ]),

      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: '单次最大输出 token' }),
        el('input', {
          class: 'form-input', type: 'number', min: '256', max: '32768', step: '256',
          value: String(cfg.ai.maxOutputTokens || 4096),
          onchange: (e) => this._patch('ai.maxOutputTokens', Number(e.target.value) || 4096)
        })
      ]),

      el('div', { class: 'switch-row' }, [
        el('span', { text: '模型支持识图（区域截图提问需要）' }),
        el('label', { class: 'switch' }, [
          el('input', {
            type: 'checkbox',
            checked: !!cfg.ai.supportsVision,
            onchange: (e) => this._patch('ai.supportsVision', e.target.checked)
          }),
          el('i')
        ])
      ]),

      el('div', { class: 'switch-row' }, [
        el('span', { text: '流式输出（打字机效果）' }),
        el('label', { class: 'switch' }, [
          el('input', {
            type: 'checkbox',
            checked: cfg.ai.stream !== false,
            onchange: (e) => this._patch('ai.stream', e.target.checked)
          }),
          el('i')
        ])
      ])
    ]));

    // ================= 联网检索 =================
    body.appendChild(el('div', { class: 'form-section' }, [
      el('div', { class: 'form-section-title', text: '联网检索' }),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: '检索服务' }),
        el('select', {
          class: 'form-select',
          onchange: (e) => {
            this._patch('search.provider', e.target.value);
            this.cfg.search.provider = e.target.value;
            this.render();
          }
        }, [
          el('option', { value: 'tavily', selected: cfg.search.provider === 'tavily', text: 'Tavily（推荐，AI 专用搜索）' }),
          el('option', { value: 'bocha', selected: cfg.search.provider === 'bocha', text: '博查 AI 搜索（中文结果好）' })
        ])
      ]),
      el('div', { class: 'form-group' }, [
        el('label', {
          class: 'form-label',
          text: cfg.search.provider === 'bocha' ? '博查 API Key' : 'Tavily API Key'
        }),
        el('input', {
          class: 'form-input', type: 'password',
          value: cfg.search.provider === 'bocha' ? (cfg.search.bochaKey || '') : (cfg.search.tavilyKey || ''),
          placeholder: cfg.search.provider === 'bocha' ? 'sk-…' : 'tvly-…',
          onchange: (e) => this._patch(
            cfg.search.provider === 'bocha' ? 'search.bochaKey' : 'search.tavilyKey',
            e.target.value.trim()
          )
        })
      ]),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: `每轮返回条数：${cfg.search.maxResults}` }),
        el('div', { class: 'range-row' }, [
          el('input', {
            type: 'range', min: '3', max: '10', step: '1', value: String(cfg.search.maxResults || 5),
            oninput: (e) => {
              const v = Number(e.target.value);
              this._patch('search.maxResults', v);
              const lbl = d.querySelector('#resVal');
              if (lbl) lbl.textContent = String(v);
            }
          }),
          el('span', { class: 'range-val', id: 'resVal', text: String(cfg.search.maxResults || 5) })
        ])
      ]),
      el('div', { class: 'switch-row' }, [
        el('span', { text: '检索时带上 PDF 选区作为背景' }),
        el('label', { class: 'switch' }, [
          el('input', {
            type: 'checkbox', checked: cfg.search.includeSelectionContext !== false,
            onchange: (e) => this._patch('search.includeSelectionContext', e.target.checked)
          }),
          el('i')
        ])
      ])
    ]));

    // ================= 上下文预算 =================
    body.appendChild(el('div', { class: 'form-section' }, [
      el('div', { class: 'form-section-title', text: 'PDF 上下文预算' }),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: `送入正文的 token 上限：${Number(cfg.context.maxTokens).toLocaleString()}` }),
        el('div', { class: 'range-row' }, [
          el('input', {
            type: 'range', min: '1000', max: '100000', step: '500', value: String(cfg.context.maxTokens || 12000),
            oninput: (e) => {
              const v = Number(e.target.value);
              this._patch('context.maxTokens', v);
              const lbl = d.querySelector('#tokVal');
              if (lbl) lbl.textContent = v.toLocaleString();
              const hint = d.querySelector('#tokHint');
              if (hint) hint.textContent = tokenHint(v);
            }
          }),
          el('span', { class: 'range-val', id: 'tokVal', text: Number(cfg.context.maxTokens || 12000).toLocaleString() })
        ]),
        el('div', { class: 'form-hint', id: 'tokHint', text: tokenHint(cfg.context.maxTokens) })
      ]),

      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: '取文范围' }),
        ...SCOPES.map((s) =>
          el('div', {
            class: 'pop-opt' + (cfg.context.scope === s.id ? ' active' : ''),
            style: { padding: '7px 8px', alignItems: 'flex-start' },
            onclick: () => {
              this._patch('context.scope', s.id);
              this.cfg.context.scope = s.id;
              this.render();
            }
          }, [
            el('span', { class: 'po-dot' }),
            el('div', {}, [
              el('div', { text: s.label, style: { fontSize: '12px' } }),
              el('div', { class: 'form-hint', text: s.hint, style: { marginTop: '2px' } })
            ])
          ])
        )
      ]),

      cfg.context.scope === 'around'
        ? el('div', { class: 'form-group' }, [
            el('label', { class: 'form-label', text: `前后各取 ${cfg.context.aroundPages} 页` }),
            el('div', { class: 'range-row' }, [
              el('input', {
                type: 'range', min: '0', max: '10', step: '1', value: String(cfg.context.aroundPages ?? 2),
                oninput: (e) => {
                  const v = Number(e.target.value);
                  this._patch('context.aroundPages', v);
                  const lbl = d.querySelector('#aroundVal');
                  if (lbl) lbl.textContent = String(v);
                }
              }),
              el('span', { class: 'range-val', id: 'aroundVal', text: String(cfg.context.aroundPages ?? 2) })
            ])
          ])
        : null,

      cfg.context.scope === 'range'
        ? el('div', { class: 'form-row' }, [
            el('div', { class: 'form-group' }, [
              el('label', { class: 'form-label', text: '起始页' }),
              el('input', {
                class: 'form-input', type: 'number', min: '1', value: String(cfg.context.rangeFrom || 1),
                onchange: (e) => this._patch('context.rangeFrom', Number(e.target.value) || 1)
              })
            ]),
            el('div', { class: 'form-group' }, [
              el('label', { class: 'form-label', text: '结束页' }),
              el('input', {
                class: 'form-input', type: 'number', min: '1', value: String(cfg.context.rangeTo || 1),
                onchange: (e) => this._patch('context.rangeTo', Number(e.target.value) || 1)
              })
            ])
          ])
        : null
    ]));

    // ================= 提示词 =================
    body.appendChild(el('div', { class: 'form-section' }, [
      el('div', { class: 'form-section-title', text: '系统提示词' }),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: 'PDF 上下文模式' }),
        el('textarea', {
          class: 'form-textarea',
          value: cfg.prompts.contextSystem,
          onchange: (e) => this._patch('prompts.contextSystem', e.target.value)
        })
      ]),
      el('div', { class: 'form-group' }, [
        el('label', { class: 'form-label', text: '联网检索模式' }),
        el('textarea', {
          class: 'form-textarea',
          value: cfg.prompts.webSystem,
          onchange: (e) => this._patch('prompts.webSystem', e.target.value)
        })
      ])
    ]));

    // ================= 其它 =================
    body.appendChild(el('div', { class: 'form-section' }, [
      el('div', { class: 'form-section-title', text: '其它' }),
      el('div', { class: 'switch-row' }, [
        el('span', { text: '写入 PDF 注记前自动备份原文件' }),
        el('label', { class: 'switch' }, [
          el('input', {
            type: 'checkbox', checked: cfg.backupBeforeAnnotate !== false,
            onchange: (e) => this._patch('backupBeforeAnnotate', e.target.checked)
          }),
          el('i')
        ])
      ]),
      el('div', { class: 'switch-row' }, [
        el('span', { text: '聊天内容渲染 Markdown' }),
        el('label', { class: 'switch' }, [
          el('input', {
            type: 'checkbox', checked: cfg.ui.renderMarkdown !== false,
            onchange: (e) => this._patch('ui.renderMarkdown', e.target.checked)
          }),
          el('i')
        ])
      ]),
      el('div', { class: 'form-group', style: { marginTop: '12px' } }, [
        el('div', { class: 'form-hint', id: 'pathsHint', text: '加载中…' })
      ])
    ]));

    d.appendChild(body);

    // ---------- 底栏
    const testResult = el('span', { class: 'test-result' });
    const foot = el('div', { class: 'drawer-foot' }, [
      testResult,
      el('button', {
        class: 'mini-btn', text: '打开数据目录',
        onclick: async () => {
          const p = await window.api.getPaths();
          window.api.showInFolder(p.notes);
        }
      }),
      el('button', {
        class: 'primary-btn sm', text: '测试连接',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          testResult.className = 'test-result';
          testResult.textContent = '正在测试…';
          const r = await window.api.aiTest();
          btn.disabled = false;
          testResult.className = `test-result ${r.ok ? 'ok' : 'err'}`;
          testResult.textContent = r.ok ? '✓ 连接成功' : `✗ ${r.error}`;
        }
      })
    ]);
    d.appendChild(foot);

    // 数据目录
    window.api.getPaths().then((p) => {
      const hint = d.querySelector('#pathsHint');
      if (hint) hint.textContent = `笔记目录：${p.notes}`;
    });
  }
}

function tokenHint(v) {
  const n = Number(v);
  if (n <= 4000) return '很省，适合单页内的细节问答。';
  if (n <= 12000) return '平衡点：约覆盖 8–20 页中文正文。';
  if (n <= 30000) return '较宽：适合跨章节综述类提问，费用明显上升。';
  return '很宽：长文档整体理解，单次成本较高，注意余额。';
}

/** 上下文范围气泡（点击 ctx-chip 弹出） */
export class ScopePopover {
  constructor({ getConfig, onChange, viewer }) {
    this.el = $('#scopePopover');
    this.getConfig = getConfig;
    this.onChange = onChange;
    this.viewer = viewer;

    document.addEventListener('click', (e) => {
      if (!this.el.classList.contains('hidden') && !this.el.contains(e.target)) this.hide();
    });
  }

  toggle(anchorEl) {
    if (!this.el.classList.contains('hidden')) return this.hide();
    this.render();
    const r = anchorEl.getBoundingClientRect();
    this.el.classList.remove('hidden');
    let left = r.left;
    let top = r.bottom + 6;
    if (left + this.el.offsetWidth > window.innerWidth - 10) left = window.innerWidth - this.el.offsetWidth - 10;
    this.el.style.left = `${Math.max(8, left)}px`;
    this.el.style.top = `${top}px`;
  }

  hide() {
    this.el.classList.add('hidden');
  }

  render() {
    const cfg = this.getConfig().context;
    const elRef = this.el;
    elRef.innerHTML = '';
    elRef.appendChild(el('div', { class: 'pop-title', text: '送入 AI 的正文范围' }));

    for (const s of SCOPES) {
      elRef.appendChild(
        el('div', {
          class: 'pop-opt' + (cfg.scope === s.id ? ' active' : ''),
          onclick: () => {
            window.api.setConfig({ context: { scope: s.id } }).then((fresh) => {
              this.onChange(fresh);
              this.render();
            });
          }
        }, [el('span', { class: 'po-dot' }), el('span', { text: s.label })])
      );
    }

    elRef.appendChild(el('div', { class: 'pop-sep' }));

    if (cfg.scope === 'around') {
      elRef.appendChild(
        el('div', { class: 'pop-range' }, [
          el('span', { text: '±', style: { fontSize: '11px', color: 'var(--text-2)' } }),
          el('input', {
            type: 'range', min: '0', max: '10', step: '1', value: String(cfg.aroundPages ?? 2),
            oninput: (e) => {
              const v = Number(e.target.value);
              elRef.querySelector('#pvVal').textContent = String(v);
              window.api.setConfig({ context: { aroundPages: v } }).then((f) => this.onChange(f));
            }
          }),
          el('span', { id: 'pvVal', text: String(cfg.aroundPages ?? 2) }),
          el('span', { text: '页', style: { fontSize: '11px', color: 'var(--text-2)' } })
        ])
      );
    }

    if (cfg.scope === 'range') {
      const total = this.viewer.numPages || 1;
      elRef.appendChild(
        el('div', { class: 'pop-inline' }, [
          el('span', { text: '第' }),
          el('input', {
            type: 'number', min: '1', max: String(total), value: String(cfg.rangeFrom || 1),
            onchange: (e) => {
              const v = Math.max(1, Math.min(total, Number(e.target.value) || 1));
              window.api.setConfig({ context: { rangeFrom: v } }).then((f) => this.onChange(f));
            }
          }),
          el('span', { text: '–' }),
          el('input', {
            type: 'number', min: '1', max: String(total), value: String(cfg.rangeTo || 1),
            onchange: (e) => {
              const v = Math.max(1, Math.min(total, Number(e.target.value) || 1));
              window.api.setConfig({ context: { rangeTo: v } }).then((f) => this.onChange(f));
            }
          }),
          el('span', { text: `页 / 共 ${total}` })
        ])
      );
    }

    elRef.appendChild(el('div', { class: 'pop-sep' }));
    elRef.appendChild(
      el('div', { class: 'pop-range' }, [
        el('span', { text: '上限', style: { fontSize: '11px', color: 'var(--text-2)' } }),
        el('input', {
          type: 'range', min: '1000', max: '60000', step: '500', value: String(cfg.maxTokens || 12000),
          oninput: (e) => {
            const v = Number(e.target.value);
            elRef.querySelector('#ptVal').textContent = `${(v / 1000).toFixed(1)}k`;
            window.api.setConfig({ context: { maxTokens: v } }).then((f) => this.onChange(f));
          }
        }),
        el('span', { id: 'ptVal', style: { minWidth: '34px' }, text: `${((cfg.maxTokens || 12000) / 1000).toFixed(1)}k` })
      ])
    );
    elRef.appendChild(
      el('div', { class: 'form-hint', style: { padding: '2px 8px 0' }, text: tokenHint(cfg.maxTokens) })
    );
  }
}
