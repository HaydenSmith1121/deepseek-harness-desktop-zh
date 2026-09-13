'use strict';

/**
 * 运行时探测：定位 Node 解释器与 DeepSeek Harness（dsh）入口。
 *
 * 设计要点：
 * - 所有探测函数都接受注入的 { env, platform, home, execPath }，不依赖全局状态，
 *   因此可以在单元测试里用固定 fixture 覆盖 Windows / macOS / Linux 三套路径规则。
 * - 只做"读"操作，不安装、不修改用户环境。
 * - 回退顺序（runtimeMode=auto）：本机全局安装 → 应用内置副本 → npx。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { isFileSync, isDirSync, parseArgString } = require('./util');
const { findFreePort } = require('./ports');

/** DeepSeek Harness 要求 Node ≥ 22.19（依赖内置 zstd 解压会话日志）。 */
const MIN_NODE_VERSION = [22, 19, 0];
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';
const DSH_ENTRY_HINT = path.join('lib', 'bin.js');
/** npx 回退时锁定的版本，避免每次启动拉到不同版本导致行为漂移。 */
const NPX_FALLBACK_SPEC = '@deepseek-ai/dsh@0.1.5-rc.1';

function parseNodeVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i += 1) {
    const left = Number(a[i] ?? 0);
    const right = Number(b[i] ?? 0);
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function satisfiesMin(version, min = MIN_NODE_VERSION) {
  return !!version && compareVersions(version, min) >= 0;
}

function formatVersion(version) {
  return Array.isArray(version) ? version.join('.') : String(version ?? '未知');
}

/** 从 process.env 里大小写不敏感地取 PATH。 */
function getPathValue(env) {
  if (!env) return '';
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? String(env[key] ?? '') : '';
}

const WIN_EXEC_EXT = ['.exe', '.cmd', '.bat', ''];

/**
 * 同步 which：在 PATH 中查找可执行文件。
 * 不调用系统 which/where，避免 Windows 下 shell 解析与编码问题。
 * 路径拼接按「目标平台」而不是「宿主平台」进行，这样函数可以真正被参数化。
 */
function whichSync(command, { env = process.env, platform = process.platform, isFile = isFileSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = getPathValue(env).split(sep).filter(Boolean);
  const exts = platform === 'win32' && !path.win32.extname(command) ? WIN_EXEC_EXT : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 读取 dsh 包目录的元信息（版本号 + 真实入口文件）。
 * 也接受"自包含安装目录"——即一个只声明了 @deepseek-ai/dsh 依赖的壳项目，
 * 应用内置副本与 npm 全局目录都可能长这样。
 */
function readPackageMeta(packageDir, depth = 0) {
  if (!packageDir || !isDirSync(packageDir)) return null;
  const pkgFile = path.join(packageDir, 'package.json');
  if (!isFileSync(pkgFile)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch {
    return null;
  }
  const binPath = resolveBinPath(packageDir, pkg.bin);
  if (!binPath) {
    if (depth > 0) return null;
    return readPackageMeta(path.join(packageDir, 'node_modules', ...DSH_PACKAGE_NAME.split('/')), depth + 1);
  }
  return {
    dir: packageDir,
    name: pkg.name || DSH_PACKAGE_NAME,
    version: pkg.version || null,
    binPath,
  };
}

/** npm 的 bin 字段可能是字符串或对象，这里统一解析。 */
function resolveBinPath(packageDir, bin) {
  const candidates = [];
  if (typeof bin === 'string') candidates.push(path.resolve(packageDir, bin));
  else if (bin && typeof bin === 'object') {
    const preferred = bin.dsh ?? bin['deepseek-harness'] ?? Object.values(bin).find((value) => typeof value === 'string');
    if (typeof preferred === 'string') candidates.push(path.resolve(packageDir, preferred));
  }
  candidates.push(path.join(packageDir, DSH_ENTRY_HINT));
  return candidates.find((candidate) => isFileSync(candidate)) || null;
}

/** 把「用户填写的路径」归一化成 dsh 包目录。 */
function normalizeDshPath(input, { platform = process.platform } = {}) {
  const target = String(input || '').trim();
  if (!target) return null;
  const cleaned = target.replace(/^"|"$/g, '');

  if (isDirSync(cleaned)) {
    if (isFileSync(path.join(cleaned, 'package.json'))) return cleaned;
    const nested = path.join(cleaned, 'node_modules', ...DSH_PACKAGE_NAME.split('/'));
    if (isFileSync(path.join(nested, 'package.json'))) return nested;
    return cleaned;
  }

  if (isFileSync(cleaned)) {
    const lower = cleaned.toLowerCase();
    if (lower.endsWith('.js')) {
      // 指向 lib/bin.js：往上两级就是包目录
      return path.dirname(path.dirname(cleaned));
    }
    // 指向 dsh / dsh.cmd / dsh.exe 启动器：同级 node_modules 下就是包
    return path.join(path.dirname(cleaned), 'node_modules', ...DSH_PACKAGE_NAME.split('/'));
  }

  // 允许用户填一个不存在的目录，交给后续校验报错
  return platform === 'win32' ? path.win32.normalize(cleaned) : cleaned;
}

/** 候选包目录列表（按优先级）。 */
function dshPackageCandidates({ settings = {}, env = process.env, platform = process.platform, home, resourcesPath, appRoot, isPackaged = false } = {}) {
  const candidates = [];
  const push = (dir, source) => {
    if (!dir) return;
    const normalized = path.normalize(dir);
    if (!candidates.some((item) => item.dir === normalized)) candidates.push({ dir: normalized, source });
  };

  // 1. 显式配置 / 环境变量
  push(normalizeDshPath(settings.dshPath, { platform }) || null, 'setting');
  push(normalizeDshPath(env.DSH_DESKTOP_DSH_PATH || env.DSH_HARNESS_DIR || '', { platform }) || null, 'env');

  // 2. 从 PATH 上的 dsh 启动器反推（Windows 是 <prefix>\npm\dsh.cmd，POSIX 是 <prefix>/bin/dsh）
  const shim = whichSync('dsh', { env, platform });
  if (shim) {
    const dir = path.dirname(shim);
    if (platform === 'win32') {
      push(path.join(dir, 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
      push(path.join(dir, '..', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    } else {
      push(path.join(dir, 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
      push(path.join(dir, '..', 'lib', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    }
  }

  // 3. 各平台默认全局目录
  const userHome = home || env.USERPROFILE || env.HOME || '';
  if (platform === 'win32') {
    if (env.APPDATA) push(path.join(env.APPDATA, 'npm', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'npm', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    if (env.NVM_SYMLINK) push(path.join(env.NVM_SYMLINK, 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    if (env.ProgramFiles) push(path.join(env.ProgramFiles, 'nodejs', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
  } else {
    for (const prefix of ['/usr/local/lib', '/usr/lib', '/opt/homebrew/lib']) {
      push(path.join(prefix, 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    }
    if (userHome) {
      push(path.join(userHome, '.npm-global', 'lib', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
      push(path.join(userHome, '.local', 'share', 'npm', 'lib', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
      push(path.join(userHome, '.nvm', 'versions', 'node', 'node_modules', ...DSH_PACKAGE_NAME.split('/')), 'local');
    }
  }

  // 4. 从 node 解释器位置反推（nvm-windows / scoop / 便携版）
  const nodeBin = whichSync(platform === 'win32' ? 'node.exe' : 'node', { env, platform });
  if (nodeBin) {
    const nodeDir = path.dirname(nodeBin);
    for (const rel of [
      ['node_modules'],
      ['..', 'lib', 'node_modules'],
      ['..', '..', 'lib', 'node_modules'],
    ]) {
      push(path.join(nodeDir, ...rel, ...DSH_PACKAGE_NAME.split('/')), 'local');
    }
  }

  // 5. 应用内置副本（由 scripts/fetch-dsh.mjs 或 CI 准备）
  if (isPackaged && resourcesPath) push(path.join(resourcesPath, 'dsh'), 'bundled');
  if (appRoot) push(path.join(appRoot, 'vendor', 'dsh'), 'bundled');

  return candidates;
}

/** 解析出可用的 dsh 运行时。 */
function resolveDshRuntime(options = {}) {
  const { runtimeMode = 'auto' } = options.settings || {};
  const attempted = [];
  const candidates = dshPackageCandidates(options);
  const modeFiltered = candidates.filter((item) => {
    if (runtimeMode === 'auto' || runtimeMode === 'npx') return true;
    return item.source === runtimeMode;
  });

  for (const candidate of modeFiltered) {
    const meta = readPackageMeta(candidate.dir);
    attempted.push({ dir: candidate.dir, source: candidate.source, ok: !!meta });
    if (meta) {
      return { ...meta, source: candidate.source, attempted, available: attempted.filter((a) => a.ok) };
    }
  }

  const error = new Error(
    runtimeMode === 'local'
      ? '未在本机找到 DeepSeek Harness（dsh）。请执行 npm i -g @deepseek-ai/dsh，或在设置中指定 dsh 路径。'
      : '未找到可用的 DeepSeek Harness（dsh）运行时：本机未安装，且应用未内置副本。',
  );
  error.code = 'EDSHNOTFOUND';
  error.attempted = attempted;
  return { error, attempted, available: [] };
}

/** 探测某个 node 可执行文件的版本。 */
function probeNodeVersion(file, { timeout = 8000, electron = false, env = process.env } = {}) {
  return new Promise((resolve) => {
    if (!isFileSync(file)) return resolve(null);
    const childEnv = { ...env };
    if (electron) childEnv.ELECTRON_RUN_AS_NODE = '1';
    try {
      execFile(
        file,
        ['-v'],
        { timeout, windowsHide: true, env: childEnv },
        (error, stdout) => resolve(error ? null : parseNodeVersion(String(stdout))),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * 解析 Node 解释器：优先显式配置，其次 PATH，最后用 Electron 自带的 Node。
 * 返回第一个满足版本要求的候选。
 */
async function resolveNodeRuntime(options = {}) {
  const { settings = {}, env = process.env, platform = process.platform, execPath = process.execPath } = options;

  const list = [];
  const explicit = String(settings.nodePath || env.DSH_DESKTOP_NODE || '').trim();
  if (explicit) list.push({ source: 'setting', file: explicit.replace(/^"|"$/g, ''), electron: false });
  const onPath = whichSync(platform === 'win32' ? 'node.exe' : 'node', { env, platform });
  if (onPath) list.push({ source: 'path', file: onPath, electron: false });
  list.push({ source: 'electron', file: execPath, electron: true });

  const probed = [];
  for (const candidate of list) {
    if (!isFileSync(candidate.file)) {
      probed.push({ ...candidate, version: null, ok: false, reason: 'missing' });
      continue;
    }
    const version = await probeNodeVersion(candidate.file, { electron: candidate.electron, env });
    const ok = satisfiesMin(version);
    const record = { ...candidate, version, ok, reason: ok ? null : version ? 'outdated' : 'unusable' };
    probed.push(record);
    if (ok) return { ...record, probed, minVersion: MIN_NODE_VERSION };
  }

  const best = probed.find((item) => item.version) || probed[probed.length - 1];
  return { ...best, ok: false, probed, minVersion: MIN_NODE_VERSION };
}

/**
 * 生成 harness 子进程的启动参数。
 * 端口一定显式传给 dsh：这样 /api 的浏览器信任栅栏能拿到确定的 host:port，
 * 避免随机端口下出现"页面能开但接口 403"的隐性故障。
 */
function buildDshArgs({ host = '127.0.0.1', port = 0, extraArgs = '' } = {}) {
  const args = ['web', '--no-open', '--host', host, '--port', String(port)];
  if (port > 0) args.push('--trusted-host', `${host}:${port}`);
  const extra = parseArgString(extraArgs);
  if (extra.length) args.push(...extra);
  return args;
}

/**
 * 综合出最终启动计划。
 * @returns {Promise<{ok:boolean, plan?:object, error?:Error, diagnostics:object}>}
 */
async function buildLaunchPlan(options = {}) {
  const { settings = {}, isPackaged = false, execPath = process.execPath } = options;
  const diagnostics = {};

  const node = await resolveNodeRuntime(options);
  diagnostics.node = node;
  if (!node.ok) {
    const error = new Error(
      node.version
        ? `Node.js 版本过低（当前 v${formatVersion(node.version)}），DeepSeek Harness 需要 v${MIN_NODE_VERSION.join('.')} 或更高。`
        : '未找到可用的 Node.js 运行时（需要 v22.19 或更高）。',
    );
    error.code = 'ENODEVERSION';
    error.hint = '安装 Node.js 22.19+（推荐 v24 LTS），或在设置中手动指定 Node 路径。';
    return { ok: false, error, diagnostics };
  }

  const runtimeMode = settings.runtimeMode || 'auto';
  const dsh = runtimeMode === 'npx' ? { error: null, npxOnly: true, source: 'npx' } : resolveDshRuntime({ ...options, runtimeMode });
  diagnostics.dsh = dsh;

  if (dsh.error) {
    // auto 模式下本机没有装 dsh，最后再试一次 npx，让"空机器"也能跑起来
    if (runtimeMode === 'auto') {
      const fallback = buildNpxPlan({ settings, node, platform: options.platform, env: options.env });
      if (fallback.ok) {
        diagnostics.dsh = { source: 'npx', version: fallback.plan.dshVersion };
        return { ok: true, plan: fallback.plan, diagnostics, warnings: ['本机未安装 dsh，已改用 npx 临时拉取（需要网络）。'] };
      }
    }
    return { ok: false, error: dsh.error, diagnostics };
  }

  const host = settings.host || '127.0.0.1';
  const requestedPort = Number(settings.port) || 0;
  const port = requestedPort > 0 ? requestedPort : await findFreePort(host);

  if (runtimeMode === 'npx') {
    const npxPlan = buildNpxPlan({ settings, node, platform: options.platform, env: options.env });
    if (!npxPlan.ok) return { ok: false, error: npxPlan.error, diagnostics };
    npxPlan.plan.port = port;
    npxPlan.plan.host = host;
    return { ok: true, plan: npxPlan.plan, diagnostics };
  }

  const args = buildDshArgs({ host, port, extraArgs: settings.extraArgs });

  /** @type {any} */
  const plan = {
    kind: 'node',
    file: node.file,
    argv: [dsh.binPath, ...args],
    port,
    host,
    cwd: dsh.dir,
    env: {},
    source: dsh.source,
    shell: false,
    electron: !!node.electron,
    dshVersion: dsh.version,
    nodeVersion: node.version,
    isPackaged,
  };

  if (node.electron) plan.env.ELECTRON_RUN_AS_NODE = '1';
  return { ok: true, plan, diagnostics };
}

/** npx 回退计划（仅在自动/显式选择 npx 时使用）。 */
function buildNpxPlan({ settings = {}, node, platform = process.platform, env = process.env } = {}) {
  const npxBin = whichSync(platform === 'win32' ? 'npx' : 'npx', { env, platform });
  if (!npxBin) {
    const error = new Error('未找到 npx，无法通过 npm 拉取 DeepSeek Harness。');
    error.code = 'ENPXNOTFOUND';
    return { ok: false, error };
  }
  const host = settings.host || '127.0.0.1';
  const args = ['--yes', NPX_FALLBACK_SPEC, ...buildDshArgs({ host, port: Number(settings.port) || 0, extraArgs: settings.extraArgs })];
  return {
    ok: true,
    plan: {
      kind: 'command',
      file: npxBin,
      argv: args,
      source: 'npx',
      shell: platform === 'win32',
      env: {},
      electron: false,
      nodeVersion: node?.version || null,
      dshVersion: NPX_FALLBACK_SPEC.split('@').pop(),
    },
  };
}

module.exports = {
  MIN_NODE_VERSION,
  NPX_FALLBACK_SPEC,
  DSH_PACKAGE_NAME,
  parseNodeVersion,
  compareVersions,
  satisfiesMin,
  formatVersion,
  whichSync,
  readPackageMeta,
  resolveBinPath,
  normalizeDshPath,
  dshPackageCandidates,
  resolveDshRuntime,
  probeNodeVersion,
  resolveNodeRuntime,
  buildDshArgs,
  buildLaunchPlan,
  buildNpxPlan,
};
