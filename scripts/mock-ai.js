/**
 * 本地 mock OpenAI 服务，用于在无真实 API Key 的情况下验证整条对话链路：
 * 上下文组装 → 流式 SSE 解析 → 渲染 → 落库 → 写进笔记。
 *
 * 它会把「自己实际收到了什么」回显出来，便于断言上下文构造是否正确。
 */
const http = require('http');

function createMockServer() {
  const received = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = String(req.url || '');

      if (url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model-1' }, { id: 'mock-model-2' }] }));
        return;
      }

      if (!url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        body = {};
      }

      const messages = body.messages || [];
      const sys = String(messages[0]?.content || '');
      const last = messages[messages.length - 1];
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content || '');

      received.push({ body, sys, lastText });

      const summary =
        `MOCK_REPLY` +
        `|model=${body.model || '-'}` +
        `|hasSystem=${sys.length > 0}` +
        `|msgCount=${messages.length}` +
        `|hasPageMark=${/<<<PAGE \d+>>>/.test(lastText)}` +
        `|hasQuestion=${/我的问题/.test(lastText)}` +
        `|hasQuote=${/该处原文|我正在阅读/.test(lastText)}` +
        `|lastLen=${lastText.length}`;

      const full = `这是模拟回答。${summary}\n\n- 第一点：结论先行\n- 第二点：依据【第 1 页 第 1 行】\n\n公式示例 $E=mc^2$。`;

      if (body.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: full } }],
            usage: { prompt_tokens: 123, completion_tokens: 45 }
          })
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      // 按 4 字符切块，模拟真实打字机流
      const pieces = [];
      for (let i = 0; i < full.length; i += 4) pieces.push(full.slice(i, i + 4));
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 123, completion_tokens: 45 }
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i] } }] })}\n\n`
        );
        i++;
      }, 8);
    });
  });

  return {
    server,
    received,
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createMockServer };
