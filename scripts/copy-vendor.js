/**
 * 把 pdfjs-dist 的 ESM 构建复制到 vendor/pdfjs/。
 * 渲染进程通过自定义 app:// 协议加载（标准 scheme，ESM 可正常工作）。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'pdfjs-dist');
const src = path.join(pkg, 'build');
const dst = path.join(root, 'vendor', 'pdfjs');

function copyDir(from, to, label) {
  if (!fs.existsSync(from)) {
    console.warn('[copy-vendor] missing', label);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from)) {
    const s = path.join(from, f);
    if (fs.statSync(s).isFile()) {
      fs.copyFileSync(s, path.join(to, f));
      n++;
    }
  }
  console.log(`[copy-vendor] copied ${label} (${n} files)`);
}

function main() {
  if (!fs.existsSync(src)) {
    console.warn('[copy-vendor] 未找到 pdfjs-dist build，跳过。请先执行 npm install');
    return;
  }
  fs.mkdirSync(dst, { recursive: true });

  for (const f of ['pdf.mjs', 'pdf.worker.mjs']) {
    const s = path.join(src, f);
    if (fs.existsSync(s)) {
      fs.copyFileSync(s, path.join(dst, f));
      console.log('[copy-vendor] copied', f);
    } else {
      console.warn('[copy-vendor] missing', f);
    }
  }

  // CJK 编码 PDF / 未嵌入字体的 PDF 需要
  copyDir(path.join(pkg, 'cmaps'), path.join(dst, 'cmaps'), 'cmaps');
  copyDir(path.join(pkg, 'standard_fonts'), path.join(dst, 'standard_fonts'), 'standard_fonts');
}

main();
