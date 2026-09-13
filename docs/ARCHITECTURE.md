# 架构与数据流

## 分层原则

```
┌──────────────────────────────────────────────────────────────┐
│ 渲染层（沙箱内）                                              │
│   引导页 / 设置页  ← 只通过 preload 暴露的窄接口与主进程通信    │
└───────────────────────────┬──────────────────────────────────┘
                            │ contextBridge（命名空间 __DSH_DESKTOP__）
┌───────────────────────────┴──────────────────────────────────┐
│ 主进程（Node）                                                │
│   index.js      编排：窗口 / 托盘 / 菜单 / IPC / 崩溃重启       │
│   boot.js       启动编排：四步进度 + 错误映射                   │
│   runtime.js    「从哪拿运行时」（纯函数，可注入 env/platform）  │
│   server.js     「把服务跑起来并盯住它」                        │
└───────────────────────────┬──────────────────────────────────┘
                            │ spawn（stdio: pipe）
┌───────────────────────────┴──────────────────────────────────┐
│ dsh 子进程（只监听 127.0.0.1）                                 │
│   dsh web --no-open --host 127.0.0.1 --port <p> --trusted-host│
└──────────────────────────────────────────────────────────────┘
```

职责边界刻意做得很窄，每个模块只回答一个问题：

| 模块 | 唯一职责 | 不做什么 |
| --- | --- | --- |
| `runtime.js` | 找到可用的 Node 与 dsh，给出启动计划 | 不启动进程、不碰窗口 |
| `server.js` | 管好 dsh 子进程：spawn / 就绪解析 / 健康检查 / 进程树清理 | 不知道界面存在 |
| `boot.js` | 把上面两者串成有进度的流程，把错误翻译成人话 | 不碰窗口与托盘 |
| `index.js` | 窗口、托盘、菜单、IPC、崩溃重启、退出 | 不实现探测与解析细节 |

## 启动时序

```
main()
 ├─ 解析命令行（--dev / --self-test / --self-test-ui / --headless）
 ├─ 初始化 Logger / Settings / NavigationPolicy
 ├─ 创建 HarnessServer 与 BootController（此时还没启动任何东西）
 ├─ 注册 IPC、菜单、托盘
 ├─ 建窗口并加载引导页（file://）
 └─ startHarness()
      └─ BootController.start()
           ├─ 步骤1 探测运行时  → runtime.buildLaunchPlan()
           │    ├─ resolveNodeRuntime：显式配置 → PATH 上的 node → Electron 自带 Node
           │    └─ resolveDshRuntime ：手动指定 → PATH 反推 → 各平台全局目录 → 内置副本 → npx
           ├─ 步骤2 准备参数    → 固定端口做占用检查；自动端口用 ports.findFreePort()
           │                     组装 web --no-open --host --port --trusted-host
           ├─ 步骤3 启动服务    → HarnessServer.start(plan) → spawn
           └─ 步骤4 等待就绪    → 解析 stdout 的令牌地址 → waitHealthy() → 返回
      └─ loadHarnessWithFallback(tokenUrl)
           ├─ 加载带令牌地址（跟随 303、落 Cookie）
           ├─ 等 did-finish-load
           └─ 归一化成 ${origin}/（失败则回退到令牌地址）
```

## 事件与状态

三层状态通过事件向上汇总，渲染层只消费一个 `shell:event` 通道：

| 来源 | 事件 | 渲染层表现 |
| --- | --- | --- |
| `BootController` | `progress` / `failed` | 四步进度条、错误卡 |
| `HarnessServer` | `state` / `exit` / `ready` | 右上角状态徽标、元信息卡、自动重启提示 |
| `Logger` | `entry` | 实时日志面板 |

渲染层的每次状态变更都走一个纯函数 `renderAll()`，由 `bootSnapshot` + `currentState` 两份数据推导，不做增量修补——避免状态漂移。

## 崩溃恢复

```
HarnessServer 非预期退出（phase === 'running'）
  └─ index.scheduleAutoRestart()
       ├─ 统计 10 分钟内的崩溃次数
       ├─ ≥ 3 次 → 停止自动重启，弹通知，跳回引导页
       └─ 否则按 2s / 5s / 15s 退避后 startHarness()
```

启动阶段（`phase === 'starting'`）的失败**不**触发自动重启：那时 `boot.js` 已经把可操作的原因推给界面了，再自动重启只会和用户的排查过程打架。

## 安全策略

| 面 | 措施 |
| --- | --- |
| 渲染进程 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| 顶层导航 | 白名单：`file://` 引导页 + `127.0.0.1` 上的 harness 地址；其余交给系统浏览器 |
| 新窗口 | 一律 `deny`，`http(s)` 转交 `shell.openExternal` |
| 权限请求 | 仅放行剪贴板与通知，其余拒绝并记录 |
| 子进程 | 只监听回环地址；代理仅注入子进程，桌面壳自身不走代理 |
| 命令注入 | npx 回退路径必须经过 shell 时，先做元字符校验（`util.isShellSafeArgs`） |

## 自检机制

`src/main/self-test.js` 是一个采集器，主进程在关键时刻调用它：

| 模式 | 做什么 | 退出码 |
| --- | --- | --- |
| `--self-test-ui` | 用假数据渲染引导页 4 种状态 × 深浅两色并截图 | 0 |
| `--self-test` | 真实拉起 dsh → 加载官方界面 → 截图 → 断言 8 项 | 0 / 1 |

采集内容：窗口截图、导航响应码、`console` 分级消息、未捕获异常、`webRequest` 失败记录、页面标题与 DOM 规模。产物落在 `.self-test/<模式>/`，含 `self-test-report.json`。

CI 用它给打包产物做真实冒烟：跑 `release/win-unpacked/*.exe --self-test`，退出码即结论。

## 为什么没有构建步骤

引导页与设置页是原生 HTML/CSS/JS，主进程是 CommonJS。这样带来三个好处：

1. 克隆下来 `npm ci && npm start` 就能改，不需要等 tsc / bundler
2. 引导页不依赖任何 CDN，断网、内网、离线机器都能用
3. `dependencies` 为空——运行时零第三方依赖，供应链面最小

代价是没有类型检查。因此把易错的纯逻辑（运行时探测、路径规则、就绪解析、设置收敛、窗口可见性）全部抽成可注入依赖的纯函数，用 `node:test` 覆盖（34 项）。
