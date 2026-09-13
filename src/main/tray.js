'use strict';

/**
 * 系统托盘：状态常驻入口。关闭窗口后用户依然能从这里看到服务状态、重开界面或退出。
 */

const path = require('node:path');
const { Tray, Menu, nativeImage, app } = require('electron');

const STATE_LABEL = {
  idle: '未启动',
  starting: '正在启动',
  ready: '运行中',
  stopping: '正在停止',
  stopped: '已停止',
  crashed: '异常退出',
  error: '启动失败',
};

function resolveIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'tray.png'),
    path.join(__dirname, '..', '..', 'assets', 'icon.png'),
  ];
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

/**
 * @param {object} options
 * @param {() => object} options.getState 返回 { server, boot, uiVisible }
 * @param {Record<string, Function>} options.actions
 */
function createTray({ getState, actions, logger }) {
  const tray = new Tray(resolveIcon());
  tray.setIgnoreDoubleClickEvents(true);

  const render = () => {
    const state = getState() || {};
    const server = state.server || {};
    const label = STATE_LABEL[server.state] || server.state || '未知';
    const address = server.port ? ` · 127.0.0.1:${server.port}` : '';
    tray.setToolTip(`DeepSeek Harness 桌面端 — ${label}${address}`);

    const template = [
      { label: `状态：${label}${address}`, enabled: false },
      {
        label: server.dshVersion ? `运行时：dsh ${server.dshVersion}` : '运行时：未就绪',
        enabled: false,
      },
      { type: 'separator' },
      { label: '打开主界面', click: () => actions.openMain(), enabled: server.state === 'ready' },
      { label: '查看启动状态', click: () => actions.showBootPage() },
      { label: '重新加载界面', accelerator: 'CmdOrCtrl+R', click: () => actions.reloadUi(), enabled: server.state === 'ready' },
      { type: 'separator' },
      {
        label: server.state === 'ready' ? '重启 harness 服务' : '启动 harness 服务',
        click: () => (server.state === 'ready' ? actions.restartServer() : actions.startServer()),
      },
      { label: '停止 harness 服务', click: () => actions.stopServer(), enabled: !!server.pid },
      { type: 'separator' },
      { label: '设置…', click: () => actions.openSettings() },
      { label: '打开日志文件', click: () => actions.openLogFile() },
      { label: '打开数据目录', click: () => actions.openDataDir() },
      { type: 'separator' },
      { label: '退出', click: () => actions.quit() },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  tray.on('click', () => actions.toggleMain());
  render();
  logger?.debug('系统托盘已就绪', 'tray');

  return {
    tray,
    refresh: render,
    destroy: () => {
      try {
        tray.destroy();
      } catch {
        /* noop */
      }
    },
  };
}

module.exports = { createTray, STATE_LABEL };
