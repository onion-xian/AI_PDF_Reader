#!/usr/bin/env node
/**
 * push-via-api.js —— 当 `git push` 因网络/代理不可用时，改用 GitHub API 推送。
 *
 * 背景：本机 git 走 https://github.com，某些代理只放行 api.github.com（对 github.com
 * 返回 502 CONNECT tunnel failed）。此时 git 协议完全不通，但 REST API 可用。
 *
 * 原理：把本地 HEAD 这一笔提交「重放」到远端 ——
 *   1) 取 HEAD 相对父提交的变更文件（A/M/D）
 *   2) 为新增/修改的文件创建 blob
 *   3) 以远端分支的 tree 为 base_tree 建新 tree
 *   4) 建 commit（沿用本地的提交信息、作者、提交者）
 *   5) 更新远端 ref，可选创建附注标签
 *   6) 同步本地 refs/remotes/origin/<branch>，避免远端跟踪分支长期偏离
 *
 * 用法：
 *   node scripts/push-via-api.js                        # 推送当前 HEAD 到 origin/main
 *   node scripts/push-via-api.js --tag alpha-20260830   # 并打附注标签
 *   node scripts/push-via-api.js --branch dev --dry-run # 演练，不写入远端
 *
 * 说明：只处理「单个普通提交」（非合并提交）。令牌取自本机 git 凭据管理器，用完不落盘。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';

// ---------- 参数 ----------
function parseArgs(argv) {
  const opts = { branch: 'main', tag: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag') opts.tag = argv[++i];
    else if (a === '--branch') opts.branch = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/push-via-api.js [--branch main] [--tag <版本号>] [--dry-run]');
      process.exit(0);
    }
  }
  return opts;
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitRaw(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
}

// ---------- 令牌 ----------
function getToken() {
  const out = execFileSync(
    'git',
    ['credential-manager', 'get'],
    { cwd: REPO_ROOT, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n', maxBuffer: 1 << 20 }
  );
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('未能从 git credential-manager 获取令牌');
  return m[1].trim();
}

// ---------- HTTP（走 curl，自动继承环境代理） ----------
function api(token, method, urlPath, body) {
  const args = [
    '-sS', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'Content-Type: application/json',
    '-w', '\nHTTP_STATUS:%{http_code}',
  ];
  let stdinBuf = null;
  if (body !== undefined) {
    stdinBuf = Buffer.from(JSON.stringify(body), 'utf8');
    args.push('--data-binary', '@-');
  }
  args.push(API + urlPath);

  const res = execFileSync('curl', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: stdinBuf,
    maxBuffer: 256 * 1024 * 1024,
  });

  const idx = res.lastIndexOf('\nHTTP_STATUS:');
  if (idx === -1) throw new Error('响应缺少 HTTP 状态码：' + res.slice(0, 300));
  const status = parseInt(res.slice(idx + '\nHTTP_STATUS:'.length).trim(), 10);
  const text = res.slice(0, idx);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status, json, text };
}

function assertOk(res, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what} 失败（HTTP ${res.status}）：${res.text.slice(0, 500)}`);
  }
  return res.json;
}

// ---------- 主流程 ----------
function main() {
  const opts = parseArgs(process.argv);

  // 仓库信息（从 origin 解析 owner/repo）
  const remoteUrl = git('remote', 'get-url', 'origin');
  const m = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(remoteUrl);
  if (!m) throw new Error('无法从 origin 解析仓库地址：' + remoteUrl);
  const owner = m[1];
  const repo = m[2];
  const repoPath = `/repos/${owner}/${repo}`;
  console.log(`仓库：${owner}/${repo}    分支：${opts.branch}${opts.tag ? '    标签：' + opts.tag : ''}`);

  // 本地 HEAD 信息
  const headSha = git('rev-parse', 'HEAD');
  const parentSha = git('rev-parse', 'HEAD^');
  const message = gitRaw('log', '-1', '--pretty=%B').toString('utf8').trim();
  const authorName = git('log', '-1', '--pretty=%an');
  const authorEmail = git('log', '-1', '--pretty=%ae');
  const committerName = git('log', '-1', '--pretty=%cn');
  const committerEmail = git('log', '-1', '--pretty=%ce');
  console.log(`本地提交：${headSha.slice(0, 7)}  ${message.split('\n')[0]}`);

  // 变更文件（A/M/D），路径可能含非 ASCII，用 -z 读取
  const statusOut = git('diff-tree', '--no-commit-id', '--name-status', '-r', '-z', 'HEAD');
  const parts = statusOut.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (st.length === 1 && 'AMD'.includes(st)) {
      changes.push({ status: st, path: parts[++i] });
    } else if (st.startsWith('R') || st.startsWith('C')) {
      // 重命名/复制：拆成 删除旧路径 + 新增新路径
      changes.push({ status: 'D', path: parts[++i] });
      changes.push({ status: 'A', path: parts[++i] });
    }
  }
  if (!changes.length) throw new Error('HEAD 没有文件变更，无需推送');
  console.log(`变更文件 ${changes.length} 个：`);
  for (const c of changes) console.log(`   ${c.status}  ${c.path}`);

  if (opts.dryRun) {
    console.log('\n[dry-run] 未写入远端。');
    return;
  }

  const token = getToken();
  console.log('令牌已获取。');

  // 远端当前状态
  const baseCommit = assertOk(api(token, 'GET', `${repoPath}/commits/${opts.branch}`), '读取远端分支');
  const baseTreeSha = baseCommit.commit.tree.sha;
  const remoteHead = baseCommit.sha;
  console.log(`远端 HEAD：${remoteHead.slice(0, 7)}`);

  // 创建 blob + 组装 tree
  const tree = [];
  for (const c of changes) {
    if (c.status === 'D') {
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const abs = path.join(REPO_ROOT, c.path);
    if (!fs.existsSync(abs)) throw new Error('文件不存在：' + c.path);
    const content = fs.readFileSync(abs).toString('base64');
    const blob = assertOk(
      api(token, 'POST', `${repoPath}/git/blobs`, { content, encoding: 'base64' }),
      `创建 blob ${c.path}`
    );
    const mode = fs.statSync(abs).mode & 0o111 ? '100755' : '100644';
    tree.push({ path: c.path, mode, type: 'blob', sha: blob.sha });
  }
  console.log(`已上传 ${tree.length} 个 blob。`);

  const newTree = assertOk(
    api(token, 'POST', `${repoPath}/git/trees`, { base_tree: baseTreeSha, tree }),
    '创建 tree'
  );

  const newCommit = assertOk(
    api(token, 'POST', `${repoPath}/git/commits`, {
      message,
      tree: newTree.sha,
      parents: [remoteHead],
      author: { name: authorName, email: authorEmail },
      committer: { name: committerName, email: committerEmail },
    }),
    '创建 commit'
  );
  console.log(`已创建提交：${newCommit.sha.slice(0, 7)}`);

  // 更新分支 ref
  assertOk(
    api(token, 'PATCH', `${repoPath}/git/refs/heads/${opts.branch}`, { sha: newCommit.sha }),
    `更新 refs/heads/${opts.branch}`
  );
  console.log(`已更新远端分支：${opts.branch} -> ${newCommit.sha.slice(0, 7)}`);

  // 附注标签
  if (opts.tag) {
    const tagObj = assertOk(
      api(token, 'POST', `${repoPath}/git/tags`, {
        tag: opts.tag,
        message: message.split('\n')[0],
        object: newCommit.sha,
        type: 'commit',
        tagger: { name: committerName, email: committerEmail },
      }),
      '创建标签对象'
    );
    const created = api(token, 'POST', `${repoPath}/git/refs`, {
      ref: `refs/tags/${opts.tag}`,
      sha: tagObj.sha,
    });
    if (created.status === 422) {
      console.log(`标签 ${opts.tag} 已存在，跳过创建。`);
    } else {
      assertOk(created, '创建标签引用');
      console.log(`已推送标签：${opts.tag} -> ${newCommit.sha.slice(0, 7)}`);
    }
  }

  // 同步本地远端跟踪分支（git fetch 走 github.com 可能不通，这里手动对齐）
  try {
    git('update-ref', `refs/remotes/origin/${opts.branch}`, newCommit.sha);
    console.log(`已同步本地 refs/remotes/origin/${opts.branch}`);
  } catch (e) {
    console.log('提示：本地远端跟踪分支未同步（' + e.message + '），可稍后手动 git fetch。');
  }

  // 本地 HEAD 与远端 sha 不一致（API 会生成新 sha），给出后续建议
  if (parentSha !== remoteHead) {
    console.log('\n注意：远端历史与本地不同源，建议稍后网络恢复后执行：');
    console.log('  git fetch origin && git reset --soft origin/' + opts.branch);
  }

  console.log('\n完成。');
}

main();
