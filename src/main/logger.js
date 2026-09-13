'use strict';

/**
 * 日志系统：写文件 + 内存环形缓冲 + 事件广播。
 * 渲染进程的"实时日志"面板消费环形缓冲；主进程各处只调用 info/warn/error。
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { stripAnsi } = require('./util');

const LEVEL_TAG = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', harness: 'DSH' };

class Logger extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dir 日志目录
   * @param {number} [options.maxLines] 内存缓冲行数上限
   * @param {number} [options.maxFileBytes] 单个日志文件上限，超出后轮转
   */
  constructor({ dir, maxLines = 4000, maxFileBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.dir = dir;
    this.maxLines = maxLines;
    this.maxFileBytes = maxFileBytes;
    this.buffer = [];
    this._stream = null;
    this._filePath = null;
  }

  get filePath() {
    return this._filePath;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _openStream() {
    if (this._stream) return;
    this.ensureDir();
    const day = new Date().toISOString().slice(0, 10);
    let file = path.join(this.dir, `dsh-desktop-${day}.log`);
    try {
      const stat = fs.statSync(file);
      if (stat.size > this.maxFileBytes) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(file, path.join(this.dir, `dsh-desktop-${day}-${stamp}.log`));
      }
    } catch {
      /* 文件不存在，正常 */
    }
    this._filePath = file;
    this._stream = fs.createWriteStream(file, { flags: 'a' });
    this._stream.on('error', () => {
      // 日志写失败不能影响主流程
      this._stream = null;
    });
  }

  _write(level, scope, message, meta) {
    const entry = {
      ts: Date.now(),
      time: new Date().toISOString(),
      level,
      scope: scope || 'app',
      text: stripAnsi(message),
    };
    if (meta !== undefined) entry.meta = meta;

    this.buffer.push(entry);
    if (this.buffer.length > this.maxLines) {
      this.buffer.splice(0, this.buffer.length - this.maxLines);
    }

    this.emit('entry', entry);

    try {
      this._openStream();
      const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
      const line = `${entry.time} [${LEVEL_TAG[level] || level}] [${entry.scope}] ${entry.text}${suffix}\n`;
      this._stream?.write(line);
    } catch {
      /* 忽略落盘错误 */
    }
  }

  debug(text, scope, meta) {
    this._write('debug', scope, text, meta);
  }

  info(text, scope, meta) {
    this._write('info', scope, text, meta);
  }

  warn(text, scope, meta) {
    this._write('warn', scope, text, meta);
  }

  error(text, scope, meta) {
    this._write('error', scope, text, meta);
  }

  /** harness 子进程的原始输出。 */
  harness(text, stream, scope = 'harness') {
    this._write('harness', scope, text, stream && stream !== 'stdout' ? { stream } : undefined);
  }

  getEntries() {
    return this.buffer.slice();
  }

  clear() {
    this.buffer.length = 0;
    this.emit('cleared');
  }

  /** 导出最近 N 行文本，用于"复制诊断信息"。 */
  tailText(lines = 200) {
    return this.buffer
      .slice(-lines)
      .map((entry) => `${entry.time} [${LEVEL_TAG[entry.level] || entry.level}] [${entry.scope}] ${entry.text}`)
      .join('\n');
  }

  close() {
    try {
      this._stream?.end();
    } catch {
      /* noop */
    }
    this._stream = null;
  }
}

module.exports = { Logger };
