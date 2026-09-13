/**
 * 准备"应用内置的 dsh 运行时"：vendor/dsh/
 *
 *   npm run fetch:dsh              拉取默认版本
 *   node scripts/fetch-dsh.mjs --version 0.1.5-rc.2
 *   node scripts/fetch-dsh.mjs --if-missing   已存在就跳过（CI 缓存友好）
 *
 * 产物结构（自包含，不依赖用户环境里的任何全局安装）：
 *   vendor/dsh/package.json         只声明 @deepseek-ai/dsh 依赖
 *   vendor/dsh/node_modules/...     含全部依赖
 *
 * 为什么用"壳项目 + 完整依赖"而不是只拷贝 @deepseek-ai/dsh 一个包：
 * dsh 有 70+ 个运行时依赖，只拷主包会得到一堆 Cannot find module。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'dsh');
const DEFAULT_VERSION = '0.1.5-rc.1';

function parseArgs(argv) {
  const args = { version: DEFAULT_VERSION, ifMissing: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version' && argv[i + 1]) args.version = argv[++i];
    else if (argv[i] === '--if-missing') args.ifMissing = true;
  }
  return args;
}

function entryPath() {
  return path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function installedVersion() {
  const file = path.join(VENDOR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));

if (fs.existsSync(entryPath())) {
  const current = installedVersion();
  if (args.ifMissing || current === args.version) {
    process.stdout.write(`内置 dsh 已就绪：v${current}（vendor/dsh）\n`);
    process.exit(0);
  }
}

fs.mkdirSync(VENDOR, { recursive: true });
fs.writeFileSync(
  path.join(VENDOR, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-bundled-runtime',
      private: true,
      description: 'DeepSeek Harness 桌面端内置的 dsh 运行时（构建期生成，不纳入版本库）',
      dependencies: { '@deepseek-ai/dsh': args.version },
    },
    null,
    2,
  )}\n`,
);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
process.stdout.write(`正在拉取 @deepseek-ai/dsh@${args.version} 到 vendor/dsh …\n`);

const result = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: VENDOR,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.stderr.write(`\n拉取失败（exit ${result.status}）。国内网络可先设置镜像：\n  npm config set registry https://registry.npmmirror.com\n\n`);
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(entryPath())) {
  process.stderr.write(`依赖装好了，但没找到入口：${entryPath()}\n`);
  process.exit(1);
}

process.stdout.write(`\n内置 dsh 就绪：v${installedVersion()} → ${path.relative(ROOT, entryPath()).replace(/\\/g, '/')}\n`);
