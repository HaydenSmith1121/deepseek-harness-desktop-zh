'use strict';

/**
 * 启动编排：把「探测运行时 → 准备参数 → 拉起服务 → 等待就绪」串成有状态的步骤，
 * 每一步都向界面推送可读进度；失败时给出可操作的提示，而不是一个 ERR_STACK。
 */

const { EventEmitter } = require('node:events');
const { buildLaunchPlan, formatVersion } = require('./runtime');
const { isPortFree } = require('./ports');

const STEPS = Object.freeze([
  { id: 'runtime', label: '探测运行时', hint: '定位 Node 解释器与 DeepSeek Harness（dsh）' },
  { id: 'plan', label: '准备启动参数', hint: '分配空闲端口，组装命令行' },
  { id: 'service', label: '启动 harness 服务', hint: '以子进程方式拉起 dsh web' },
  { id: 'ready', label: '等待服务就绪', hint: '解析一次性令牌地址并加载官方界面' },
]);

/** 把底层错误翻译成用户能直接照做的提示。 */
function describeError(error, context = {}) {
  const code = error?.code || context.code || 'EUNKNOWN';
  const table = {
    EDSHNOTFOUND: {
      message: error?.message || '未找到 DeepSeek Harness（dsh）运行时。',
      hint: '在终端执行：npm i -g @deepseek-ai/dsh@0.1.5-rc.1（或在设置里手动指定 dsh 路径）。',
    },
    ENODEVERSION: {
      message: error?.message || 'Node.js 版本不满足要求。',
      hint: 'DeepSeek Harness 需要 Node.js v22.19 或更高，推荐 v24 LTS。装好后可在设置里指定 Node 路径。',
    },
    ENPXNOTFOUND: {
      message: error?.message || '未找到 npx。',
      hint: '请先安装 Node.js（自带 npm/npx），或在设置中切换到「本机 dsh」。',
    },
    EADDRINUSE: {
      message: `端口 ${context.port ?? ''} 已被占用。`.trim(),
      hint: '把设置里的端口改为 0（自动分配），或换一个空闲端口。',
    },
    ETIMEDOUT: {
      message: error?.message || 'harness 启动超时。',
      hint: '首次运行或网络较慢时可能需要更久；展开日志看最后几行，常见原因是依赖未装全或代理不可达。',
    },
    EEXITED1: {
      message: 'harness 进程启动后立刻退出。',
      hint: '通常是依赖缺失或 profile 配置损坏。日志里最后几行 stderr 是定位关键。',
    },
    EEXITED: {
      message: error?.message || 'harness 进程提前退出。',
      hint: '查看日志最后几行 stderr；必要时执行 dsh web --no-open 手动复现。',
    },
    ESPAWN: {
      message: '无法启动子进程。',
      hint: '检查 dsh 路径是否存在、是否有执行权限。',
    },
    EACCES: {
      message: '权限不足。',
      hint: '换一个端口（1024 以下端口通常需要管理员权限），或以管理员身份运行。',
    },
    ENOENT: {
      message: '可执行文件不存在。',
      hint: '在设置里重新指定 Node 或 dsh 路径。',
    },
  };
  const fallback = {
    message: error?.message || '未知错误',
    hint: '展开日志查看详细输出，或点「复制诊断信息」把环境信息贴到 issue 里。',
  };
  return { code, ...(table[code] || fallback), detail: error?.stderrTail?.slice(-8).join('\n') || null };
}

