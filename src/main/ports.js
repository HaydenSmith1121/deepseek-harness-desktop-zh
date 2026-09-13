'use strict';

/**
 * 端口工具：为 harness 预留一个确定的空闲端口。
 *
 * 为什么不让 dsh 用 `--port 0` 自己随机挑？因为 `/api` 的浏览器信任栅栏
 * 依赖「组合配置里的 host:port」，随机端口下我们无法提前声明 trusted-host。
 * 先自己探测一个空闲端口再显式传入，既确定又避免端口冲突。
 */

const net = require('node:net');

function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配空闲端口'))));
    });
  });
}

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port <= 0) return resolve(false);
    const server = net.createServer();
    server.unref();
    server.once('error', (error) => resolve(error.code !== 'EADDRINUSE'));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

module.exports = { findFreePort, isPortFree };
