'use strict';

/**
 * 预加载脚本：唯一的主进程桥。
 *
 * 注意它同时会被注入到 harness 官方界面里，因此这里只做两件「零侵入」的事：
 *   1. 暴露一个命名空间前缀的只读 API（官方界面不会碰它）
 *   2. 不做任何 DOM 修改、不做任何样式注入
 * 快捷键由主进程的 before-input-event 处理，不在这里挂监听。
 */

const { contextBridge, ipcRenderer } = require('electron');

const shellVersionArg = process.argv.find((arg) => arg.startsWith('--dsh-desktop-version='));
const shellVersion = shellVersionArg ? shellVersionArg.split('=')[1] : 'dev';

const listeners = new Set();

ipcRenderer.on('shell:event', (_event, payload) => {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      /* 渲染层回调用错不应该影响主进程 */
    }
  }
});

const api = {
  /** 桌面壳版本，用于界面展示与诊断 */
  version: shellVersion,
  /** 当前是否运行在官方 harness 页面里（用于界面按需显示浮动按钮） */
  isHarnessPage: true,

  getState: () => ipcRenderer.invoke('shell:state'),
  bootstrap: () => ipcRenderer.invoke('shell:bootstrap'),
  start: () => ipcRenderer.invoke('shell:boot:start'),
  retry: () => ipcRenderer.invoke('shell:boot:retry'),
  stop: () => ipcRenderer.invoke('shell:server:stop'),
  restartServer: () => ipcRenderer.invoke('shell:server:restart'),
  reloadUi: () => ipcRenderer.invoke('shell:ui:reload'),
  openHarness: () => ipcRenderer.invoke('shell:ui:openHarness'),
  showBootPage: () => ipcRenderer.invoke('shell:ui:showBoot'),

  getSettings: () => ipcRenderer.invoke('shell:settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('shell:settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('shell:settings:reset'),

  getLogs: () => ipcRenderer.invoke('shell:logs:get'),
  clearLogs: () => ipcRenderer.invoke('shell:logs:clear'),
  openLogFile: () => ipcRenderer.invoke('shell:logs:openFile'),
  openLogsFolder: () => ipcRenderer.invoke('shell:logs:openFolder'),

  getDiagnostics: () => ipcRenderer.invoke('shell:diag:get'),
  checkRuntimeUpdate: () => ipcRenderer.invoke('shell:runtime:checkUpdate'),

  openExternal: (url) => ipcRenderer.invoke('shell:app:openExternal', url),
  openPath: (target) => ipcRenderer.invoke('shell:app:openPath', target),
  quit: () => ipcRenderer.invoke('shell:app:quit'),
  hideWindow: () => ipcRenderer.invoke('shell:app:hide'),
  closeSettingsWindow: () => ipcRenderer.invoke('shell:settings:closeWindow'),

  onEvent: (listener) => {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

try {
  contextBridge.exposeInMainWorld('__DSH_DESKTOP__', Object.freeze(api));
} catch {
  // 极少见情况下（例如页面已抢先定义）静默失败，不能影响 harness 本体
}
