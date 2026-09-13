'use strict';

/**
 * 设置持久化：userData/settings.json，原子写入，带 schema 校验与变更事件。
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { readJsonSync, writeFileAtomic } = require('./util');
const { MIN_SIZE } = require('./window-state');

const RUNTIME_MODES = ['auto', 'local', 'bundled', 'npx'];
const THEMES = ['system', 'light', 'dark'];

const DEFAULTS = Object.freeze({
  /** 运行时来源：auto=本机→内置→npx，local=仅本机，bundled=仅内置，npx=仅 npx */
  runtimeMode: 'auto',
  /** 手动指定 dsh（可指向包目录 / lib/bin.js / dsh 启动器） */
  dshPath: '',
  /** 手动指定 Node 解释器 */
  nodePath: '',
  /** 0 = 自动选择空闲端口 */
  port: 0,
  host: '127.0.0.1',
  /** 追加给 `dsh web` 的原始参数，例如 --foo bar */
  extraArgs: '',
  /** 仅注入给 harness 子进程的代理，例如 http://127.0.0.1:7897 */
  proxy: '',
  /** 关闭窗口时最小化到托盘而不是退出 */
  closeToTray: true,
  /** 开机自启 */
  openAtLogin: false,
  /** 启动时自动展开日志面板 */
  showLogsOnBoot: false,
  /** 服务异常退出后自动重启（带退避） */
  autoRestart: true,
  /** 首次运行引导是否已展示 */
  seenWelcome: false,
  /** 界面主题 */
  theme: 'system',
  /** 记忆的窗口位置尺寸 */
  windowBounds: null,
});

/** 把外部输入强制收敛到合法值，永不抛出。 */
function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };

  out.runtimeMode = RUNTIME_MODES.includes(input.runtimeMode) ? input.runtimeMode : DEFAULTS.runtimeMode;
  out.theme = THEMES.includes(input.theme) ? input.theme : DEFAULTS.theme;

  for (const key of ['dshPath', 'nodePath', 'extraArgs', 'proxy', 'host']) {
    if (typeof input[key] === 'string') out[key] = input[key].trim();
  }

  const port = Number(input.port);
  out.port = Number.isFinite(port) && port >= 0 && port <= 65535 ? Math.trunc(port) : DEFAULTS.port;

  for (const key of ['closeToTray', 'openAtLogin', 'showLogsOnBoot', 'autoRestart', 'seenWelcome']) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }

  if (!out.host) out.host = DEFAULTS.host;

  const bounds = input.windowBounds;
  if (
    bounds &&
    typeof bounds === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(bounds[key])))
  ) {
    out.windowBounds = {
      x: Math.trunc(Number(bounds.x)),
      y: Math.trunc(Number(bounds.y)),
      width: Math.max(MIN_SIZE.width, Math.trunc(Number(bounds.width))),
      height: Math.max(MIN_SIZE.height, Math.trunc(Number(bounds.height))),
      maximized: Boolean(bounds.maximized),
    };
  }

  return out;
}

class Settings extends EventEmitter {
  constructor({ dir }) {
    super();
    this.file = path.join(dir, 'settings.json');
    this.values = normalize(readJsonSync(this.file, {}));
  }

  all() {
    return { ...this.values };
  }

  get(key) {
    return this.values[key];
  }

  /** 合并写入；返回本次真正生效的完整设置。 */
  set(patch) {
    const next = normalize({ ...this.values, ...patch });
    const changed = Object.keys(next).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(this.values[key]));
    this.values = next;
    this.save();
    if (changed.length) this.emit('change', next, changed);
    return { ...next };
  }

  reset() {
    this.values = { ...DEFAULTS };
    this.save();
    this.emit('change', this.all(), Object.keys(DEFAULTS));
    return this.all();
  }

  save() {
    writeFileAtomic(this.file, `${JSON.stringify(this.values, null, 2)}\n`);
  }
}

module.exports = { Settings, DEFAULTS, RUNTIME_MODES, THEMES, normalize };
