'use strict';

/**
 * HarnessServer：管理 `dsh web` 子进程的完整生命周期。
 *
 * 关键契约（由实测得出，见 docs/COMPATIBILITY.md）：
 *   dsh web --no-open --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>
 * 就绪时会向 stdout 打印一行带一次性令牌的地址：
 *   dsh web: http://127.0.0.1:52348/?token=xxxxxxxx
 * 该令牌 URL 访问会返回 303 并下发会话 Cookie；裸访问首页返回 401。
 * 因此桌面端必须解析这一行并把「带 token 的完整 URL」交给窗口加载。
 */

const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { delay, splitLines, stripAnsi, parseHarnessUrl } = require('./util');

/** 就绪行匹配：`dsh web: http://127.0.0.1:52021/?token=...` */
const READY_LINE_RE = /dsh web:\s*(https?:\/\/\S+)/i;
/** 兜底匹配：任何形如 http://127.0.0.1:port 的地址 */
const LOOSE_URL_RE = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\S*)/i;
/** 常见致命错误关键字，用于在启动阶段给出可读提示 */
const FATAL_PATTERNS = [
  { re: /EADDRINUSE|address already in use/i, code: 'EADDRINUSE', message: '端口已被占用' },
  { re: /Cannot find module|ERR_MODULE_NOT_FOUND/i, code: 'EMODULEMISSING', message: 'dsh 依赖不完整' },
  { re: /EACCES|permission denied/i, code: 'EACCES', message: '权限不足' },
  { re: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i, code: 'ENETWORK', message: '网络不可达' },
];

class HarnessServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./logger').Logger} options.logger
   * @param {number} [options.readyTimeoutMs]
   */
  constructor({ logger, readyTimeoutMs = 240000, stderrTailSize = 40 } = {}) {
    super();
    this.logger = logger;
    this.readyTimeoutMs = readyTimeoutMs;
    this.stderrTailSize = stderrTailSize;

    /** @type {'idle'|'starting'|'ready'|'stopping'|'stopped'|'crashed'|'error'} */
    this.state = 'idle';
    this.child = null;
    this.pid = null;
    this.url = null;
    this.token = null;
    this.port = null;
    this.host = null;
    this.startedAt = null;
    this.plan = null;
    this.exitInfo = null;
    this.stderrTail = [];
    this.restartCount = 0;

    this._stopping = false;
    this._readyTimer = null;
    this._resolveReady = null;
    this._rejectReady = null;
    this._readyPromise = null;
  }

  get running() {
    return !!this.child;
  }

  get uptimeMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      url: this.url,
      port: this.port,
      host: this.host,
      uptimeMs: this.uptimeMs,
      startedAt: this.startedAt,
      source: this.plan?.source ?? null,
      dshVersion: this.plan?.dshVersion ?? null,
      nodeVersion: this.plan?.nodeVersion ?? null,
      restartCount: this.restartCount,
      exitInfo: this.exitInfo,
    };
  }

  _setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { ...this.snapshot(), detail });
  }

  /** 尝试从一行输出里解析带令牌的 URL。 */
  parseReadyLine(line) {
    const text = stripAnsi(line);
    const strict = READY_LINE_RE.exec(text);
    const loose = strict || LOOSE_URL_RE.exec(text);
    if (!loose) return null;
    const raw = loose[1].replace(/[),.;'"]+$/, '');
    const parsed = parseHarnessUrl(raw);
    if (!parsed) return null;
    return parsed;
  }

  _matchFatal(line) {
    return FATAL_PATTERNS.find((pattern) => pattern.re.test(line)) || null;
  }

  /**
   * 启动服务并等待就绪。
   * @param {{file:string, argv:string[], cwd?:string, env?:Record<string,string>, shell?:boolean}} plan
   */
  start(plan) {
    if (this.child) {
      return Promise.reject(Object.assign(new Error('harness 服务已在运行'), { code: 'EALREADYRUNNING' }));
    }

    this.plan = plan;
    this.exitInfo = null;
    this.stderrTail = [];
    this._stopping = false;
    this.host = plan.host || null;
    this.port = plan.port || null;
    this._setState('starting', plan.source ? `来源：${plan.source}` : undefined);

    const env = { ...process.env, ...(plan.env || {}) };
    if (plan.env?.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = '1';

    this.logger?.info(`启动 harness：${plan.file} ${plan.argv.join(' ')}`, 'server');
    if (plan.cwd) this.logger?.debug(`工作目录：${plan.cwd}`, 'server');

    let child;
    try {
      child = spawn(plan.file, plan.argv, {
        cwd: plan.cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: !!plan.shell,
      });
    } catch (error) {
      this._setState('error', '无法启动子进程');
      return Promise.reject(error);
    }

    this.child = child;
    this.pid = child.pid;

    this._readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    this._readyTimer = setTimeout(() => {
      const error = new Error(`harness 启动超时（${Math.round(this.readyTimeoutMs / 1000)} 秒内未就绪）`);
      error.code = 'ETIMEDOUT';
      error.stderrTail = this.stderrTail.slice();
      this._failReady(error);
    }, this.readyTimeoutMs);

    this._attachStream(child.stdout, 'stdout');
    this._attachStream(child.stderr, 'stderr');

    child.once('error', (error) => {
      this.logger?.error(`子进程错误：${error.message}`, 'server');
      this._failReady(Object.assign(error, { code: error.code || 'ESPAWN' }));
      this._setState('error', error.message);
    });

    child.once('exit', (code, signal) => this._handleExit(code, signal));

    return this._readyPromise;
  }

  _attachStream(stream, name) {
    if (!stream) return;
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const result = splitLines(buffer, chunk);
      buffer = result.rest;
      for (const rawLine of result.lines) {
        const line = stripAnsi(rawLine);
        if (!line.trim()) continue;
        this.logger?.harness(line, name);
        if (name === 'stderr') {
          this.stderrTail.push(line);
          if (this.stderrTail.length > this.stderrTailSize) this.stderrTail.shift();
        }
        this._handleLine(line, name);
      }
    });
    stream.on('error', () => {
      /* 忽略管道错误 */
    });
  }

  _handleLine(line, stream) {
    if (this.state === 'starting') {
      const ready = this.parseReadyLine(line);
      if (ready) {
        this.url = ready.href;
        this.token = ready.token;
        this.port = ready.port;
        this.host = ready.host;
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
        this.startedAt = Date.now();
        this.restartCount = 0;
        this._setState('ready', `监听 ${ready.host}:${ready.port}`);
        this._resolveReady?.({ ...this.snapshot(), token: ready.token });
        this.emit('ready', { ...this.snapshot(), token: ready.token });
        return;
      }
      const fatal = this._matchFatal(line);
      if (fatal) {
        const error = new Error(`${fatal.message}：${line}`);
        error.code = fatal.code;
        error.stderrTail = this.stderrTail.slice();
        this._failReady(error);
      }
    }
    if (stream === 'stderr') this.emit('stderr', line);
  }

  _failReady(error) {
    if (this._readyTimer) {
      clearTimeout(this._readyTimer);
      this._readyTimer = null;
    }
    if (this.state === 'starting') this._setState('error', error.message);
    this._rejectReady?.(error);
    this._rejectReady = null;
  }

  _handleExit(code, signal) {
    const intentional = this._stopping;
    // 就绪前退出 = 本次启动失败，而不是"运行中崩溃"，两者的界面语义与恢复策略不同
    const failedWhileStarting = !intentional && this.state === 'starting';
    const phase = this.state === 'ready' || failedWhileStarting ? (failedWhileStarting ? 'starting' : 'running') : 'starting';

    this.child = null;
    this.pid = null;
    this.exitInfo = { code, signal, at: Date.now(), intentional, phase };

    if (failedWhileStarting) {
      const error = new Error(
        `harness 进程在就绪前退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`,
      );
      error.code = code === 1 ? 'EEXITED1' : 'EEXITED';
      error.stderrTail = this.stderrTail.slice();
      this._failReady(error);
    } else if (intentional) {
      this._setState('stopped', '已由用户停止');
    } else {
      this._setState('crashed', `退出码 ${code ?? 'null'}${signal ? ` / ${signal}` : ''}`);
      this.logger?.warn(`harness 异常退出：code=${code} signal=${signal}`, 'server');
    }
    this.emit('exit', this.exitInfo);
  }

  /** 等待 HTTP 端口真正可响应（TCP 监听 ≠ 应用层可用）。 */
  async waitHealthy({ timeoutMs = 30000, url } = {}) {
    const target = url || this.url;
    if (!target) return false;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      if (!this.running) return false;
      try {
        const response = await fetch(target, {
          redirect: 'manual',
          signal: AbortSignal.timeout(4000),
          headers: { accept: 'text/html' },
        });
        if (response.status < 500) {
          this.emit('healthy', { status: response.status });
          return true;
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(400);
    }
    this.logger?.warn(`健康检查未通过：${lastError?.message || '超时'}`, 'server');
    return false;
  }

  async stop({ timeoutMs = 12000 } = {}) {
    const child = this.child;
    if (!child) {
      if (this.state !== 'stopped') this._setState('stopped');
      return;
    }
    this._stopping = true;
    this._setState('stopping');
    const pid = child.pid;
    this.logger?.info(`停止 harness（pid=${pid}）`, 'server');

    const exited = new Promise((resolve) => {
      child.once('exit', () => resolve('exited'));
    });
    await killTree(pid, { force: false });

    const timedOut = await Promise.race([exited, delay(timeoutMs).then(() => 'timeout')]);
    if (timedOut === 'timeout' && this.child) {
      this.logger?.warn('优雅停止超时，强制结束进程树', 'server');
      await killTree(pid, { force: true });
      await Promise.race([exited, delay(3000)]);
    }

    if (this._readyTimer) {
      clearTimeout(this._readyTimer);
      this._readyTimer = null;
    }
    this._rejectReady?.(Object.assign(new Error('启动过程中被停止'), { code: 'ESTOPPED' }));
    this._rejectReady = null;
    this.url = null;
    this.token = null;
    this.startedAt = null;
    this._setState('stopped');
  }

  async restart(plan) {
    await this.stop();
    this.restartCount += 1;
    return this.start(plan || this.plan);
  }
}

/**
 * 结束整个进程树，避免 Windows 上留下孤儿 node 进程。
 *
 * Windows 上没有真正意义上的优雅终止：控制台进程不响应 WM_CLOSE，
 * 不传 /F 时 taskkill 会一直等到超时。所以这里直接连树强杀，
 * 换来的是退出秒级完成；harness 的会话日志本身是只追加的，不怕被中断。
 */
function killTree(pid, { force = false } = {}) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* 已退出 */
      }
    }
    resolve();
  });
}

module.exports = { HarnessServer, killTree, READY_LINE_RE, FATAL_PATTERNS };
