'use strict';

/**
 * 应用菜单。桌面端要有的东西：重载、缩放、开发者工具、服务重启、帮助入口。
 */

const { Menu, app, shell } = require('electron');

const REPO_URL = 'https://github.com/HaydenSmith1121/deepseek-harness-desktop-zh';
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness';
const DOCS_URL = 'https://github.com/deepseek-ai/deepseek-harness#readme';

function buildMenu({ actions, getState, isDev }) {
  const state = getState() || {};
  const server = state.server || {};
  const running = server.state === 'ready';

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开主界面', accelerator: 'CmdOrCtrl+1', click: () => actions.openMain(), enabled: running },
        { label: '查看启动状态', accelerator: 'CmdOrCtrl+2', click: () => actions.showBootPage() },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => actions.openSettings() },
        { label: '打开日志文件', click: () => actions.openLogFile() },
        { label: '打开数据目录', click: () => actions.openDataDir() },
        { type: 'separator' },
        { label: '隐藏到托盘', accelerator: 'CmdOrCtrl+W', click: () => actions.hideWindow() },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => actions.quit() },
      ],
    },
    {
      label: '服务',
      submenu: [
        {
          label: running ? '重启 harness 服务' : '启动 harness 服务',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => (running ? actions.restartServer() : actions.startServer()),
        },
        { label: '停止 harness 服务', click: () => actions.stopServer(), enabled: !!server.pid },
        { type: 'separator' },
        { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: () => actions.reloadUi(), enabled: running },
        {
          label: '重新加载界面（忽略缓存）',
          accelerator: 'CmdOrCtrl+Shift+F5',
          click: () => actions.reloadUi({ ignoreCache: true }),
          enabled: running,
        },
        { type: 'separator' },
        { label: '复制诊断信息', click: () => actions.copyDiagnostics() },
        { label: '检查运行时更新', click: () => actions.checkRuntimeUpdate() },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'reload', label: '强制刷新', visible: false },
        ...(isDev ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [{ role: 'toggleDevTools', label: '开发者工具' }]),
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: 'DeepSeek Harness 官方仓库', click: () => shell.openExternal(UPSTREAM_URL) },
        { label: '官方文档', click: () => shell.openExternal(DOCS_URL) },
        { type: 'separator' },
        { label: '本项目仓库（GitHub）', click: () => shell.openExternal(REPO_URL) },
        { label: '提交问题（Issue）', click: () => shell.openExternal(`${REPO_URL}/issues`) },
        { type: 'separator' },
        {
          label: `版本：桌面壳 v${app.getVersion()}${server.dshVersion ? ` · dsh ${server.dshVersion}` : ''}`,
          enabled: false,
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu, REPO_URL, UPSTREAM_URL, DOCS_URL };
