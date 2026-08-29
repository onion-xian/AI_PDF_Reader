/**
 * 渲染进程自测启动器。
 * 生成一份带文本层的测试 PDF，带 autotest 参数启动 Electron，收集 [UITEST] 日志。
 * 用法：node scripts/uitest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createMockServer } = require('./mock-ai');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfai-uitest-'));
const sample = path.join(TMP, 'sample.pdf');
const userData = path.join(TMP, 'userdata');

async function makeSample() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 5; p++) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (let l = 1; l <= 30; l++) {
      page.drawText(`Page ${p} Line ${l}: the quick brown fox jumps over the lazy dog.`, {
        x: 60,
        y,
        size: 11,
        font
      });
      y -= 22;
    }
  }
  fs.writeFileSync(sample, await doc.save());
  // 备份一份，注记写入测试会改动它
  fs.copyFileSync(sample, path.join(TMP, 'sample.orig.pdf'));
}

async function main() {
  await makeSample();
  console.log(`[uitest] 测试 PDF：${sample}`);

  // 起一个 mock 的 OpenAI 服务，让对话链路也能在无 Key 环境下被验证
  const mock = createMockServer();
  const port = await mock.listen();
  console.log(`[uitest] mock AI 服务：http://127.0.0.1:${port}/v1`);

  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    PDFAI_AUTOTEST: sample,
    PDFAI_USER_DATA: userData,
    PDFAI_MOCK_PORT: String(port)
  };
  delete env.ELECTRON_RUN_AS_NODE;

  // 沙箱/无显示环境下 GPU 进程会反复崩溃，强制走软件渲染
  const args = [
    root,
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-software-rasterizer',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=VizDisplayCompositor',
    '--force-device-scale-factor=1'
  ];

  const child = spawn(electronBin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let buf = '';
  const onData = (d) => {
    const s = String(d);
    buf += s;
    for (const line of s.split('\n')) {
      const t = line.trim();
      const idx = t.indexOf('[UITEST]');
      if (idx >= 0) {
        // 去掉 Electron 的 CONSOLE 前缀与结尾引号
        console.log(t.slice(idx).replace(/"$/, ''));
      } else if (/Uncaught|UnhandledPromiseRejection|renderer.*(Error|Failed)/i.test(t)) {
        console.log(`   ${t.slice(0, 220)}`);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  const timeout = setTimeout(() => {
    child.kill();
    finish(false);
  }, 120000);

  async function finish(done) {
    clearTimeout(timeout);
    await mock.close().catch(() => {});
    const m = /\[UITEST\] ==== 结束：(\d+) 通过 \/ (\d+) 失败 ====/.exec(buf);
    if (m) {
      console.log(`\n===== 渲染侧结果：${m[1]} 通过 / ${m[2]} 失败 =====`);
      console.log(`[uitest] mock 收到 ${mock.received.length} 次请求`);
      process.exit(Number(m[2]) === 0 ? 0 : 1);
    } else if (!done) {
      console.log('\n===== 渲染侧结果：未收到测试完成信号，超时 =====');
      process.exit(1);
    }
  }

  // 测试脚本自己会打印 DONE，这里留一点缓冲
  const poll = setInterval(() => {
    if (buf.includes('[UITEST] DONE')) {
      clearInterval(poll);
      setTimeout(() => {
        child.kill();
        finish(true);
      }, 800);
    }
  }, 500);
}

main().catch((e) => {
  console.error('[uitest] 异常：', e);
  process.exit(1);
});