class BootController extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./logger').Logger} options.logger
   * @param {import('./server').HarnessServer} options.server
   * @param {() => object} options.getSettings
   * @param {object} options.context 传给运行时探测的上下文（env/platform/execPath/resourcesPath/appRoot/isPackaged/home）
   */
  constructor({ logger, server, getSettings, context }) {
    super();
    this.logger = logger;
    this.server = server;
    this.getSettings = getSettings;
    this.context = context;
    this.steps = STEPS.map((step) => ({ ...step, status: 'pending', detail: null }));
    this.lastError = null;
    this.plan = null;
    this.running = false;
  }

  snapshot() {
    return {
      steps: this.steps.map((step) => ({ ...step })),
      error: this.lastError,
      plan: this.plan
        ? {
            source: this.plan.source,
            port: this.plan.port,
            host: this.plan.host,
            dshVersion: this.plan.dshVersion,
            nodeVersion: this.plan.nodeVersion,
            command: this.buildCommandPreview(this.plan),
          }
        : null,
    };
  }

  /** 给人看的命令行预览（日志面板与诊断信息里用）。 */
  buildCommandPreview(plan) {
    const quote = (value) => (/[\s"]/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value));
    return [plan.file, ...plan.argv].map(quote).join(' ');
  }

  _setStep(id, status, detail) {
    const step = this.steps.find((item) => item.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) step.detail = detail;
    this.emit('progress', this.snapshot());
  }

  _resetSteps() {
    this.steps.forEach((step) => {
      step.status = 'pending';
      step.detail = null;
    });
    this.lastError = null;
    this.emit('progress', this.snapshot());
  }

  async start() {
    if (this.running) return this.snapshot();
    this.running = true;
    this._resetSteps();

    try {
      const settings = this.getSettings();

      // ── 步骤 1：探测运行时 ──────────────────────────────────────────────
      this._setStep('runtime', 'active', '正在查找 Node 与 dsh…');
      const result = await buildLaunchPlan({ ...this.context, settings });

      if (!result.ok) {
        const described = describeError(result.error, {});
        described.diagnostics = this.summarizeDiagnostics(result.diagnostics);
        return this._fail('runtime', described);
      }

      const { plan, diagnostics, warnings } = result;
      for (const warning of warnings || []) this.logger?.warn(warning, 'boot');
      this._setStep(
        'runtime',
        'done',
        plan.source === 'npx'
          ? `通过 npx 拉取 ${plan.dshVersion}`
          : `dsh ${plan.dshVersion || '未知版本'}（${this.sourceLabel(plan.source)}）· Node ${formatVersion(plan.nodeVersion)}`,
      );

      // ── 步骤 2：准备启动参数 ────────────────────────────────────────────
      this._setStep('plan', 'active', '分配端口并组装命令…');
      if (settings.port > 0) {
        const free = await isPortFree(settings.port, settings.host || '127.0.0.1');
        if (!free) {
          const error = Object.assign(new Error(`端口 ${settings.port} 已被占用`), { code: 'EADDRINUSE' });
          return this._fail('plan', describeError(error, { port: settings.port }));
        }
      }
      this.plan = plan;
      this._setStep('plan', 'done', `${plan.host}:${plan.port}${settings.port > 0 ? '（固定）' : '（自动分配）'}`);

      // ── 步骤 3：启动服务 ────────────────────────────────────────────────
      this._setStep('service', 'active', '正在拉起 dsh web…');
      const readyPromise = this.server.start(plan);
      this._setStep('service', 'done', `子进程 pid=${this.server.pid}`);

      // ── 步骤 4：等待就绪 ────────────────────────────────────────────────
      this._setStep('ready', 'active', '等待服务打印带令牌的访问地址…');
      const snapshot = await readyPromise;
      this._setStep('ready', 'done', `已就绪：${snapshot.host}:${snapshot.port}`);
      this.logger?.info(`harness 已就绪：${snapshot.url}`, 'boot');

      // 端口起来了不代表应用层可用，再做一次 HTTP 探测（失败不致命）
      const healthy = await this.server.waitHealthy({ timeoutMs: 30000 });
      if (!healthy) this.logger?.warn('HTTP 健康检查未通过，仍继续加载界面', 'boot');

      this.running = false;
      const payload = { ...this.snapshot(), server: this.server.snapshot(), url: snapshot.url, token: snapshot.token };
      this.emit('done', payload);
      return payload;
    } catch (error) {
      const stepId = this.steps.find((step) => step.status === 'active')?.id || 'service';
      const described = describeError(error, { port: this.plan?.port });
      described.diagnostics = error?.diagnostics || null;
      return this._fail(stepId, described);
    } finally {
      this.running = false;
    }
  }

  sourceLabel(source) {
    return { local: '本机安装', bundled: '应用内置', setting: '手动指定', env: '环境变量指定', npx: 'npx 临时拉取' }[source] || source || '未知来源';
  }

  summarizeDiagnostics(diagnostics) {
    if (!diagnostics) return null;
    return {
      node: diagnostics.node
        ? {
            picked: diagnostics.node.source,
            file: diagnostics.node.file,
            version: diagnostics.node.version,
            ok: diagnostics.node.ok,
          }
        : null,
      dshAttempts: diagnostics.dsh?.attempted || [],
    };
  }

  _fail(stepId, described) {
    this._setStep(stepId, 'error', described.message);
    this.lastError = described;
    this.logger?.error(`启动失败[${described.code}]：${described.message}`, 'boot');
    const payload = { ...this.snapshot(), error: described };
    this.emit('failed', payload);
    return payload;
  }

  /** 停止服务并复位步骤。 */
  async stop() {
    await this.server.stop();
    this._resetSteps();
    this.plan = null;
  }
}

module.exports = { BootController, STEPS, describeError };
