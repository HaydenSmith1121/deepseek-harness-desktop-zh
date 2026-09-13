'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { HarnessServer } = require('../src/main/server');

const stubLogger = { info() {}, warn() {}, error() {}, debug() {}, harness() {} };

/** 用当前 Node 跑一段内联脚本，模拟 dsh 进程的输出行为。 */
function nodePlan(script, { timeout = 12000 } = {}) {
  return {
    file: process.execPath,
    argv: ['-e', script],
    source: 'test',
    host: '127.0.0.1',
    port: 0,
    env: {},
    shell: false,
    readyTimeoutMs: timeout,
  };
}

const READY_SCRIPT = "console.log('dsh web: http://127.0.0.1:59987/?token=tok_abc123'); setInterval(() => {}, 1000);";

test('start() 解析带令牌的就绪地址', async () => {
  const server = new HarnessServer({ logger: stubLogger, readyTimeoutMs: 15000 });
  const snapshot = await server.start(nodePlan(READY_SCRIPT));

  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.port, 59987);
  assert.equal(snapshot.host, '127.0.0.1');
  assert.equal(snapshot.token, 'tok_abc123');
  assert.equal(server.url, 'http://127.0.0.1:59987/?token=tok_abc123');
  assert.ok(server.running);
  assert.ok(server.pid);

  await server.stop();
  assert.equal(server.state, 'stopped');
  assert.equal(server.running, false);
});

test('parseReadyLine 兼容宽松格式与行尾标点', () => {
  const server = new HarnessServer({ logger: stubLogger });
  assert.equal(server.parseReadyLine('dsh web: http://127.0.0.1:3080/?token=xyz').port, 3080);
  assert.equal(server.parseReadyLine('  ready at http://localhost:8080/ ').port, 8080);
  assert.equal(server.parseReadyLine('\u001B[32mdsh web: http://127.0.0.1:9000/?token=a\u001B[0m').port, 9000);
  assert.equal(server.parseReadyLine('no url here'), null);
});

test('就绪前进程退出 → 以 EEXITED1 拒绝', async () => {
  const server = new HarnessServer({ logger: stubLogger, readyTimeoutMs: 8000 });
  await assert.rejects(
    () => server.start(nodePlan('console.error("boom"); process.exit(1);')),
    (error) => {
      assert.equal(error.code, 'EEXITED1');
      assert.ok(String(error.message).includes('就绪前退出'));
      return true;
    },
  );
  assert.equal(server.state, 'error');
});

test('识别 EADDRINUSE 并映射为端口占用错误', async () => {
  const server = new HarnessServer({ logger: stubLogger, readyTimeoutMs: 8000 });
  await assert.rejects(
    () =>
      server.start(
        nodePlan("console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:3080'); setInterval(() => {}, 1000);"),
      ),
    (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      return true;
    },
  );
  await server.stop();
});

test('迟迟不就绪 → 以 ETIMEDOUT 拒绝', async () => {
  const server = new HarnessServer({ logger: stubLogger, readyTimeoutMs: 1200 });
  await assert.rejects(
    () => server.start(nodePlan('setInterval(() => {}, 1000);')),
    (error) => {
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    },
  );
  await server.stop();
});

test('重复 start 会被拒绝，stop 后可再次启动', async () => {
  const server = new HarnessServer({ logger: stubLogger, readyTimeoutMs: 15000 });
  await server.start(nodePlan(READY_SCRIPT));
  await assert.rejects(
    () => server.start(nodePlan(READY_SCRIPT)),
    (error) => error.code === 'EALREADYRUNNING',
  );
  await server.stop();
  const again = await server.start(nodePlan(READY_SCRIPT));
  assert.equal(again.state, 'ready');
  await server.stop();
});

test('stop() 幂等，未启动时调用不报错', async () => {
  const server = new HarnessServer({ logger: stubLogger });
  await server.stop();
  assert.equal(server.state, 'stopped');
  await server.stop();
});
