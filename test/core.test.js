'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Settings, normalize, DEFAULTS } = require('../src/main/settings');
const { ensureVisible, captureWindowState, intersectionArea } = require('../src/main/window-state');
const { describeError, STEPS } = require('../src/main/boot');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-'));
}

test('normalize 把脏数据收敛到合法值', () => {
  const result = normalize({
    runtimeMode: '乱填',
    theme: 'neon',
    port: '99999',
    host: '',
    closeToTray: 'yes',
    extraArgs: 123,
    windowBounds: { x: 0, y: 0, width: 100, height: 100 },
  });
  assert.equal(result.runtimeMode, DEFAULTS.runtimeMode);
  assert.equal(result.theme, 'system');
  assert.equal(result.port, 0);
  assert.equal(result.host, DEFAULTS.host);
  assert.equal(result.closeToTray, true);
  assert.equal(result.extraArgs, '');
  // 宽高会被抬到窗口的最小可用尺寸（与 BrowserWindow 的 minWidth/minHeight 一致）
  assert.equal(result.windowBounds.width, 720);
  assert.equal(result.windowBounds.height, 520);
});

test('Settings 读写往返一致并触发 change 事件', () => {
  const dir = tmpdir();
  const settings = new Settings({ dir });
  assert.equal(settings.get('runtimeMode'), 'auto');

  const events = [];
  settings.on('change', (next, changed) => events.push(changed));

  settings.set({ runtimeMode: 'local', port: 3080, dshPath: '  C:/x/dsh  ' });
  assert.equal(settings.get('runtimeMode'), 'local');
  assert.equal(settings.get('port'), 3080);
  assert.equal(settings.get('dshPath'), 'C:/x/dsh');
  assert.deepEqual(events[0].sort(), ['dshPath', 'port', 'runtimeMode'].sort());

  const reloaded = new Settings({ dir });
  assert.equal(reloaded.get('runtimeMode'), 'local');
  assert.equal(reloaded.get('port'), 3080);

  // 无变化时不触发事件
  events.length = 0;
  settings.set({ port: 3080 });
  assert.equal(events.length, 0);
});

test('Settings 遇到损坏的 JSON 文件会回落默认值', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ 这不是 JSON');
  const settings = new Settings({ dir });
  assert.equal(settings.get('closeToTray'), true);
});

test('intersectionArea 计算重叠面积', () => {
  assert.equal(intersectionArea({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }), 2500);
  assert.equal(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 500, y: 500, width: 10, height: 10 }), 0);
});

test('ensureVisible 把越界窗口拉回主显示器', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

  const inside = ensureVisible({ x: 100, y: 100, width: 1200, height: 800 }, displays);
  assert.deepEqual([inside.x, inside.y, inside.width, inside.height], [100, 100, 1200, 800]);

  const offscreen = ensureVisible({ x: 9000, y: 9000, width: 1200, height: 800 }, displays);
  assert.ok(offscreen.x >= 0 && offscreen.x < 1920);
  assert.ok(offscreen.y >= 0 && offscreen.y < 1040);
  assert.ok(offscreen.width <= 1920 && offscreen.height <= 1040);

  const none = ensureVisible(null, displays);
  assert.equal(none.centered, true);
});

test('captureWindowState 对已销毁窗口返回 null', () => {
  assert.equal(captureWindowState(null), null);
});

test('describeError 为已知错误码给出可操作提示', () => {
  const dshMissing = describeError(Object.assign(new Error('没找到'), { code: 'EDSHNOTFOUND' }));
  assert.equal(dshMissing.code, 'EDSHNOTFOUND');
  assert.ok(dshMissing.hint.includes('npm i -g'));

  const portBusy = describeError(Object.assign(new Error('busy'), { code: 'EADDRINUSE' }), { port: 3080 });
  assert.ok(portBusy.message.includes('3080'));
  assert.ok(portBusy.hint.includes('0'));

  const unknown = describeError(new Error('什么鬼'));
  assert.equal(unknown.code, 'EUNKNOWN');
  assert.ok(unknown.hint.length > 0);

  const withStderr = describeError(Object.assign(new Error('x'), { code: 'EEXITED1', stderrTail: ['a', 'b', 'c'] }));
  assert.equal(withStderr.detail, 'a\nb\nc');
});

test('启动步骤定义保持稳定（界面按 id 渲染）', () => {
  assert.deepEqual(
    STEPS.map((step) => step.id),
    ['runtime', 'plan', 'service', 'ready'],
  );
  for (const step of STEPS) {
    assert.ok(step.label && step.hint);
  }
});
