/**
 * 冒烟测试：启动 Electron，捕获主进程/渲染进程日志，验证自定义协议与前端模块加载。
 * 用法：node scripts/smoke.js [seconds]
 */
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
let electronBin;
try {
  electronBin = require('electron');
} catch (e) {
  console.error('未找到 electron，请先 npm install');
  process.exit(1);
}

const seconds = Number(process.argv[2]) || 14;
const mode = process.argv[3] || 'gui'; // gui | probe

const env = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: '1',
  ELECTRON_DISABLE_SANDBOX: '1'
};
// 宿主环境注入该变量会让 Electron 退化成纯 Node，必须清除
delete env.ELECTRON_RUN_AS_NODE;

const args = [root];
if (mode === 'probe') {
  // 注入一段脚本：等待前端初始化完成，把结果写到 stdout
  args.push(`--probe`);
}

console.log(`[smoke] electron = ${electronBin}`);
const child = spawn(electronBin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });

const collect = [];
child.stdout.on('data', (d) => {
  const s = String(d);
  collect.push(s);
  process.stdout.write(`[out] ${s}`);
});
child.stderr.on('data', (d) => {
  const s = String(d);
  collect.push(s);
  process.stdout.write(`[err] ${s}`);
});

child.on('error', (e) => {
  console.error('[smoke] spawn error:', e);
  process.exit(1);
});

setTimeout(() => {
  child.kill();
  const all = collect.join('');
  const fatal = /Uncaught|UnhandledPromiseRejection|Error: Cannot find module|Failed to load|net::ERR/i.test(all);
  console.log('\n===== 冒烟结果 =====');
  console.log(fatal ? '发现疑似错误，请检查上方日志' : '未发现致命错误日志');
  console.log('====================');
  process.exit(0);
}, seconds * 1000);
