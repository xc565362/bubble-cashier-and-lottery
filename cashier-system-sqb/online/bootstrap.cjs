'use strict';
const path = require('node:path');
const { createAuthStore } = require('./auth.cjs');

// Input comes from a protected pipe/file, never command-line arguments or a public HTTP setup endpoint.
async function main() {
  const directory = process.env.BUBBLE_ONLINE_DATA_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error('请设置 BUBBLE_ONLINE_DATA_DIR 绝对路径');
  if (process.stdin.isTTY) throw new Error('请通过标准输入传入管理员 JSON，避免密码进入命令行历史');
  let bytes = 0; const chunks = [];
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 8192) throw new Error('初始化内容过大'); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const auth = createAuthStore({ file: path.join(directory, 'accounts.sqlite') });
  try { await auth.createInitialAdmin(input); console.log('初始管理员已创建，密码不会显示。'); } finally { auth.close(); }
}
main().catch(() => { console.error('初始化失败：请检查输入格式、密码长度以及管理员是否已存在。'); process.exitCode = 1; });
