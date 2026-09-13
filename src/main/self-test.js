'use strict';

/**
 * 自检（--self-test / --self-test-ui）
 *
 * 目的：在没有人工点击的前提下，端到端验证「桌面壳 + harness」这条链路真的通了，
 * 并把界面截图落盘，便于肉眼复查视觉。退出码即结论：0 通过，非 0 失败。
 *
 * 采集内容：
 * - 每一步的窗口截图（引导页 / 就绪后 / 官方界面）
 * - 导航响应码、最终地址、文档标题
 * - console 消息（区分 error / warn）、页面未捕获异常、资源加载失败
 */

const fs = require('node:fs');
const path = require('node:path');

/** 兼容 Electron 不同版本的 console-message 参数形态。 */
function extractConsoleMessage(args) {
  const first = args[0];
  if (args.length === 1 && first && typeof first === 'object' && 'message' in first) {
    return {
      level: String(first.level ?? 'info'),
      message: String(first.message ?? ''),
      line: Number(first.lineNumber ?? 0),
      source: String(first.sourceId ?? ''),
    };
  }
  const [, level, message, line, sourceId] = args;
  return {
    level: String(level ?? 'info'),
    message: String(message ?? ''),
    line: Number(line ?? 0),
    source: String(sourceId ?? ''),
  };
}

const LEVEL_NAME = { 0: 'verbose', 1: 'info', 2: 'warning', 3: 'error' };

function createSelfTest({ mode, outDir, logger }) {
  const report = {
    mode,
    startedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    navigations: [],
    console: [],
    pageErrors: [],
    failedLoads: [],
    requestFailures: [],
    screenshots: [],
    checks: [],
    finished: false,
  };

  fs.mkdirSync(outDir, { recursive: true });

  const attach = (win) => {
    const wc = win.webContents;

    wc.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
      report.navigations.push({ url, httpResponseCode, httpStatusText, at: new Date().toISOString() });
      logger?.info(`[自检] 导航 ${httpResponseCode} ${url}`, 'self-test');
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED：导航被后续导航取代（引导页 → 官方界面 属于正常切换）
      const aborted = errorCode === -3;
      report.failedLoads.push({ errorCode, errorDescription, validatedURL, isMainFrame, aborted });
      if (!aborted) logger?.error(`[自检] 加载失败 ${errorCode} ${errorDescription} ${validatedURL}`, 'self-test');
    });

    wc.on('console-message', (...args) => {
      const detail = extractConsoleMessage(args);
      const level = LEVEL_NAME[detail.level] || detail.level;
      if (report.console.length < 500) report.console.push({ ...detail, level });
      if (level === 'error') logger?.error(`[自检][页面] ${detail.message}`, 'self-test');
    });

    wc.on('render-process-gone', (_event, details) => {
      report.pageErrors.push({ type: 'render-process-gone', details });
    });

    wc.on('preload-error', (_event, preloadPath, error) => {
      report.pageErrors.push({ type: 'preload-error', preloadPath, message: error?.message });
    });

    try {
      wc.executeJavaScript(
        `window.addEventListener('error', (e) => { console.error('[uncaught] ' + (e.message || e.type)); });
         window.addEventListener('unhandledrejection', (e) => { console.error('[unhandledrejection] ' + (e.reason && e.reason.message ? e.reason.message : e.reason)); });
         true;`,
        true,
      );
    } catch {
      /* 页面尚未就绪时忽略 */
    }
  };

  const attachSession = (targetSession) => {
    targetSession.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
      if (details.statusCode >= 400 && report.requestFailures.length < 200) {
        report.requestFailures.push({ url: details.url, status: details.statusCode, resourceType: details.resourceType });
      }
    });
    targetSession.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, (details) => {
      if (report.requestFailures.length < 200) {
        report.requestFailures.push({ url: details.url, error: details.error, resourceType: details.resourceType });
      }
    });
  };

  const capture = async (win, name) => {
    try {
      // 等一帧，避免截到未绘制完成的画面
      await new Promise((resolve) => setTimeout(resolve, 350));
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, image.toPNG());
      report.screenshots.push(file);
      logger?.info(`[自检] 截图 ${file}`, 'self-test');
      return file;
    } catch (error) {
      logger?.warn(`[自检] 截图失败 ${name}: ${error.message}`, 'self-test');
      return null;
    }
  };

  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, detail: detail ?? null });
    logger?.[ok ? 'info' : 'error'](`[自检] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`, 'self-test');
    return !!ok;
  };

  const inspectPage = async (win) => {
    try {
      const info = await win.webContents.executeJavaScript(
        `(() => ({
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            hasRoot: !!(document.querySelector('#app, #root, main, .dsh-root')),
            bodyClass: document.body ? document.body.className : '',
            textSample: (document.body ? document.body.innerText : '').slice(0, 400),
            nodeCount: document.querySelectorAll('*').length
          }))()`,
        true,
      );
      report.page = info;
      return info;
    } catch (error) {
      report.page = { error: error.message };
      return report.page;
    }
  };

  const finish = (exitCode, extra = {}) => {
    report.finished = true;
    report.finishedAt = new Date().toISOString();
    report.exitCode = exitCode;
    Object.assign(report, extra);
    const file = path.join(outDir, 'self-test-report.json');
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

    const failed = report.checks.filter((item) => !item.ok);
    const summary = [
      '',
      '════════ 自检报告 ════════',
      `模式        : ${mode}`,
      `结果        : ${exitCode === 0 ? 'PASS ✅' : 'FAIL ❌'}`,
      `检查项      : ${report.checks.length - failed.length}/${report.checks.length} 通过`,
      `页面标题    : ${report.page?.title ?? '—'}`,
      `最终地址    : ${report.page?.url ?? '—'}`,
      `console 错误: ${report.console.filter((c) => c.level === 'error').length}`,
      `请求失败    : ${report.requestFailures.length}`,
      `截图        : ${report.screenshots.length} 张 → ${outDir}`,
      '═════════════════════════',
      '',
    ].join('\n');
    process.stdout.write(`${summary}\n`);
    for (const item of failed) process.stdout.write(`  ✗ ${item.name} — ${item.detail ?? ''}\n`);
    if (failed.length) process.stdout.write('\n');
    return report;
  };

  return { report, attach, attachSession, capture, check, inspectPage, finish };
}

module.exports = { createSelfTest, extractConsoleMessage };
