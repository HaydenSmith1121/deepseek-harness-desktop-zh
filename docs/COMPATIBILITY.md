# 上游适配契约（实测记录）

本文件记录 **DeepSeek Harness（dsh）被桌面壳依赖的全部行为**。这些结论不是从文档抄来的，而是在真实环境里跑出来的（2026-09-13，Windows，dsh `0.1.5-rc.1`，Node `v22.22.2`）。

改代码前先看这份文档；上游升级后先复跑一遍这里的探针。

---

## 1. 启动与就绪

### 命令形态

```bash
dsh web [--host <host>] [--port <port>] [--no-open] [--trusted-host <authority>...]
```

- `web` 是 `--profile web` 的别名，实际等价于启动内置的 web profile
- `--port 0` 表示由操作系统随机分配
- `--no-open` 抑制自动打开浏览器——桌面端必须加，否则会弹出一个多余的浏览器标签

### 就绪信号（关键）

进程就绪时向 **stdout** 打印一行：

```
dsh web: http://127.0.0.1:52021/?token=VyniA5RvfDmzPKbLyvfs9M8Y8rL8WcjixK8_sW_l6u8
```

解析规则（见 `src/main/server.js` 的 `parseReadyLine`）：

- 严格匹配：`/dsh web:\s*(https?:\/\/\S+)/i`
- 兜底匹配：`/(https?:\/\/[^\s]+)/` 且 host 属于 `127.0.0.1` / `localhost` / `[::1]`
- 行尾标点与 ANSI 颜色码需要先剥掉
- **实测首次就绪耗时约 10 秒**，因此超时不应低于 60 秒（本项目默认 240 秒，覆盖 npx 冷启动）

### 认证流程（最容易踩的坑）

| 请求 | 实测结果 |
| --- | --- |
| `GET /`（无令牌） | **`401`** |
| `GET /?token=<一次性令牌>` | **`303`**，并下发会话 Cookie |
| 带 Cookie 再请求 `/` | `200`，正常渲染 |

因此桌面端**不能**直接加载端口地址，必须：

1. 解析出带令牌的完整 URL
2. 用该 URL 导航（Chromium 会自动跟随 303 并保存 Cookie）
3. 认证完成后把地址**归一化**成 `${origin}/`，使 `Ctrl+R` 重载不会再撞一次性令牌

必须使用同一个持久化会话分区（`persist:dsh-desktop`），否则每次重载都要重新认证。

> 注意：不要在首个导航事件触发时立刻发起第二次导航。303 跳转尚在进行中，贸然替换会打断它并产生 `ERR_ABORTED (-3)`。本项目改为等待 `did-finish-load` 后再归一化。

### 浏览器信任栅栏

- dsh 对 `/api` 请求校验来源，依赖「组合配置里的 host:port」
- 随机端口下无法提前声明 `--trusted-host`，所以本项目**先自己探测一个空闲端口**，再把它显式传给 dsh，并同时声明 `--trusted-host <host>:<port>`
- 裸访问 `/api/health` 返回 `401` 属正常（未认证），不是服务异常

## 2. 运行时要求

- **Node ≥ 22.19**。原因是 dsh 用内置 zstd 解压会话日志，更早的 Node 没有该能力
- `@deepseek-ai/dsh` 的 `bin` 字段是 `{ "dsh": "lib/bin.js" }`，入口稳定
- 包有 70+ 个运行时依赖，**只拷贝主包无法运行**；内置副本必须做成自包含安装目录（见 `scripts/fetch-dsh.mjs`）

### 已知的全局安装位置

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` |
| Windows (nvm) | `%NVM_SYMLINK%\node_modules\@deepseek-ai\dsh` |
| macOS / Linux | `/usr/local/lib/node_modules/...`、`~/.npm-global/lib/node_modules/...` |

桌面端还会从 PATH 上的 `dsh` 启动器反推包目录，无需用户手填。

## 3. 数据目录

| 项 | 位置 |
| --- | --- |
| `DSH_HOME` | 默认 `~/.dsh`（Windows 为 `%USERPROFILE%\.dsh`） |
| 凭据 | `~/.dsh/.credentials.yaml`（只写不读，桌面端不解析其内容） |
| 会话 | `~/.dsh/sessions`（只追加的会话日志） |
| 配置 | `~/.dsh/settings.yaml`、`~/.dsh/profiles/` |

桌面端只**读取路径**用于展示，不修改这些文件。卸载时也不会删除它们。

## 4. 退出行为

- Windows 上控制台进程不响应 `WM_CLOSE`，`taskkill` 不带 `/F` 会一直等到超时
- 本项目在 Windows 上直接用 `taskkill /PID <pid> /T /F`，退出是秒级的
- POSIX 上先 `SIGTERM` 到进程组，超时再 `SIGKILL`
- 会话日志是只追加的，强杀不会破坏历史

## 5. 官方 Web UI 的加载特征（自检断言依据）

真实加载成功后可以观察到的稳定特征：

| 特征 | 实测值 |
| --- | --- |
| `<title>` | `DeepSeek Harness` |
| 主框架地址 | `http://127.0.0.1:<port>/`（归一化后） |
| DOM 节点数 | 约 400+ |
| 页面内可见文本 | 含「新会话」「工作区」「探索未至之境」「设置」 |
| 前端资源 | `/assets/index-*.js`、`/assets/vendor-*.js`，插件走 `/plugins/??<pkg>/client.js` |
| 插件数量 | 50+ 个 `@deepseek-ai/dsh-client-ui-*` 客户端插件 |

自检断言见 `src/main/index.js` 的 `runFullSelfTest`。

## 6. 已知的环境干扰

- **无 GPU 的 CI / 容器**：Chromium 的 GPU 进程会 `FATAL: GPU process isn't usable`。自检模式与 CI 会自动附加 `--no-sandbox --disable-gpu`；正常桌面启动不降级
- **`ELECTRON_RUN_AS_NODE` 被宿主设置时**：Electron 会以 Node 模式启动，`require('electron')` 只剩路径字符串。构建脚本与自检命令需要先清掉这个变量
- **沙箱策略可能拦截 `reg.exe`**：dsh 在某些路径下会调用它读取系统信息，被拦截时会有提示但不影响主流程

## 7. 探针复跑清单

上游升级后，按顺序确认以下几项即可判断兼容性：

```bash
dsh --version
dsh web --help
dsh web --port 0 --no-open        # 记下输出的 URL 格式是否仍是 dsh web: <url>?token=...
curl -i --noproxy '*' http://127.0.0.1:<port>/                 # 期望 401
curl -i --noproxy '*' "http://127.0.0.1:<port>/?token=<tok>"   # 期望 303
curl -i --noproxy '*' -b jar -c jar "http://127.0.0.1:<port>/?token=<tok>"  # 期望跟随到 200
```

（`--noproxy` 不能省：本机有代理时 curl 会把回环请求也送进代理，得到假的 `502`。）
