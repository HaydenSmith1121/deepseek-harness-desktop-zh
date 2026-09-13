'use strict';

/**
 * 引导页逻辑。只在主进程暴露的 __DSH_DESKTOP__ 接口上工作，不直接接触 Node。
 * 支持三种用法：
 *   - 正常启动页（默认）
 *   - 设置页（?view=settings，在独立窗口里以整页形式打开）
 *   - 视觉自检（?demo=loading|ready|error|settings，注入假数据，不依赖主进程）
 */

(() => {
  const api = window.__DSH_DESKTOP__ || null;
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') || 'main';
  const demo = params.get('demo');
  const demoMode = Boolean(demo);

  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body,
    badge: $('stateBadge'),
    orb: $('heroOrb'),
    heroTitle: $('heroTitle'),
    heroSub: $('heroSub'),
    steps: $('steps'),
    errorCard: $('errorCard'),
    errTitle: $('errTitle'),
    errCode: $('errCode'),
    errMsg: $('errMsg'),
    errHint: $('errHint'),
    errDetail: $('errDetail'),
    meta: $('meta'),
    btnOpen: $('btnOpen'),
    btnRetry: $('btnRetry'),
    btnLogs: $('btnLogs'),
    btnSettings: $('btnSettings'),
    btnDiag: $('btnDiag'),
    btnHide: $('btnHide'),
    logs: $('logs'),
    logview: $('logview'),
    logFollow: $('logFollow'),
    footInfo: $('footInfo'),
    drawer: $('settingsDrawer'),
    scrim: $('scrim'),
    toast: $('toast'),
    envInfo: $('envInfo'),
    saveHint: $('saveHint'),
  };

  const MAX_LOG_LINES = 1200;
  let logBuffer = [];
  let logsVisible = false;
  let currentState = null;
  let bootSnapshot = null;

  // ── 主题 ────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    const next = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
    document.documentElement.dataset.theme = next;
    return next;
  }
  applyTheme(params.get('theme') || 'dark');
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if ((currentState?.settings?.theme || 'system') === 'system') applyTheme('system');
  });

  // ── 小工具 ──────────────────────────────────────────────────────────────
  const escapeHtml = (text) =>
    String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function formatTime(ts) {
    const date = new Date(ts || Date.now());
    return date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function formatUptime(ms) {
    if (!ms || ms < 0) return '—';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
    return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  }

  let toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      setTimeout(() => {
        el.toast.hidden = true;
      }, 260);
    }, 2200);
  }

  // ── 渲染：状态徽标 / 主视觉 ─────────────────────────────────────────────
  const STATE_TEXT = {
    idle: '准备中',
    starting: '正在启动',
    ready: '运行中',
    stopping: '正在停止',
    stopped: '已停止',
    crashed: '异常退出',
    error: '启动失败',
  };

  function deriveVisualState() {
    if (bootSnapshot?.error) return 'error';
    const serverState = currentState?.server?.state || 'idle';
    if (serverState === 'ready') return 'ready';
    if (['crashed', 'error'].includes(serverState)) return 'error';
    if (['starting', 'stopping'].includes(serverState)) return 'starting';
    return 'starting';
  }

  function renderStatus() {
    const visual = deriveVisualState();
    const serverState = currentState?.server?.state || 'idle';
    const badgeState = bootSnapshot?.error ? 'error' : serverState === 'idle' ? 'starting' : serverState;
    el.badge.dataset.state = badgeState;
    el.badge.textContent = bootSnapshot?.error ? '启动失败' : STATE_TEXT[serverState] || serverState;

    el.orb.dataset.state = visual === 'ready' ? 'ready' : visual === 'error' ? 'error' : 'busy';

    if (visual === 'ready') {
      el.heroTitle.textContent = '服务已就绪';
      el.heroSub.textContent = `DeepSeek Harness 正在本机 ${currentState?.server?.host || '127.0.0.1'}:${currentState?.server?.port || ''} 运行，可以进入主界面开始工作。`;
    } else if (visual === 'error') {
      el.heroTitle.textContent = '启动未能完成';
      el.heroSub.textContent = '按下面的提示处理后重试即可，日志里有完整的排查线索。';
    } else {
      el.heroTitle.textContent = '正在启动 DeepSeek Harness';
      el.heroSub.textContent = '正在检查运行时并拉起本地服务，通常需要 5–15 秒。';
    }

    el.btnOpen.hidden = visual !== 'ready';
    el.btnRetry.hidden = visual !== 'error';
  }

  // ── 渲染：步骤 ──────────────────────────────────────────────────────────
  const STEP_FALLBACK = [
    { id: 'runtime', label: '探测运行时', hint: '定位 Node 与 dsh' },
    { id: 'plan', label: '准备启动参数', hint: '分配端口' },
    { id: 'service', label: '启动 harness 服务', hint: '拉起 dsh web' },
    { id: 'ready', label: '等待服务就绪', hint: '解析访问地址' },
  ];

  function renderSteps() {
    const steps = bootSnapshot?.steps?.length ? bootSnapshot.steps : STEP_FALLBACK.map((step, index) => ({ ...step, status: index === 0 ? 'active' : 'pending', detail: null }));
    el.steps.innerHTML = steps
      .map((step, index) => {
        const status = step.status || 'pending';
        const marker = status === 'done' ? '✓' : status === 'error' ? '!' : String(index + 1);
        const detail = step.detail ? escapeHtml(step.detail) : status === 'pending' ? escapeHtml(step.hint || '') : '';
        return `<li class="step" data-status="${status}" title="${escapeHtml(step.hint || '')}">
          <span class="step-marker"><span>${marker}</span></span>
          <span class="step-label">${escapeHtml(step.label)}</span>
          <span class="step-detail">${detail}</span>
        </li>`;
      })
      .join('');
  }

  // ── 渲染：错误卡 ────────────────────────────────────────────────────────
  function renderError() {
    const error = bootSnapshot?.error;
    if (!error) {
      el.errorCard.hidden = true;
      return;
    }
    el.errorCard.hidden = false;
    el.errCode.textContent = error.code || 'ERROR';
    el.errMsg.textContent = error.message || '未知错误';
    el.errHint.textContent = error.hint || '';
    if (error.detail) {
      el.errDetail.hidden = false;
      el.errDetail.textContent = error.detail;
    } else {
      el.errDetail.hidden = true;
    }
  }

  // ── 渲染：元信息 ────────────────────────────────────────────────────────
  function renderMeta() {
    const server = currentState?.server || {};
    const plan = bootSnapshot?.plan || null;
    const cards = [];

    if (plan?.dshVersion) {
      const source = SOURCE_LABEL[plan.source] || plan.source || '';
      cards.push([source ? `dsh 运行时 · ${source}` : 'dsh 运行时', `v${plan.dshVersion}`]);
    }
    if (plan?.nodeVersion) cards.push(['Node', formatNode(plan.nodeVersion)]);
    if (server.port) cards.push(['监听地址', `${server.host || '127.0.0.1'}:${server.port}`]);
    if (server.pid) cards.push(['进程 PID', server.uptimeMs ? `${server.pid} · ${formatUptime(server.uptimeMs)}` : String(server.pid)]);

    el.meta.innerHTML = cards
      .map(
        ([label, value]) =>
          `<div class="meta-card"><dt title="${escapeHtml(label)}">${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(
            value,
          )}</dd></div>`,
      )
      .join('');
  }

  const SOURCE_LABEL = { local: '本机安装', bundled: '应用内置', setting: '手动指定', env: '环境变量', npx: 'npx 拉取' };

  function formatNode(version) {
    if (Array.isArray(version)) return `v${version.join('.')}`;
    return version ? `v${version}` : '—';
  }

  // ── 渲染：日志 ──────────────────────────────────────────────────────────
  function logLineHtml(entry) {
    return `<div class="logline" data-level="${escapeHtml(entry.level)}"><span class="t">${formatTime(
      entry.ts,
    )}</span><span class="s">${escapeHtml(entry.scope || 'app')}</span><span class="m">${escapeHtml(entry.text)}</span></div>`;
  }

  function appendLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
    if (!logsVisible) return;
    const atBottom = el.logview.scrollHeight - el.logview.scrollTop - el.logview.clientHeight < 40;
    el.logview.insertAdjacentHTML('beforeend', logLineHtml(entry));
    while (el.logview.childElementCount > MAX_LOG_LINES) el.logview.firstElementChild.remove();
    if (el.logFollow.checked || atBottom) el.logview.scrollTop = el.logview.scrollHeight;
  }

  function renderLogBuffer() {
    if (!logBuffer.length) {
      el.logview.innerHTML = '<span class="log-empty">暂无日志输出。</span>';
      return;
    }
    el.logview.innerHTML = logBuffer.map(logLineHtml).join('');
    if (el.logFollow.checked) el.logview.scrollTop = el.logview.scrollHeight;
  }

  function toggleLogs(force) {
    logsVisible = force ?? !logsVisible;
    el.logs.hidden = !logsVisible;
    if (logsVisible) renderLogBuffer();
  }

  // ── 渲染：环境信息 ──────────────────────────────────────────────────────
  function renderEnvInfo() {
    const shell = currentState?.shell || {};
    const paths = currentState?.paths || {};
    const plan = bootSnapshot?.plan || null;
    const rows = [
      ['桌面壳版本', `v${shell.version || '—'}`],
      ['Electron', shell.electron || '—'],
      ['内置 Node', shell.node || '—'],
      ['dsh 运行时', plan?.dshVersion ? `v${plan.dshVersion}（${SOURCE_LABEL[plan.source] || plan.source}）` : '未就绪'],
      ['数据目录', paths.userData || '—'],
      ['日志目录', paths.logs || '—'],
      ['DSH_HOME', paths.dshHome || '—'],
      ['系统', shell.platform || '—'],
    ];
    el.envInfo.innerHTML = rows
      .map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd></div>`)
      .join('');
  }

  // ── 设置表单 ────────────────────────────────────────────────────────────
  const FIELD_MAP = {
    runtimeMode: 'setRuntimeMode',
    dshPath: 'setDshPath',
    nodePath: 'setNodePath',
    host: 'setHost',
    port: 'setPort',
    extraArgs: 'setExtraArgs',
    proxy: 'setProxy',
    theme: 'setTheme',
    closeToTray: 'setCloseToTray',
    autoRestart: 'setAutoRestart',
    openAtLogin: 'setOpenAtLogin',
    showLogsOnBoot: 'setShowLogsOnBoot',
  };

  function fillSettingsForm(values) {
    if (!values) return;
    for (const [key, id] of Object.entries(FIELD_MAP)) {
      const node = $(id);
      if (!node) continue;
      if (node.type === 'checkbox') node.checked = Boolean(values[key]);
      else node.value = values[key] ?? '';
    }
  }

  function collectSettingsForm() {
    const patch = {};
    for (const [key, id] of Object.entries(FIELD_MAP)) {
      const node = $(id);
      if (!node) continue;
      if (node.type === 'checkbox') patch[key] = node.checked;
      else if (key === 'port') patch[key] = Number(node.value) || 0;
      else patch[key] = node.value;
    }
    return patch;
  }

  function openDrawer() {
    el.drawer.classList.add('open');
    el.drawer.setAttribute('aria-hidden', 'false');
    el.scrim.hidden = false;
    el.saveHint.textContent = '';
  }

  function closeDrawer() {
    if (view === 'settings') {
      api?.closeSettingsWindow?.();
      return;
    }
    el.drawer.classList.remove('open');
    el.drawer.setAttribute('aria-hidden', 'true');
    el.scrim.hidden = true;
  }

  // ── 交互绑定 ────────────────────────────────────────────────────────────
  el.btnLogs.addEventListener('click', () => toggleLogs());
  el.btnSettings.addEventListener('click', openDrawer);
  $('settingsClose').addEventListener('click', closeDrawer);
  el.scrim.addEventListener('click', closeDrawer);
  $('btnLogClose').addEventListener('click', () => toggleLogs(false));
  $('btnLogClear').addEventListener('click', async () => {
    logBuffer = [];
    await api?.clearLogs?.();
    renderLogBuffer();
  });
  $('btnLogFile').addEventListener('click', () => api?.openLogFile?.());
  $('btnLogFolder').addEventListener('click', () => api?.openLogsFolder?.());

  el.btnOpen.addEventListener('click', async () => {
    if (demoMode) return toast('演示模式：不会真的加载界面');
    await api?.openHarness?.();
  });

  el.btnRetry.addEventListener('click', async () => {
    if (demoMode) return toast('演示模式：不会真的重试');
    bootSnapshot = { ...(bootSnapshot || {}), error: null };
    renderError();
    renderStatus();
    await api?.retry?.();
  });

  el.btnDiag.addEventListener('click', async () => {
    if (demoMode) return toast('演示模式：已复制（示意）');
    const text = await api?.getDiagnostics?.();
    if (text) toast('诊断信息已复制到剪贴板');
  });

  el.btnHide.addEventListener('click', () => api?.hideWindow?.());

  $('btnTheme').addEventListener('click', async () => {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    if (demoMode) return;
    await api?.setSettings?.({ theme: next });
  });

  $('settingsSave').addEventListener('click', async () => {
    if (demoMode) return toast('演示模式：设置未保存');
    const patch = collectSettingsForm();
    const saved = await api?.setSettings?.(patch);
    fillSettingsForm(saved);
    renderEnvInfo();
    el.saveHint.textContent = '已保存 ✓';
    toast('设置已保存');
    setTimeout(() => {
      el.saveHint.textContent = '';
    }, 2600);
  });

  $('settingsReset').addEventListener('click', async () => {
    if (demoMode) return toast('演示模式：未重置');
    const values = await api?.resetSettings?.();
    fillSettingsForm(values);
    toast('已恢复默认设置');
  });

  $('btnCheckUpdate').addEventListener('click', async () => {
    if (demoMode) return toast('演示模式：跳过检查');
    const button = $('btnCheckUpdate');
    button.disabled = true;
    button.textContent = '检查中…';
    try {
      const result = await api?.checkRuntimeUpdate?.();
      if (!result?.ok) toast(`检查失败：${result?.error || '未知原因'}`);
      else if (!result.current) toast(`当前未检测到本机 dsh，最新版本 v${result.latest}`);
      else if (result.hasUpdate) toast(`有更新：v${result.current} → v${result.latest}`);
      else toast(`已是最新版本 v${result.current}`);
    } finally {
      button.disabled = false;
      button.textContent = '检查 dsh 更新';
    }
  });

  document.querySelectorAll('a[data-ext]').forEach((anchor) => {
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      api?.openExternal?.(anchor.dataset.ext);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  el.logview.addEventListener('scroll', () => {
    const atBottom = el.logview.scrollHeight - el.logview.scrollTop - el.logview.clientHeight < 40;
    if (!atBottom && el.logFollow.checked) el.logFollow.checked = false;
  });

  // ── 状态装配 ────────────────────────────────────────────────────────────
  function renderAll() {
    renderStatus();
    renderSteps();
    renderError();
    renderMeta();
    renderEnvInfo();
  }

  async function bootstrap() {
    if (demoMode) return;
    const payload = await api?.bootstrap?.();
    if (!payload) return;
    currentState = payload.state;
    bootSnapshot = payload.state?.boot || null;
    logBuffer = payload.logs || [];
    if (currentState?.settings?.showLogsOnBoot) logsVisible = true;
    if (typeof currentState?.settings?.theme === 'string') applyTheme(currentState.settings.theme);
    fillSettingsForm(currentState.settings);
    el.logs.hidden = !logsVisible;
    if (logsVisible) renderLogBuffer();
    const shell = currentState.shell || {};
    el.footInfo.textContent = `DeepSeek Harness 桌面端 v${shell.version || '—'} · Electron ${shell.electron || '—'}`;
    renderAll();
  }

  function handleEvent(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'boot:progress':
        bootSnapshot = message.payload;
        renderAll();
        break;
      case 'boot:failed':
        bootSnapshot = { ...(bootSnapshot || {}), ...message.payload, error: message.payload?.error || message.payload };
        renderAll();
        break;
      case 'server:state':
        currentState = { ...(currentState || {}), server: message.payload };
        renderAll();
        break;
      case 'settings:changed':
        currentState = { ...(currentState || {}), settings: message.payload };
        renderEnvInfo();
        if (!el.drawer.classList.contains('open')) fillSettingsForm(message.payload);
        break;
      case 'log':
        appendLog(message.payload);
        break;
      default:
        break;
    }
  }

  // ── 演示数据（视觉自检用）───────────────────────────────────────────────
  function loadDemo(state) {
    const shell = { version: '1.0.0', electron: '44.3.0', node: '22.19.0', platform: 'win32 x64', isDev: false };
    const paths = {
      userData: 'C:\\Users\\Administrator\\AppData\\Roaming\\DeepSeek Harness Desktop',
      logs: 'C:\\Users\\Administrator\\AppData\\Roaming\\DeepSeek Harness Desktop\\logs',
      dshHome: 'C:\\Users\\Administrator\\.dsh',
    };
    const baseSettings = {
      runtimeMode: 'auto',
      dshPath: '',
      nodePath: '',
      host: '127.0.0.1',
      port: 0,
      extraArgs: '',
      proxy: '',
      theme: 'dark',
      closeToTray: true,
      autoRestart: true,
      openAtLogin: false,
      showLogsOnBoot: true,
    };
    currentState = { shell, paths, settings: baseSettings, server: { state: 'idle', port: null, pid: null }, boot: null };
    el.footInfo.textContent = `DeepSeek Harness 桌面端 v${shell.version} · Electron ${shell.electron}`;

    const readySteps = [
      { id: 'runtime', label: '探测运行时', status: 'done', detail: 'dsh 0.1.5-rc.1（本机安装）· Node 22.22.2' },
      { id: 'plan', label: '准备启动参数', status: 'done', detail: '127.0.0.1:52348（自动分配）' },
      { id: 'service', label: '启动 harness 服务', status: 'done', detail: '子进程 pid=18452' },
      { id: 'ready', label: '等待服务就绪', status: 'done', detail: '已就绪：127.0.0.1:52348' },
    ];

    if (state === 'loading') {
      bootSnapshot = {
        steps: [
          { id: 'runtime', label: '探测运行时', status: 'done', detail: 'dsh 0.1.5-rc.1（本机安装）· Node 22.22.2' },
          { id: 'plan', label: '准备启动参数', status: 'done', detail: '127.0.0.1:52348（自动分配）' },
          { id: 'service', label: '启动 harness 服务', status: 'active', detail: '正在拉起 dsh web…' },
          { id: 'ready', label: '等待服务就绪', status: 'pending', detail: null },
        ],
        error: null,
        plan: { source: 'local', port: 52348, host: '127.0.0.1', dshVersion: '0.1.5-rc.1', nodeVersion: [22, 22, 2] },
      };
      currentState.server = { state: 'starting', port: 52348, pid: 18452, host: '127.0.0.1', uptimeMs: 0 };
      logBuffer = [
        { ts: Date.now() - 4200, level: 'info', scope: 'app', text: 'DeepSeek Harness 桌面端 v1.0.0 启动' },
        { ts: Date.now() - 4100, level: 'info', scope: 'boot', text: '开始启动 harness（首次启动）' },
        { ts: Date.now() - 3600, level: 'info', scope: 'server', text: '启动 harness：C:\\Program Files\\nodejs\\node.exe ...\\lib\\bin.js web --no-open --host 127.0.0.1 --port 52348' },
        { ts: Date.now() - 1200, level: 'harness', scope: 'harness', text: 'dsh 正在组合 profile（web）…' },
      ];
    } else if (state === 'ready') {
      bootSnapshot = { steps: readySteps, error: null, plan: { source: 'local', port: 52348, host: '127.0.0.1', dshVersion: '0.1.5-rc.1', nodeVersion: [22, 22, 2] } };
      currentState.server = { state: 'ready', port: 52348, pid: 18452, host: '127.0.0.1', uptimeMs: 96000, dshVersion: '0.1.5-rc.1' };
      logBuffer = [
        { ts: Date.now() - 96000, level: 'info', scope: 'app', text: 'DeepSeek Harness 桌面端 v1.0.0 启动' },
        { ts: Date.now() - 95000, level: 'info', scope: 'boot', text: '开始启动 harness（首次启动）' },
        { ts: Date.now() - 88000, level: 'harness', scope: 'harness', text: 'dsh web: http://127.0.0.1:52348/?token=***' },
        { ts: Date.now() - 87000, level: 'info', scope: 'boot', text: 'harness 已就绪：http://127.0.0.1:52348/?token=***' },
        { ts: Date.now() - 86000, level: 'info', scope: 'window', text: 'harness 界面已加载' },
      ];
    } else {
      bootSnapshot = {
        steps: [
          { id: 'runtime', label: '探测运行时', status: 'error', detail: '未找到可用的 dsh 运行时' },
          { id: 'plan', label: '准备启动参数', status: 'pending', detail: null },
          { id: 'service', label: '启动 harness 服务', status: 'pending', detail: null },
          { id: 'ready', label: '等待服务就绪', status: 'pending', detail: null },
        ],
        error: {
          code: 'EDSHNOTFOUND',
          message: '未找到可用的 DeepSeek Harness（dsh）运行时：本机未安装，且应用未内置副本。',
          hint: '在终端执行：npm i -g @deepseek-ai/dsh@0.1.5-rc.1（或在设置里手动指定 dsh 路径）。',
          detail: '尝试过的位置：\n  C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\n  C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\n  <应用目录>\\resources\\dsh',
        },
        plan: null,
      };
      logBuffer = [
        { ts: Date.now() - 3000, level: 'info', scope: 'app', text: 'DeepSeek Harness 桌面端 v1.0.0 启动' },
        { ts: Date.now() - 2400, level: 'error', scope: 'boot', text: '启动失败[EDSHNOTFOUND]：未找到可用的 DeepSeek Harness（dsh）运行时' },
      ];
    }

    if (state === 'settings' || view === 'settings') openDrawer();
    renderAll();
    if (logsVisible) renderLogBuffer();
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  document.body.dataset.view = view;

  if (demoMode) {
    loadDemo(demo);
  } else {
    api?.onEvent?.(handleEvent);
    bootstrap();
  }

  if (view === 'settings') {
    el.drawer.classList.add('open');
    el.drawer.setAttribute('aria-hidden', 'false');
  }
})();
