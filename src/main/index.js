'use strict';

/**
 * 主进程入口与编排层。
 *
 * 职责边界：
 *   runtime.js  只管"从哪拿运行时"
 *   server.js   只管"把 dsh web 跑起来并盯住它"
 *   boot.js     把上面两件事串成带进度的启动流程
 *   index.js    窗口 / 托盘 / 菜单 / IPC / 崩溃重启 / 退出
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  ipcMain,
  nativeTheme,
  net,
  session,
  shell,
} = require('electron');

const { Logger } = require('./logger');
const { Settings } = require('./settings');
const { HarnessServer } = require('./server');
const { BootController } = require('./boot');
const { createMainWindow, loadBootPage, NavigationPolicy, applyPermissionPolicy, PRELOAD_PATH } = require('./window');
const { createTray } = require('./tray');
const { buildMenu, REPO_URL, UPSTREAM_URL, DOCS_URL } = require('./menu');
const { resolveDshRuntime, compareVersions, parseNodeVersion } = require('./runtime');
const { createSelfTest } = require('./self-test');
const { parseHarnessUrl, isShellSafeArgs } = require('./util');

// ── 命令行 ──────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(1);
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')));
const isDev = flags.has('--dev');
const selfTestMode = flags.has('--self-test') ? 'full' : flags.has('--self-test-ui') ? 'ui' : null;

const APP_ROOT = app.getAppPath();
const CRASH_BACKOFF = [2000, 5000, 15000];
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_AUTO_RESTARTS = 3;

// 自检与 CI 环境通常没有可用 GPU，Chromium 的 GPU 进程会直接 fatal。
// 只在无头场景降级，正常桌面启动保持默认的沙箱与硬件加速。
if (selfTestMode || flags.has('--headless')) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

// ── 运行时状态 ──────────────────────────────────────────────────────────────
/** @type {Logger} */
let logger;
/** @type {Settings} */
let settings;
/** @type {HarnessServer} */
let server;
/** @type {BootController} */
let boot;
/** @type {NavigationPolicy} */
let policy;
/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {BrowserWindow|null} */
let settingsWindow = null;
let trayController = null;
let quitting = false;
let crashTimes = [];
let restartTimer = null;
let selfTest = null;

const getSettings = () => settings.all();
const currentTheme = () => settings.get('theme') || 'system';
const resolvedTheme = () => (currentTheme() === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : currentTheme());
const dshHome = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function broadcast(type, payload) {
  const message = { type, payload };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      // 渲染进程崩溃或正在销毁时，webContents.mainFrame 的访问本身就会抛错。
      // 主动读一次 frame，把这种"半死"窗口提前挡掉——否则 Electron 会在主控台
      // 打印 "Render frame was disposed before WebFrameMain could be accessed" 噪音。
      if (!win.webContents.mainFrame) continue;
      win.webContents.send('shell:event', message);
    } catch {
      /* 窗口正在销毁或渲染进程已崩溃，忽略 */
    }
  }
}

function contextForRuntime() {
  return {
    settings: settings.all(),
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appRoot: APP_ROOT,
    isPackaged: app.isPackaged,
  };
}

