'use strict';

/**
 * 主窗口：安全策略、导航白名单、标题管理、窗口状态恢复。
 *
 * 安全基线（对齐官方推荐）：
 * - contextIsolation: true / nodeIntegration: false / sandbox: true
 * - 渲染层只能通过 preload 暴露的窄接口与主进程通信
 * - 顶层导航只允许 file:// (引导页) 与 harness 自身的 http://127.0.0.1:<port>
 * - 其它 http(s) 链接一律交给系统浏览器打开，不在应用内导航
 */

const path = require('node:path');
const { BrowserWindow, shell, screen, nativeTheme, session } = require('electron');
const { ensureVisible, captureWindowState } = require('./window-state');

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const BOOT_PAGE = path.join(__dirname, '..', 'renderer', 'boot.html');

/** 允许应用内导航的权限控制器。 */
class NavigationPolicy {
  constructor({ logger }) {
    this.logger = logger;
    this.allowedOrigins = new Set(['file://']);
  }

  allowOrigin(origin) {
    if (!origin) return;
    this.allowedOrigins.add(origin);
    this.logger?.debug(`导航白名单新增：${origin}`, 'window');
  }

  isAllowed(targetUrl) {
    try {
      const url = new URL(targetUrl);
      if (url.protocol === 'file:') return true;
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (this.allowedOrigins.has(url.origin)) return true;
      // 本机回环地址始终放行（harness 只监听 127.0.0.1）
      if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return true;
      return false;
    } catch {
      return false;
    }
  }
}

function applyPermissionPolicy(targetSession, logger) {
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications']);
  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const ok = allowed.has(permission);
    if (!ok) logger?.debug(`拒绝权限请求：${permission}`, 'window');
    callback(ok);
  });
  targetSession.setPermissionCheckHandler((_webContents, permission) => allowed.has(permission));
}

/**
 * 创建主窗口。
 * @param {object} options
 * @param {import('./logger').Logger} options.logger
 * @param {() => object} options.getSettings
 * @param {(bounds:object) => void} options.onBoundsChange
 * @param {NavigationPolicy} options.policy
 * @param {boolean} [options.isDev]
 */
function createMainWindow({ logger, getSettings, onBoundsChange, policy, isDev = false }) {
  const settings = getSettings();
  const displays = screen.getAllDisplays();
  const restored = ensureVisible(settings.windowBounds, displays);

  const win = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    x: restored.x,
    y: restored.y,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0b1020',
    title: 'DeepSeek Harness 桌面端',
    autoHideMenuBar: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      partition: 'persist:dsh-desktop',
      additionalArguments: [`--dsh-desktop-version=${require('../../package.json').version}`],
    },
  });

  win.__policy = policy;
  if (restored.maximized) win.maximize();

  applyPermissionPolicy(session.fromPartition('persist:dsh-desktop'), logger);

  // 标题：始终带上产品名前缀，避免被 harness 页面标题完全覆盖
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (policy.isAllowed(url)) return;
    event.preventDefault();
    logger?.warn(`拦截应用内导航：${url}`, 'window');
    if (/^https?:/.test(url)) shell.openExternal(url).catch(() => {});
  });

  win.webContents.on('will-redirect', (event, url) => {
    // harness 的令牌认证依赖 303 跳转，同源跳转必须放行
    if (policy.isAllowed(url)) return;
    event.preventDefault();
    logger?.warn(`拦截重定向：${url}`, 'window');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    logger?.debug(`新窗口请求转交系统浏览器：${url}`, 'window');
    if (/^https?:/.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logger?.error(`渲染进程异常：${details.reason}`, 'window');
  });

  win.webContents.on('unresponsive', () => logger?.warn('界面无响应', 'window'));

  let boundsTimer = null;
  const scheduleSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      const state = captureWindowState(win);
      if (state) onBoundsChange?.(state);
    }, 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  return win;
}

/** 加载引导页。 */
async function loadBootPage(win, query = {}) {
  const url = new URL(`file://${BOOT_PAGE.replace(/\\/g, '/')}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  await win.loadURL(url.href);
}

/** 加载 harness 官方界面（必须带令牌 URL）。 */
async function loadHarness(win, targetUrl, policy) {
  policy?.allowOrigin(new URL(targetUrl).origin);
  await win.loadURL(targetUrl);
}

module.exports = { createMainWindow, loadBootPage, loadHarness, NavigationPolicy, BOOT_PAGE, PRELOAD_PATH, applyPermissionPolicy };
