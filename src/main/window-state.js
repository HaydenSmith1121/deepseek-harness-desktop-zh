'use strict';

/**
 * 窗口位置记忆。纯函数 + 一点 Electron 粘合代码。
 * 显示器拔掉/分辨率变化后，旧坐标可能落在屏幕外，这里统一做可见性纠正。
 */

const DEFAULT_SIZE = { width: 1280, height: 840 };
/** 与 BrowserWindow 的 minWidth/minHeight 保持一致，避免存下来的尺寸又被窗口管理器改回去。 */
const MIN_SIZE = { width: 720, height: 520 };

/** 计算矩形与某个工作区矩形的交集面积。 */
function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

/**
 * 把记忆的窗口矩形纠正到当前至少有一个显示器可见的位置。
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<{workArea:{x:number,y:number,width:number,height:number}}>} displays
 */
function ensureVisible(bounds, displays = []) {
  if (!bounds) return { ...DEFAULT_SIZE, centered: true };
  const candidate = {
    x: Math.trunc(bounds.x),
    y: Math.trunc(bounds.y),
    width: Math.max(MIN_SIZE.width, Math.trunc(bounds.width)),
    height: Math.max(MIN_SIZE.height, Math.trunc(bounds.height)),
  };
  if (!displays.length) return { ...candidate, centered: true };

  const best = displays
    .map((display) => ({ display, area: intersectionArea(candidate, display.workArea) }))
    .sort((left, right) => right.area - left.area)[0];

  // 至少要有 25% 的可视面积，否则视为越界
  const needed = (candidate.width * candidate.height) * 0.25;
  if (best && best.area >= needed) return { ...candidate, maximized: Boolean(bounds.maximized) };

  const workArea = displays[0].workArea;
  return {
    width: Math.min(candidate.width, workArea.width),
    height: Math.min(candidate.height, workArea.height),
    x: Math.round(workArea.x + (workArea.width - Math.min(candidate.width, workArea.width)) / 2),
    y: Math.round(workArea.y + (workArea.height - Math.min(candidate.height, workArea.height)) / 2),
    maximized: Boolean(bounds.maximized),
  };
}

/** 从 BrowserWindow 读取可持久化的窗口状态。 */
function captureWindowState(win) {
  if (!win || win.isDestroyed()) return null;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  return { ...bounds, maximized };
}

module.exports = { DEFAULT_SIZE, MIN_SIZE, ensureVisible, captureWindowState, intersectionArea };
