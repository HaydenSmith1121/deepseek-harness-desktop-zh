'use strict';

/**
 * 通用小工具。全部为纯函数或纯工具，便于单测。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 把任意值安全地转成 JSON 字符串，循环引用与 BigInt 也不会抛错。 */
function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return `${val}n`;
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, 2);
  } catch {
    return String(value);
  }
}

/** 去掉 ANSI 颜色控制符，日志面板里显示更干净。 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

/** 把流式 chunk 切成完整行，返回 { lines, rest }。 */
function splitLines(buffer, chunk) {
  const text = buffer + chunk;
  const parts = text.split(/\r?\n/);
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

function isFileSync(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirSync(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 原子写文件：先写临时文件再 rename，避免进程被杀时留下半个文件。 */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 毫秒级等待。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 URL 里安全地取出端口与 token。 */
function parseHarnessUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl).trim());
    const token = url.searchParams.get('token');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return {
      href: url.href,
      origin: url.origin,
      host: url.hostname,
      port,
      token: token || null,
    };
  } catch {
    return null;
  }
}

/** 把字节数格式化成人类可读文本。 */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** 解析形如 --flag "a b" 'c' 的附加参数串。 */
function parseArgString(text) {
  if (!text || !String(text).trim()) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/**
 * 判断一组参数是否可以被安全地交给 shell 执行（用于 Windows 上必须走
 * shell 的 npx 回退路径）。出现 shell 元字符时直接拒绝，避免注入。
 */
const SHELL_UNSAFE_RE = /[&|;<>()$`^"'\\\r\n\t]/;
function isShellSafeArgs(args) {
  return Array.isArray(args) && args.every((arg) => !SHELL_UNSAFE_RE.test(String(arg)));
}

module.exports = {
  safeStringify,
  stripAnsi,
  splitLines,
  isFileSync,
  isDirSync,
  writeFileAtomic,
  readJsonSync,
  delay,
  parseHarnessUrl,
  formatBytes,
  parseArgString,
  isShellSafeArgs,
};