// ── 诊断信息 ────────────────────────────────────────────────────────────────
function buildDiagnostics() {
  const runtime = resolveDshRuntime(contextForRuntime());
  const lines = [
    '=== DeepSeek Harness 桌面端 · 诊断信息 ===',
    `生成时间   : ${new Date().toLocaleString('zh-CN')}`,
    `桌面壳版本 : v${app.getVersion()}${app.isPackaged ? '' : ' (开发模式)'}`,
    `Electron   : ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    `内置 Node  : ${process.versions.node}`,
    `系统       : ${process.platform} ${os.release()} ${process.arch}`,
    `桌面壳目录 : ${APP_ROOT}`,
    `数据目录   : ${app.getPath('userData')}`,
    `日志文件   : ${logger?.filePath ?? '（尚未创建）'}`,
    `DSH_HOME   : ${dshHome()}`,
    '',
    '--- runtime ---',
    runtime.error
      ? `dsh        : 未找到（${runtime.error.code}）`
      : `dsh        : ${runtime.version} [${runtime.source}] @ ${runtime.binPath}`,
    `服务状态   : ${server?.state ?? 'idle'}${server?.pid ? `, pid=${server.pid}` : ''}`,
    `监听地址   : ${server?.url ? server.url.replace(/token=[^&]+/, 'token=***') : '—'}`,
    `启动命令   : ${boot?.plan ? boot.buildCommandPreview(boot.plan) : '—'}`,
    `设置       : ${JSON.stringify(settings?.all() ?? {})}`,
    '',
    '--- 最近日志（80 行）---',
    logger?.tailText(80) ?? '',
    '',
    `项目仓库   : ${REPO_URL}`,
    `上游仓库   : ${UPSTREAM_URL}`,
  ];
  return lines.join('\n');
}

// ── 主窗口 ──────────────────────────────────────────────────────────────────
function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  policy = policy || new NavigationPolicy({ logger });
  mainWindow = createMainWindow({
    logger,
    getSettings,
    policy,
    isDev,
    onBoundsChange: (bounds) => settings.set({ windowBounds: bounds }),
  });

  mainWindow.webContents.on('did-finish-load', () => {
    broadcast('ui:page', { url: mainWindow.webContents.getURL() });
  });
  mainWindow.webContents.on('render-process-gone', () => {
    if (!quitting) {
      logger.warn('渲染进程退出，正在重建窗口', 'window');
      mainWindow = null;
      setTimeout(() => bootPageOrHarness(), 800);
    }
  });

  attachShortcuts(mainWindow);
  selfTest?.attach(mainWindow);

  mainWindow.on('close', (event) => {
    if (quitting || !settings.get('closeToTray')) return;
    event.preventDefault();
    mainWindow.hide();
    notifyOnce('dsh-desktop-tray-hint', '已最小化到托盘', 'DeepSeek Harness 仍在后台运行，可从托盘图标重新打开。');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function attachShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();
    if (mod && input.shift && key === 'r') {
      event.preventDefault();
      restartServer('快捷键');
    } else if (mod && key === 'r') {
      event.preventDefault();
      reloadUi();
    } else if (mod && key === ',') {
      event.preventDefault();
      openSettingsWindow();
    } else if (mod && key === 'q') {
      event.preventDefault();
      quitApp();
    } else if (input.key === 'F5') {
      event.preventDefault();
      reloadUi({ ignoreCache: input.shift });
    }
  });
}

const notified = new Set();
function notifyOnce(tag, title, body) {
  if (notified.has(tag)) return;
  notified.add(tag);
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: false }).show();
  } catch {
    /* 通知失败无所谓 */
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body }).show();
  } catch {
    /* noop */
  }
}

// ── 界面切换 ────────────────────────────────────────────────────────────────
function bootPageQuery(extra = {}) {
  return {
    theme: resolvedTheme(),
    version: app.getVersion(),
    isDev: isDev ? '1' : '0',
    ...extra,
  };
}

async function bootPageOrHarness() {
  const win = ensureMainWindow();
  if (server?.url && server.state === 'ready') {
    await loadHarnessWithFallback(win, server.url);
  } else {
    await loadBootPage(win, bootPageQuery());
  }
}

async function showBootPage() {
  const win = ensureMainWindow();
  await loadBootPage(win, bootPageQuery());
  win.show();
  win.focus();
}

const RELOADABLE_SCHEME = /^https?:/;

async function loadHarnessWithFallback(win, tokenUrl) {
  const parsed = parseHarnessUrl(tokenUrl);
  if (!parsed) return { ok: false, status: 0, reason: 'invalid-url' };
  policy.allowOrigin(parsed.origin);

  // 等「整页加载完成」而不是等首个导航事件：令牌地址会返回 303 再跳转，
  // 太早判定完成并立刻发起第二次导航，会把上一次跳转打断（ERR_ABORTED）。
  const waitForLoad = (target, timeoutMs = 60000) =>
    new Promise((resolve) => {
      const wc = win.webContents;
      let lastStatus = 0;
      const cleanup = () => {
        clearTimeout(timer);
        wc.off('did-finish-load', onFinish);
        wc.off('did-fail-load', onFail);
        wc.off('did-navigate', onNavigate);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, status: lastStatus, url: target, reason: 'timeout' });
      }, timeoutMs);
      const onNavigate = (_event, url, httpResponseCode) => {
        if (String(url).startsWith(parsed.origin)) lastStatus = httpResponseCode;
      };
      const onFinish = () => {
        if (!String(wc.getURL()).startsWith(parsed.origin)) return; // 引导页完成不算
        cleanup();
        resolve({ ok: lastStatus < 400, status: lastStatus || 200, url: wc.getURL() });
      };
      const onFail = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        if (errorCode === -3) return; // ERR_ABORTED：被后续导航取代，交给 onFinish 判定
        cleanup();
        resolve({ ok: false, status: 0, url: validatedURL, reason: `${errorCode} ${errorDescription}` });
      };
      wc.on('did-navigate', onNavigate);
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      win.loadURL(target).catch(() => {});
    });

  const first = await waitForLoad(tokenUrl);
  if (!first.ok) {
    logger.error(`加载 harness 界面失败：${first.reason || first.status}`, 'window');
    return first;
  }

  // 令牌是一次性的：归一化成不带 token 的地址，这样 Ctrl+R 重载不会 401
  const clean = await waitForLoad(`${parsed.origin}/`);
  if (!clean.ok) {
    logger.warn(`地址归一化返回 ${clean.status}，回退到令牌地址`, 'window');
    await waitForLoad(tokenUrl);
  } else {
    logger.info('harness 界面已加载', 'window');
  }
  return clean.ok ? clean : first;
}

async function reloadUi({ ignoreCache = false } = {}) {
  const win = ensureMainWindow();
  const url = win.webContents.getURL();
  if (RELOADABLE_SCHEME.test(url)) {
    if (ignoreCache) win.webContents.reloadIgnoringCache();
    else win.webContents.reload();
  } else if (server?.url) {
    await loadHarnessWithFallback(win, server.url);
  }
}

async function openHarness() {
  if (!server?.url) return { ok: false, reason: 'not-ready' };
  const win = ensureMainWindow();
  await loadHarnessWithFallback(win, server.url);
  return { ok: true };
}

// ── 启动 / 重启 / 停止 ──────────────────────────────────────────────────────
function handleBootFailure(described) {
  logger.error(`启动失败：${described?.message}`, 'boot');
  broadcast('boot:failed', described);
  trayController?.refresh();
  rebuildMenu();
}

async function startHarness({ reason = '手动' } = {}) {
  if (server.running) return { ok: true, already: true };
  logger.info(`开始启动 harness（${reason}）`, 'boot');
  const snapshot = await boot.start();
  if (snapshot.error) {
    handleBootFailure(snapshot.error);
    return { ok: false, error: snapshot.error };
  }
  const win = ensureMainWindow();
  if (!selfTestMode) await loadHarnessWithFallback(win, server.url);
  return { ok: true, snapshot };
}

async function stopHarness() {
  clearTimeout(restartTimer);
  await server.stop();
  crashTimes = [];
}

async function restartServer(reason = '手动') {
  clearTimeout(restartTimer);
  logger.info(`重启 harness 服务（${reason}）`, 'boot');
  broadcast('server:restarting', { reason });
  await server.stop();
  crashTimes = [];
  const result = await startHarness({ reason: `重启：${reason}` });
  if (!result.ok) {
    await showBootPage();
  }
  return result;
}

function scheduleAutoRestart() {
  if (quitting || selfTestMode) return;
  if (!settings.get('autoRestart')) {
    logger.info('自动重启已关闭，等待手动处理', 'boot');
    return;
  }
  const now = Date.now();
  crashTimes = crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
  if (crashTimes.length >= MAX_AUTO_RESTARTS) {
    logger.error(`10 分钟内已崩溃 ${crashTimes.length} 次，停止自动重启`, 'boot');
    notify('harness 反复退出', '自动重启已暂停，请查看日志排查。');
    showBootPage();
    return;
  }
  const wait = CRASH_BACKOFF[Math.min(crashTimes.length, CRASH_BACKOFF.length - 1)];
  crashTimes.push(now);
  logger.warn(`${Math.round(wait / 1000)} 秒后自动重启（第 ${crashTimes.length} 次）`, 'boot');
  broadcast('server:autoRestart', { wait, attempt: crashTimes.length });
  restartTimer = setTimeout(() => {
    startHarness({ reason: '自动重启' }).catch((error) => logger.error(`自动重启失败：${error.message}`, 'boot'));
  }, wait);
}

// ── 设置窗口 ────────────────────────────────────────────────────────────────
function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 820,
    height: 860,
    minWidth: 640,
    minHeight: 560,
    show: false,
    title: '设置 — DeepSeek Harness 桌面端',
    backgroundColor: resolvedTheme() === 'dark' ? '#0b1020' : '#f5f7fb',
    autoHideMenuBar: true,
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      partition: 'persist:dsh-desktop',
    },
  });
  applyPermissionPolicy(session.fromPartition('persist:dsh-desktop'), logger);
  loadBootPage(settingsWindow, bootPageQuery({ view: 'settings' }));
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ── 托盘 / 菜单 ─────────────────────────────────────────────────────────────
function trayState() {
  return {
    server: server.snapshot(),
    boot: boot.snapshot(),
    uiVisible: !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
  };
}

const trayActions = {
  openMain: () => openHarness().catch(() => {}),
  showBootPage: () => showBootPage().catch(() => {}),
  reloadUi: () => reloadUi().catch(() => {}),
  restartServer: () => restartServer('托盘'),
  startServer: () => startHarness({ reason: '托盘' }).then((r) => (r.ok ? openHarness() : showBootPage())),
  stopServer: () => stopHarness(),
  openSettings: () => openSettingsWindow(),
  openLogFile: () => openLogFile(),
  openDataDir: () => shell.openPath(app.getPath('userData')).catch(() => {}),
  toggleMain: () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      bootPageOrHarness().catch(() => {});
      return;
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  },
  quit: () => quitApp(),
};

function rebuildMenu() {
  const menu = buildMenu({
    isDev,
    getState: trayState,
    actions: {
      ...trayActions,
      copyDiagnostics: () => copyDiagnostics(),
      checkRuntimeUpdate: () => checkRuntimeUpdate().then((result) => notifyUpdate(result)),
      hideWindow: () => mainWindow?.hide(),
    },
  });
  Menu.setApplicationMenu(menu);
}

// ── 诊断 / 更新检查 ─────────────────────────────────────────────────────────
function copyDiagnostics() {
  const text = buildDiagnostics();
  clipboard.writeText(text);
  return text;
}

async function checkRuntimeUpdate() {
  const runtime = resolveDshRuntime(contextForRuntime());
  const current = runtime.version || null;
  try {
    const response = await net.fetch('https://registry.npmjs.org/@deepseek-ai/dsh/latest', {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latest = data.version || null;
    const hasUpdate = !!(current && latest && compareVersions(parseNodeVersion(latest), parseNodeVersion(current)) > 0);
    return { ok: true, current, latest, hasUpdate };
  } catch (error) {
    return { ok: false, current, error: error.message };
  }
}

function notifyUpdate(result) {
  if (result?.ok && result.hasUpdate) {
    notify('DeepSeek Harness 有新版本', `当前 ${result.current} → 最新 ${result.latest}。可在设置里切换运行时来源或执行 npm i -g @deepseek-ai/dsh@${result.latest}。`);
  }
}

function openLogFile() {
  const file = logger?.filePath;
  if (!file || !fs.existsSync(file)) {
    logger?.ensureDir();
    return shell.openPath(path.dirname(file || app.getPath('userData'))).catch(() => {});
  }
  return shell.openPath(file).catch(() => {});
}

// ── 退出 ────────────────────────────────────────────────────────────────────
async function quitApp() {
  if (quitting) return;
  quitting = true;
  logger.info('正在退出…', 'app');
  clearTimeout(restartTimer);
  try {
    await Promise.race([server.stop(), new Promise((resolve) => setTimeout(resolve, 12000))]);
  } catch {
    /* 退出流程不阻断 */
  }
  logger.close();
  app.exit(0);
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  handle('shell:state', () => ({
    shell: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      isDev,
      isPackaged: app.isPackaged,
    },
    server: server.snapshot(),
    boot: boot.snapshot(),
    settings: settings.all(),
    theme: resolvedTheme(),
    paths: {
      userData: app.getPath('userData'),
      logs: path.join(app.getPath('userData'), 'logs'),
      dshHome: dshHome(),
      appRoot: APP_ROOT,
    },
    harnessUrl: server.url,
  }));

  handle('shell:bootstrap', () => ({
    state: {
      shell: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, isDev },
      server: server.snapshot(),
      boot: boot.snapshot(),
      settings: settings.all(),
      theme: resolvedTheme(),
      harnessUrl: server.url,
    },
    logs: logger.getEntries().slice(-600),
  }));

  handle('shell:boot:start', () => startHarness({ reason: '界面' }));
  handle('shell:boot:retry', () => restartServer('界面重试'));
  handle('shell:server:stop', async () => {
    await stopHarness();
    return server.snapshot();
  });
  handle('shell:server:restart', () => restartServer('界面'));
  handle('shell:ui:reload', async () => {
    await reloadUi();
    return true;
  });
  handle('shell:ui:openHarness', () => openHarness());
  handle('shell:ui:showBoot', async () => {
    await showBootPage();
    return true;
  });

  handle('shell:settings:get', () => settings.all());
  handle('shell:settings:set', (patch) => {
    const next = settings.set(patch || {});
    if (patch && 'theme' in patch) nativeTheme.themeSource = patch.theme;
    if (patch && 'openAtLogin' in patch) applyLoginItem();
    broadcast('settings:changed', next);
    trayController?.refresh();
    rebuildMenu();
    return next;
  });
  handle('shell:settings:reset', () => {
    const next = settings.reset();
    broadcast('settings:changed', next);
    return next;
  });
  handle('shell:settings:closeWindow', () => {
    settingsWindow?.close();
    return true;
  });

  handle('shell:logs:get', () => logger.getEntries());
  handle('shell:logs:clear', () => {
    logger.clear();
    return true;
  });
  handle('shell:logs:openFile', () => openLogFile());
  handle('shell:logs:openFolder', () => shell.openPath(path.join(app.getPath('userData'), 'logs')).catch(() => {}));

  handle('shell:diag:get', () => buildDiagnostics());
  handle('shell:runtime:checkUpdate', () => checkRuntimeUpdate());

  handle('shell:app:openExternal', (url) => {
    const target = String(url || '');
    if (!/^https?:\/\//i.test(target)) return false;
    shell.openExternal(target).catch(() => {});
    return true;
  });
  handle('shell:app:openPath', (target) => {
    const value = String(target || '');
    if (!value) return false;
    return shell.openPath(value).catch(() => false);
  });
  handle('shell:app:quit', () => quitApp());
  handle('shell:app:hide', () => {
    mainWindow?.hide();
    return true;
  });
}

function applyLoginItem() {
  if (!['win32', 'darwin'].includes(process.platform)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.get('openAtLogin'), openAsHidden: true });
  } catch {
    /* 某些受管环境不允许写自启项 */
  }
}

// ── 自检流程 ────────────────────────────────────────────────────────────────
async function runUiSelfTest() {
  const outDir = path.join(APP_ROOT, '.self-test', 'ui');
  selfTest = createSelfTest({ mode: 'ui', outDir, logger });
  const win = ensureMainWindow();
  const states = [
    { demo: 'loading', name: '01-boot-loading' },
    { demo: 'ready', name: '02-boot-ready' },
    { demo: 'error', name: '03-boot-error' },
    { demo: 'settings', name: '04-settings' },
  ];
  for (const item of states) {
    await loadBootPage(win, bootPageQuery({ demo: item.demo, theme: 'dark' }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    await selfTest.capture(win, item.name);
    await loadBootPage(win, bootPageQuery({ demo: item.demo, theme: 'light' }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    await selfTest.capture(win, `${item.name}-light`);
  }
  selfTest.check('界面自检完成', true, `共 ${selfTest.report.screenshots.length} 张截图`);
  selfTest.finish(0);
  app.exit(0);
}

async function runFullSelfTest() {
  const outDir = path.join(APP_ROOT, '.self-test', 'full');
  selfTest = createSelfTest({ mode: 'full', outDir, logger });
  selfTest.attachSession(session.fromPartition('persist:dsh-desktop'));

  const win = ensureMainWindow();
  selfTest.attach(win);
  await loadBootPage(win, bootPageQuery({ theme: 'dark' }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  await selfTest.capture(win, '01-boot-page');

  const result = await boot.start();
  selfTest.check('启动流程无错误', !result.error, result.error ? `${result.error.code}: ${result.error.message}` : '四步全部完成');
  if (result.error) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await selfTest.capture(win, '02-boot-failed');
    selfTest.finish(1, { bootError: result.error });
    app.exit(1);
    return;
  }

  selfTest.check('解析到带令牌的访问地址', !!server.url && !!server.token, server.url ? `${server.host}:${server.port}` : '未拿到 URL');
  await selfTest.capture(win, '02-boot-success');

  const loaded = await loadHarnessWithFallback(win, server.url);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  await selfTest.capture(win, '03-harness-ui');

  const page = await selfTest.inspectPage(win);
  selfTest.check('官方界面加载成功', loaded.ok, `HTTP ${loaded.status || '—'} ${loaded.reason || ''}`.trim());
  selfTest.check('页面标题非空', !!page?.title, page?.title);
  selfTest.check('页面渲染出节点', (page?.nodeCount ?? 0) > 20, `${page?.nodeCount} 个节点`);
  selfTest.check(
    '无主要资源加载失败',
    !selfTest.report.failedLoads.some((item) => item.isMainFrame && !item.aborted),
    `${selfTest.report.failedLoads.filter((item) => !item.aborted).length} 条失败记录（已忽略 ${selfTest.report.failedLoads.filter((item) => item.aborted).length} 条正常导航切换）`,
  );

  const pageErrors = selfTest.report.console.filter((item) => item.level === 'error');
  selfTest.check('页面无 JS 报错', pageErrors.length === 0, pageErrors.length ? `${pageErrors.length} 条` : '干净');
  selfTest.check(
    '页面无接口级错误',
    selfTest.report.requestFailures.filter((item) => typeof item.status === 'number').length === 0,
    `${selfTest.report.requestFailures.length} 条请求未完成`,
  );

  const report = selfTest.finish(result.error ? 1 : 0, { bootSnapshot: result, page });
  const failed = report.checks.filter((item) => !item.ok);
  setTimeout(() => {
    app.exit(failed.length ? 1 : 0);
  }, 300);
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function main() {
  app.setName('DeepSeek Harness Desktop');
  if (process.platform === 'win32') app.setAppUserModelId('com.haydensmith.dsh-desktop');

  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });

  logger = new Logger({ dir: path.join(userData, 'logs') });
  logger.info(`DeepSeek Harness 桌面端 v${app.getVersion()} 启动`, 'app');
  logger.info(`Electron ${process.versions.electron} / Node ${process.versions.node} / ${process.platform} ${process.arch}`, 'app');

  settings = new Settings({ dir: userData });
  nativeTheme.themeSource = currentTheme();
  settings.on('change', (next, changed) => {
    logger.info(`设置已更新：${changed.join(', ')}`, 'settings');
    broadcast('settings:changed', next);
  });

  policy = new NavigationPolicy({ logger });
  server = new HarnessServer({ logger });
  boot = new BootController({ logger, server, getSettings, context: contextForRuntime() });

  // 事件 → 界面广播
  boot.on('progress', (snapshot) => broadcast('boot:progress', snapshot));
  boot.on('failed', (payload) => broadcast('boot:failed', payload));
  server.on('state', (snapshot) => {
    broadcast('server:state', snapshot);
    trayController?.refresh();
    rebuildMenu();
  });
  server.on('exit', (info) => {
    if (info.intentional) return;
    // 启动阶段就失败时，boot 流程已经把可操作的原因推给界面了，
    // 这里再自动重启只会和用户的排查过程打架。
    if (info.phase !== 'running') return;
    notify('harness 服务已退出', `退出码 ${info.code ?? 'null'}，正在尝试自动恢复。`);
    scheduleAutoRestart();
  });
  logger.on('entry', (entry) => broadcast('log', entry));

  registerIpc();
  rebuildMenu();

  applyLoginItem();

  if (selfTestMode === 'ui') {
    await runUiSelfTest();
    return;
  }

  trayController = createTray({ getState: trayState, actions: trayActions, logger });

  const win = ensureMainWindow();
  if (selfTestMode === 'full') {
    await runFullSelfTest();
    return;
  }

  await loadBootPage(win, bootPageQuery());
  startHarness({ reason: '首次启动' }).catch((error) => logger.error(`启动失败：${error.message}`, 'boot'));
}

// 单实例锁：第二次启动时聚焦已有窗口
if (selfTestMode) {
  app.whenReady().then(() =>
    main().catch((error) => {
      process.stderr.write(`启动失败：${error?.stack || error}\n`);
      app.exit(1);
    }),
  );
} else if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() =>
    main().catch((error) => {
      logger?.error(`主流程异常：${error?.stack || error}`, 'app');
      process.stderr.write(`启动失败：${error?.stack || error}\n`);
      app.exit(1);
    }),
  );

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) bootPageOrHarness().catch(() => {});
  });

  app.on('window-all-closed', () => {
    if (quitting) return;
    if (!settings?.get('closeToTray')) quitApp();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitApp();
  });
}

// 兜底：不因为未捕获异常静默死掉
process.on('uncaughtException', (error) => {
  logger?.error(`未捕获异常：${error?.stack || error}`, 'app');
});
process.on('unhandledRejection', (reason) => {
  logger?.error(`未处理的 Promise 拒绝：${reason?.stack || reason}`, 'app');
});

module.exports = { isShellSafeArgs };
