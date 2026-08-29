/**
 * 启动入口。
 * 某些宿主环境会注入 ELECTRON_RUN_AS_NODE=1（用于让 require('electron') 返回可执行文件路径），
 * 该变量会让 Electron 退化成纯 Node 运行主进程，这里显式清除。
 */
const path = require('path');
const { spawn } = require('child_process');

let electronBin;
try {
  electronBin = require('electron');
} catch {
  console.error('未找到 electron，请先执行 npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const root = path.join(__dirname, '..');
const child = spawn(electronBin, [root], { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
