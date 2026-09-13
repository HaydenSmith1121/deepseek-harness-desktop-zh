'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseNodeVersion,
  compareVersions,
  satisfiesMin,
  whichSync,
  resolveBinPath,
  normalizeDshPath,
  dshPackageCandidates,
  resolveDshRuntime,
  buildDshArgs,
  formatVersion,
} = require('../src/main/runtime');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
}

/** 造一个假的 dsh 包目录，返回包目录路径。 */
function fakeDshPackage(root, { name = '@deepseek-ai/dsh', version = '0.1.5-rc.1', bin = 'lib/bin.js' } = {}) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(dir, path.dirname(bin)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, bin: { dsh: bin } }));
  fs.writeFileSync(path.join(dir, bin), '#!/usr/bin/env node\n');
  return dir;
}

test('parseNodeVersion 解析带 v 前缀与裸版本号', () => {
  assert.deepEqual(parseNodeVersion('v22.19.0'), [22, 19, 0]);
  assert.deepEqual(parseNodeVersion('22.19.0\n'), [22, 19, 0]);
  assert.equal(parseNodeVersion('not a version'), null);
  assert.equal(parseNodeVersion(undefined), null);
});

test('compareVersions / satisfiesMin 正确判断最低版本', () => {
  assert.equal(compareVersions([22, 19, 0], [22, 19, 0]), 0);
  assert.equal(compareVersions([22, 18, 9], [22, 19, 0]), -1);
  assert.equal(compareVersions([24, 0, 0], [22, 19, 0]), 1);
  assert.equal(satisfiesMin([22, 19, 0]), true);
  assert.equal(satisfiesMin([22, 18, 0]), false);
  assert.equal(satisfiesMin(null), false);
  assert.equal(formatVersion([22, 22, 2]), '22.22.2');
});

test('whichSync 按 PATH 查找可执行文件，Windows 上补 .exe/.cmd 后缀', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'node.exe'), '');
  fs.writeFileSync(path.join(dir, 'dsh.cmd'), '');

  const winEnv = { Path: dir };
  assert.equal(whichSync('node', { env: winEnv, platform: 'win32' }), path.join(dir, 'node.exe'));
  assert.equal(whichSync('dsh', { env: winEnv, platform: 'win32' }), path.join(dir, 'dsh.cmd'));
  assert.equal(whichSync('nope', { env: winEnv, platform: 'win32' }), null);
});

test('whichSync 在 POSIX 语义下按 : 切分且不做 Windows 后缀补全', () => {
  // 注入假的文件判定，避免在 Windows 宿主上真的去写 /usr/local/bin
  const existing = new Set(['/usr/local/bin/dsh']);
  const isFile = (target) => existing.has(target);

  const env = { PATH: '/usr/bin:/usr/local/bin' };
  assert.equal(whichSync('dsh', { env, platform: 'linux', isFile }), '/usr/local/bin/dsh');
  assert.equal(whichSync('missing', { env, platform: 'linux', isFile }), null);
  assert.equal(whichSync('dsh', { env, platform: 'linux', isFile: (t) => t.endsWith('dsh.exe') }), null);
});

test('resolveBinPath 兼容 bin 为字符串、对象与缺省路径', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '');

  assert.equal(resolveBinPath(dir, undefined), path.join(dir, 'lib', 'bin.js'));
  assert.equal(resolveBinPath(dir, 'lib/bin.js'), path.join(dir, 'lib', 'bin.js'));
  assert.equal(resolveBinPath(dir, { dsh: 'lib/bin.js' }), path.join(dir, 'lib', 'bin.js'));
  assert.equal(resolveBinPath(tmpdir(), { dsh: 'lib/bin.js' }), null);
});

test('normalizeDshPath 接受包目录 / bin.js / 启动器三种输入', () => {
  const root = tmpdir();
  const npmDir = path.join(root, 'npm');
  const pkgDir = fakeDshPackage(npmDir, { name: '@deepseek-ai/dsh' });

  assert.equal(normalizeDshPath(pkgDir), pkgDir);
  assert.equal(normalizeDshPath(path.join(pkgDir, 'lib', 'bin.js')), pkgDir);

  const shim = path.join(npmDir, 'dsh.cmd');
  fs.writeFileSync(shim, '');
  assert.equal(normalizeDshPath(shim), pkgDir);
  assert.equal(normalizeDshPath(''), null);
});

test('dshPackageCandidates 覆盖 APPDATA / PATH 反推 / 内置副本', () => {
  const root = tmpdir();
  const npmDir = path.join(root, 'npm');
  fakeDshPackage(npmDir, { name: '@deepseek-ai/dsh', version: '1.2.3' });
  fs.writeFileSync(path.join(npmDir, 'dsh.cmd'), '');

  const candidates = dshPackageCandidates({
    settings: { dshPath: '' },
    env: { APPDATA: root, PATH: npmDir },
    platform: 'win32',
    home: root,
    appRoot: root,
    isPackaged: false,
  });
  const dirs = candidates.map((item) => item.dir);
  assert.ok(dirs.some((dir) => dir.includes(path.join('@deepseek-ai', 'dsh'))), '应包含 npm 全局目录');
  assert.ok(candidates.some((item) => item.source === 'bundled'), '应包含应用内置副本');

  const local = resolveDshRuntime({
    settings: { runtimeMode: 'auto' },
    env: { APPDATA: root, PATH: npmDir },
    platform: 'win32',
    home: root,
    appRoot: root,
  });
  assert.equal(local.version, '1.2.3');
  assert.ok(['local', 'setting'].includes(local.source));
});

test('resolveDshRuntime 找不到时返回可读错误并带上尝试过的路径', () => {
  const root = tmpdir();
  const result = resolveDshRuntime({
    settings: { runtimeMode: 'auto' },
    env: { APPDATA: path.join(root, 'nope'), PATH: '' },
    platform: 'win32',
    home: root,
    appRoot: path.join(root, 'empty'),
  });
  assert.ok(result.error);
  assert.equal(result.error.code, 'EDSHNOTFOUND');
  assert.ok(Array.isArray(result.attempted));
});

test('runtimeMode=local 不会回退到内置副本', () => {
  const root = tmpdir();
  fakeDshPackage(path.join(root, 'vendor'), { name: '@deepseek-ai/dsh', version: '9.9.9' });
  const result = resolveDshRuntime({
    settings: { runtimeMode: 'local' },
    env: { APPDATA: path.join(root, 'nope'), PATH: '' },
    platform: 'win32',
    home: root,
    appRoot: root,
  });
  assert.ok(result.error, 'local 模式下不应使用内置副本');
});

test('buildDshArgs 显式传入端口并声明 trusted-host', () => {
  const args = buildDshArgs({ host: '127.0.0.1', port: 52348 });
  assert.deepEqual(args, ['web', '--no-open', '--host', '127.0.0.1', '--port', '52348', '--trusted-host', '127.0.0.1:52348']);

  const withExtra = buildDshArgs({ host: '127.0.0.1', port: 8080, extraArgs: '--foo "bar baz" --qux' });
  assert.deepEqual(withExtra.slice(-3), ['--foo', 'bar baz', '--qux']);

  const dynamic = buildDshArgs({ port: 0 });
  assert.ok(!dynamic.includes('--trusted-host'));
});
