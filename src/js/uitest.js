/**
 * 渲染进程自测（仅在 URL 带 ?autotest=<pdf路径> 时加载）
 * 验证文本层抽取、行号定位、坐标转换、注记几何计算——这些只有真跑起来才测得准。
 */

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`[UITEST] ${cond ? 'PASS' : 'FAIL'} :: ${name}${extra ? ` :: ${extra}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runUiTest(app, pdfPath) {
  console.log('[UITEST] ==== 开始渲染侧自测 ====');
  console.log(`[UITEST] 测试文件：${pdfPath}`);

  let lines = [];
  try {
    await app.openFile(pdfPath);
    // 等待渲染与文本抽取
    for (let i = 0; i < 60 && !app.viewer.isFullyExtracted(); i++) await wait(500);

    // ---------- 1. 文档加载
    check('文档已打开', !!app.doc, app.doc ? app.doc.fileName : 'null');
    check('页数为 5', app.viewer.numPages === 5, String(app.viewer.numPages));
    check('页面占位 DOM 已建立', app.viewer.pageWraps.length === 5);
    check('标题栏已更新', document.getElementById('docTitle').textContent.includes('sample'));

    // ---------- 2. 文本抽取与行号
    lines = app.viewer.getPageLines(1);
    check('第 1 页抽取出 30 行', lines.length === 30, `实际 ${lines.length}`);
    check('第 1 行内容正确', /Page 1 Line 1\b/.test(lines[0]?.text || ''), lines[0]?.text);
    check('第 30 行内容正确', /Line 30/.test(lines[29]?.text || ''), lines[29]?.text);
    check('行号连续递增', lines.every((l, i) => l.no === i + 1));
    check(
      '行纵坐标自上而下递增',
      lines.every((l, i) => i === 0 || l.rect.y >= lines[i - 1].rect.y - 1)
    );
    check('第 2 页文本正确', /Page 2 Line 5\b/.test(app.viewer.getPageText(2)));
    check('全部 5 页已抽取', app.viewer.isFullyExtracted());

    // ---------- 3. CSS -> PDF 坐标转换（A4：595 x 842）
    const [lx, ly] = await app.viewer.cssToPdf(1, 0, 0);
    check('左上角映射正确', Math.abs(lx) < 1 && Math.abs(ly - 842) < 1, `(${lx.toFixed(1)}, ${ly.toFixed(1)})`);
    const [rx, ry] = await app.viewer.cssToPdf(1, 595, 842);
    check('右下角映射正确', Math.abs(rx - 595) < 1 && Math.abs(ry) < 1, `(${rx.toFixed(1)}, ${ry.toFixed(1)})`);
    const [cx, cy] = await app.viewer.cssToPdf(1, 297.5, 421);
    check('中心点映射正确', Math.abs(cx - 297.5) < 1 && Math.abs(cy - 421) < 1, `(${cx.toFixed(1)}, ${cy.toFixed(1)})`);

    // ---------- 4. 选区解析（矩形 -> 行号）
    const l1 = lines[0];
    const parsedOne = app.selection.resolveRects(1, [l1.rect]);
    check('单行矩形定位到行号 1', parsedOne.lineStart === 1, `lineStart=${parsedOne.lineStart}`);
    check('单行矩形起止行一致', parsedOne.lineStart === 1 && parsedOne.lineEnd === 1);

    const l5 = lines[4];
    const l8 = lines[7];
    const multi = app.selection.resolveRects(1, [l5.rect, l8.rect]);
    check('多行矩形定位起始行 5', multi.lineStart === 5, `lineStart=${multi.lineStart}`);
    check('多行矩形定位结束行 8', multi.lineEnd === 8, `lineEnd=${multi.lineEnd}`);
    check('多行矩形取回了原文', /Line 5/.test(multi.quote) && /Line 8/.test(multi.quote), multi.quote.slice(0, 90));

    // ---------- 4b. 用「真实 CSS 坐标」构造选区（最接近用户实际操作）
    // 测试 PDF：A4(595x842)，第 i 行绘制在 PDF y = 800 - 22*(i-1)，字号 11
    const rectForLine = (i) => {
      const cssBaseline = 842 - (800 - 22 * (i - 1));
      return { x: 50, y: cssBaseline - 10, w: 350, h: 14 };
    };
    const pA = app.selection.resolveRects(1, [rectForLine(1)]);
    check('CSS 选区定位到第 1 行', pA.lineStart === 1, `lineStart=${pA.lineStart}`);
    const pB = app.selection.resolveRects(1, [rectForLine(5)]);
    check('CSS 选区定位到第 5 行', pB.lineStart === 5, `lineStart=${pB.lineStart}`);
    const pC = app.selection.resolveRects(1, [rectForLine(30)]);
    check('CSS 选区定位到第 30 行', pC.lineStart === 30, `lineStart=${pC.lineStart}`);
    const pMulti = app.selection.resolveRects(1, [rectForLine(3), rectForLine(6)]);
    check('CSS 多选区行号区间正确', pMulti.lineStart === 3 && pMulti.lineEnd === 6,
      `${pMulti.lineStart}-${pMulti.lineEnd}`);
    check('行矩形已在 CSS 空间（y 自上而下递增）',
      lines[0].rect.y < lines[29].rect.y,
      `L1.y=${lines[0].rect.y.toFixed(1)} L30.y=${lines[29].rect.y.toFixed(1)}`);

    // ---------- 5. 注记几何计算
    const geom = await app.viewer.cssRectsToAnnotGeom(1, [lines[2].rect]);
    check('注记几何生成成功', !!geom);
    const [gx1, gy1, gx2, gy2] = geom.rect;
    check('注记 Rect 落在页面内', gx1 >= -1 && gy1 >= -1 && gx2 <= 596 && gy2 <= 843,
      JSON.stringify(geom.rect.map((n) => Number(n.toFixed(1)))));
    check('注记 Rect 有效（右>左，上>下）', gx2 > gx1 && gy2 > gy1);
    check('QuadPoints 为 8 的倍数', geom.quadPoints.length % 8 === 0, String(geom.quadPoints.length));
    check('QuadPoints 至少一组', geom.quadPoints.length >= 8);

    // ---------- 6. 会话与笔记
    const conv = app.chat.newConversation(null, 'context');
    check('新建会话成功', !!conv && !!conv.id);
    conv.anchor = {
      page: 1,
      lineStart: parsedOne.lineStart,
      lineEnd: parsedOne.lineEnd,
      quote: parsedOne.quote,
      rects: [parsedOne.rects[0]],
      union: parsedOne.union
    };
    conv.messages.push({ role: 'user', content: '测试问题' });
    conv.conclusion = '测试结论';
    app.chat.persist();

    await wait(300);
    const note = await window.api.readNote(app.doc.hash);
    check('笔记 Markdown 已生成', note.length > 100, `${note.length} 字符`);
    check('笔记含位置信息', /第 1 页 第 1 行/.test(note));
    check('笔记含讨论内容', /测试问题/.test(note));
    check('笔记含结论', /测试结论/.test(note));

    // ---------- 7. 上下文构建（不联网也能验算 token）
    const est = app.chat.estimateContextTokens();
    check('上下文 token 估算有效', est.tokens > 0, JSON.stringify(est));
    const collected = app.chat._collectPages(conv);
    check('按范围取到了正文页', collected.pages.length >= 1, `pages=${collected.pages.length}`);
    const built = window.TokenUtils.buildContext(collected.pages, 1, 12000);
    check('上下文正文非空', built.text.length > 0);
    check('上下文不超上限', built.tokens <= 12000, String(built.tokens));

    // ---------- 8. 注记写回 PDF（真实文件写入）
    const before = await app.viewer.cssRectsToAnnotGeom(1, [lines[3].rect]);
    const writeRes = await window.api.writeAnnotation({
      filePath: app.doc.filePath,
      convId: conv.id,
      hash: app.doc.hash,
      contents: '自测：这是一条讨论注记',
      items: [{ page: 1, rect: before.rect, quadPoints: before.quadPoints }]
    });
    check('注记写入 PDF 成功', writeRes.ok, writeRes.error || '');
    check('写入了 2 个注记', writeRes.count === 2, String(writeRes.count));

    conv.annotated = true;
    app.chat._renumberAnnotations();
    check('注记编号已分配', conv.annotNo === 1, String(conv.annotNo));

    // 重新加载 PDF，验证注记层能画出来
    await app.reloadPdf();
    await wait(1200);
    const marks = document.querySelectorAll('.annot-mark');
    check('页面上渲染出注记标记', marks.length >= 1, `marks=${marks.length}`);
    check('注记标记带会话 ID', marks[0] && marks[0].dataset.conv === conv.id);

    // ---------- 9. 移除注记
    const rm = await window.api.removeAnnotation({ filePath: app.doc.filePath, convId: conv.id });
    check('注记移除成功', rm.ok, rm.error || '');
    conv.annotated = false;
    conv.annotNo = null;
    app.chat._renumberAnnotations();
    app.refreshAnnotations();
    await app.reloadPdf();
    await wait(1200);
    // 注记已从 PDF 移除，但讨论本身还在——标记应降级为「未写入 PDF」样式并保留可点击
    const left = document.querySelectorAll('.annot-mark');
    check('讨论锚点标记仍保留（讨论未删除）', left.length === 1, `剩余 ${left.length} 个`);
    check('标记降级为未写入样式', left[0] && left[0].classList.contains('pending'),
      left[0] ? left[0].className : 'none');
    check('编号旗标已移除', left[0] && !left[0].querySelector('.annot-flag'));

    // 删除整轮讨论后，标记应彻底消失
    app.chat.deleteConversation(conv.id);
    await wait(300);
    check('删除讨论后标记消失', document.querySelectorAll('.annot-mark').length === 0,
      `剩余 ${document.querySelectorAll('.annot-mark').length} 个`);
  } catch (e) {
    check('测试执行无异常', false, e && e.stack ? e.stack : String(e));
  }

  // ---------- 10. AI 对话链路（接本地 mock 的 OpenAI 服务）
  const mockPort = new URLSearchParams(location.search).get('mockport');
  if (mockPort) {
    await testAiChain(app, mockPort, lines);
  } else {
    console.log('[UITEST] 跳过 AI 对话测试（未提供 mock 端口）');
  }

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`[UITEST] ==== 结束：${pass} 通过 / ${fail} 失败 ====`);
  console.log('[UITEST] DONE');
  return { pass, fail, results };
}

