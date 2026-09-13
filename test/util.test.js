'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  splitLines,
  parseHarnessUrl,
  parseArgString,
  isShellSafeArgs,
  formatBytes,
  stripAnsi,
  writeFileAtomic,
  readJsonSync,
} = require('../src/main/util');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('splitLines 正确处理跨 chunk 的半行', () => {
  let buffer = '';
  const collected = [];
  for (const chunk of ['第一行\n第二', '行\n第三行', '\n']) {
    const result = splitLines(buffer, chunk);
    buffer = result.rest;
    collected.push(...result.lines);
  }
  assert.deepEqual(collected, ['第一行', '第二行', '第三行']);
  assert.equal(buffer, '');
});

test('splitLines 兼容 CRLF 并保留未结束的尾行', () => {
  const result = splitLines('', 'a\r\nb\r\nc');
  assert.deepEqual(result.lines, ['a', 'b']);
  assert.equal(result.rest, 'c');
});

test('parseHarnessUrl 提取 token、host 与端口', () => {
  const parsed = parseHarnessUrl('http://127.0.0.1:52348/?token=abc123');
  assert.equal(parsed.port, 52348);
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.token, 'abc123');
  assert.equal(parsed.origin, 'http://127.0.0.1:52348');

  assert.equal(parseHarnessUrl('not-a-url'), null);
  assert.equal(parseHarnessUrl('http://127.0.0.1:3080/').token, null);
});

test('parseArgString 支持引号包裹的参数', () => {
  assert.deepEqual(parseArgString('--a b --c "d e" \'f g\''), ['--a', 'b', '--c', 'd e', 'f g']);
  assert.deepEqual(parseArgString(''), []);
  assert.deepEqual(parseArgString('   '), []);
});

test('isShellSafeArgs 拦截 shell 元字符', () => {
  assert.equal(isShellSafeArgs(['--port', '3080']), true);
  assert.equal(isShellSafeArgs(['--port', '3080 && rm -rf /']), false);
  assert.equal(isShellSafeArgs(['a|b']), false);
  assert.equal(isShellSafeArgs(['$(whoami)']), false);
});

test('stripAnsi 去掉颜色控制符', () => {
  assert.equal(stripAnsi('\u001B[31m红色\u001B[0m'), '红色');
});

test('formatBytes 输出可读单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
});

test('writeFileAtomic + readJsonSync 往返一致且不残留临时文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-util-'));
  const file = path.join(dir, 'nested', 'settings.json');
  writeFileAtomic(file, JSON.stringify({ a: 1 }));
  assert.deepEqual(readJsonSync(file), { a: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
  assert.equal(readJsonSync(path.join(dir, 'missing.json'), null), null);
});