async function testAiChain(app, port, lines) {
  console.log('[UITEST] ---- AI 对话链路 ----');
  try {
    const cfg = await window.api.setConfig({
      ai: {
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: 'test-key',
        model: 'deepseek-chat',
        stream: true,
        temperature: 0.2,
        maxOutputTokens: 2048
      }
    });
    app.config = cfg;
    check('配置已切到 mock 服务', app.config.ai.baseURL.includes(`127.0.0.1:${port}`));

    // 新建一轮带锚点的讨论
    app.chat.setPendingAnchor(
      {
        page: 1,
        lineStart: 1,
        lineEnd: 2,
        quote: lines[0].text,
        rects: [lines[0].rect],
        union: lines[0].rect
      },
      'context'
    );
    const conv = app.chat.active;
    check('带着锚点建好了会话', !!conv && conv.anchor && conv.anchor.page === 1);
    check('模式为上下文', conv.mode === 'context');

    // ---------------- 完整一轮流式对话
    const input = document.getElementById('chatInput');
    input.value = '请解释这段内容在讲什么？';
    app.chat.submit();
    await wait(400);
    check('已进入流式状态', app.chat.streaming === true);

    const ended = await waitFor(() => app.chat.streaming === false, 30000);
    check('流式在超时前结束', ended, `streaming=${app.chat.streaming}`);

    const aiMsgs = conv.messages.filter((m) => m.role === 'assistant');
    check('AI 回复已落进会话', aiMsgs.length === 1, `共 ${aiMsgs.length} 条`);
    const reply = aiMsgs[0]?.content || '';
    check('回复内容非空', reply.length > 20, `${reply.length} 字符`);
    check('回复来自 mock 服务', /MOCK_REPLY/.test(reply), reply.slice(0, 80));
    check('PDF 正文确实送进了模型', /hasPageMark=true/.test(reply), reply.slice(0, 200));
    check('问题确实送进了模型', /hasQuestion=true/.test(reply));
    check('模型名传递正确', /model=deepseek-chat/.test(reply));
    check('用量已记录', !!aiMsgs[0].usage, JSON.stringify(aiMsgs[0].usage));

    const bubbles = document.querySelectorAll('#chatMessages .msg.ai');
    check('消息区渲染出 AI 气泡', bubbles.length >= 1, `${bubbles.length} 个`);
    check('气泡里渲染了 Markdown 列表', bubbles[0] && bubbles[0].querySelector('.md ul li'));
    check('页码引用被高亮', bubbles[0] && bubbles[0].querySelector('.page-ref'));

    // ---------------- 多轮：第二条提问应带上历史
    input.value = '再具体说说第二点？';
    app.chat.submit();
    await wait(400);
    await waitFor(() => app.chat.streaming === false, 30000);
    const second = conv.messages.filter((m) => m.role === 'assistant')[1];
    check('第二轮回复已落库', !!second, `共 ${conv.messages.filter((m) => m.role === 'assistant').length} 条`);
    check('第二轮带上了历史（msgCount>2）', /msgCount=[3-9]/.test(second?.content || ''), second?.content?.slice(0, 120));

    // ---------------- 笔记同步
    await wait(400);
    const note2 = await window.api.readNote(app.doc.hash);
    check('笔记含 AI 回复正文', /MOCK_REPLY/.test(note2));
    check('笔记含两轮问答', (note2.match(/Q\d（我）/g) || []).length >= 2,
      String((note2.match(/Q\d（我）/g) || []).length));
    check('笔记不含 base64 图片', !/data:image/.test(note2));

    // ---------------- 标记结论
    app.chat.markConclusion = () => {}; // 跳过 prompt 弹窗
    conv.conclusion = '这是测试结论：正文讲的是标准测试句';
    app.chat.persist();
    await wait(300);
    const note3 = await window.api.readNote(app.doc.hash);
    check('笔记含结论', /这是测试结论/.test(note3));

    // ---------------- 停止生成
    input.value = '这条应该被中断';
    app.chat.submit();
    await wait(600);
    if (app.chat.streaming) {
      app.chat.stop();
      const stopped = await waitFor(() => app.chat.streaming === false, 8000);
      check('停止生成后退出流式', stopped);
      const after = conv.messages.filter((m) => m.role === 'assistant');
      check('被中断的回复也已落库', after.length === 3, `共 ${after.length} 条`);
      check('中断标记已记录', after[2]?.aborted === true, JSON.stringify({ aborted: after[2]?.aborted }));
    } else {
      check('停止生成后退出流式', true, '流已自然结束，跳过');
    }

    // ---------------- 联网模式：未配置 Key 时应给出可读错误而非崩溃
    const webConv = app.chat.newConversation(null, 'web');
    webConv.anchor = { page: 1, lineStart: 1, quote: lines[0].text, rects: [lines[0].rect] };
    app.chat.setModeSilent('web');
    input.value = '联网模式测试';
    app.chat.submit();
    await wait(400);
    await waitFor(() => app.chat.streaming === false, 15000);
    const errBubble = document.querySelector('#chatMessages .msg.error');
    check('未配置检索 Key 时给出提示而非崩溃', !!errBubble,
      errBubble ? errBubble.textContent.slice(0, 90) : '未找到错误气泡');
    check('错误落到会话记录里',
      webConv.messages.some((m) => m.role === 'assistant' && m.error),
      JSON.stringify(webConv.messages.map((m) => m.role)));

    // 清理，避免影响后续断言
    app.chat.deleteConversation(webConv.id);
  } catch (e) {
    check('AI 链路执行无异常', false, e && e.stack ? e.stack : String(e));
  }
}

async function waitFor(pred, maxMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (pred()) return true;
    await wait(120);
  }
  return false;
}
