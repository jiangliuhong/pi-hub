# Pi Web

[English](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi 编程智能体](https://github.com/earendil-works/pi)的本地浏览器界面。Pi Web 与 pi 共用本机配置和会话文件，可在浏览器中查找和继续对话、运行智能体、配置模型与资源，并查看项目文件。

中文微信群：请查看 [GitHub Discussions 帖子](https://github.com/jiangliuhong/pi-hub/discussions/271)。

![Pi Web 展示包含结构化 Markdown、工具调用和项目导航的 pi 会话](https://raw.githubusercontent.com/jiangliuhong/pi-hub/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目查找、继续、重命名、导出和删除对话，并查看运行状态、上下文占用、花费和压缩信息。
- **两种分支方式**：**新会话**会从较早的消息创建独立会话文件；**从此处编辑**会在当前会话内创建分支。
- **项目文件工具**：浏览和上传文件、查看 Git Diff，并预览源码、Markdown、图片、音频、PDF 和 DOCX；文件变化后会自动刷新。
- **Git worktree**：从侧边栏切换 checkout，同时把同一仓库不同 worktree 的会话归在一起。
- **网页配置**：无需离开 Pi Web，即可管理 Provider 登录和 API Key、模型、模型测试、插件包及技能。
- **英文、简体中文和繁体中文界面**：Pi Web 首次打开时跟随浏览器语言，也可从顶部栏切换语言。

## 快速开始

Pi Web 要求 Node.js 22.19.0 或更高版本。先用 `node --version` 检查版本，然后运行：

```bash
npx @jarome/pi-hub@latest
```

服务就绪后，命令行会尝试自动打开浏览器。如果没有打开，请访问 [http://127.0.0.1:30142](http://127.0.0.1:30142)。Pi Web 默认仅监听 `127.0.0.1`。

如果尚未配置模型 Provider，请打开**模型（Models）**面板登录或添加 API Key。

如需全局安装 `pi-hub` 命令：

```bash
npm install -g @jarome/pi-hub@latest
pi-hub
```

更新前先用 `Ctrl+C` 停止正在运行的进程，再次执行同一条安装命令。卸载时运行 `npm uninstall -g @jarome/pi-hub`。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_HUB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-hub --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30142` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_HUB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_HUB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_HUB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_HUB_PASSWORD` | 启用 HTTP Basic Auth，用户名固定为 `pi` | 不启用认证 |

例如：

```bash
pi-hub --help
pi-hub -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

监听非回环地址会暴露一个可执行高权限操作的智能体。在可信局域网中使用时，请设置足够长的随机密码：

```bash
PI_HUB_PASSWORD='足够长的随机密码' pi-hub --hostname 0.0.0.0
```

Basic Auth 不会加密传输中的密码。不要通过明文 HTTP 将 Pi Web 暴露到互联网；远程访问应使用可信反向代理提供 HTTPS，或通过可信 VPN。如果反向代理传递外部主机名，请把该名称精确加入 `PI_HUB_ALLOWED_HOSTS`。这个白名单不会改变 Pi Web 的监听地址。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @jarome/pi-hub@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @jarome/pi-hub@latest
```

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30142](http://127.0.0.1:30142)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，可能干扰开发服务器；仅在发布流程中执行构建。

贡献者文档：[国际化](./docs/i18n.md)和[发布流程](./docs/release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
docs/            面向用户和贡献者的专题文档
```

架构说明和详细文件地图见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)

## Pi Hub 扩展功能

Pi Hub 在原有 Pi Web 会话管理和浏览器工作区的基础上，增加了 Telegram 集成和定时任务调度能力。相关实现可以在源码中的 `modules/scheduler/`、`modules/telegram/`、`app/api/scheduler/` 和 `app/api/integrations/telegram/` 目录查看。

### 定时任务调度

从侧边栏进入“任务”，可以为任务选择工作目录并填写要执行的 Agent 指令，然后配置调度方式：

- **每日**：在指定时间、指定时区重复执行；
- **一次性**：在指定的时间点执行一次；
- **继续已有会话**：选择恢复模式后，任务会基于已有 session 继续执行，而不是创建全新的会话，适合定时跟进某个长期任务。

任务页面会显示下一次执行时间的预览，并同时展示所选时区和对应的 UTC 时间，方便确认调度是否正确。

![Pi Hub 定时任务配置](./docs/screenshots/task-scheduler.png)

### Telegram 集成

在 Pi Hub 中可以配置 Telegram Bot Token，并选择 Telegram 官方 Bot API 服务或自建 Bot API Server。配置完成后，可以通过用户配对和会话映射，将 Telegram 用户与 Pi Hub 中的会话关联起来，从 Telegram 继续操作对应的 Agent session。

定时任务执行时，Pi Hub 可以通过 Telegram 发送任务开始、执行成功、执行失败或延迟重试等通知；通知中会带上任务信息和 session 标识，便于继续查看或操作。

![Pi Hub Telegram 集成配置](./docs/screenshots/telegram-integration.png)

在主界面的 TG 入口可以查看 Telegram 集成状态；任务结束后也可以从界面中的通知入口确认执行结果。

![Pi Hub 任务执行结果通知](./docs/screenshots/pi-hub-task-notification.png)


### 机器可读的版本与健康检查

Pi Hub 提供两个稳定、仅输出 JSON 的命令，供自动化、桌面宿主和 CI 使用。两者都**不会**启动 HTTP 服务器、监听端口、打开浏览器、调用模型 API、刷新 OAuth，也不会发起任何网络请求。

```bash
pi-hub --version --json
```

```json
{"schemaVersion":1,"name":"@jarome/pi-hub","version":"0.0.8"}
```

```bash
pi-hub doctor --json --offline
```

```json
{"schemaVersion":1,"status":"healthy","checks":[{"name":"nodeVersion","status":"pass","detail":"24.10.0"},...]}
```

`doctor` 在 `healthy` 时将 JSON 写入 **stdout**，否则写入 **stderr**；退出码始终是判断结果的唯一依据：

| 退出码 | 含义                                                                    |
| ------ | ----------------------------------------------------------------------- |
| `0`    | `--version` 成功，或 `doctor` 健康。                                    |
| `2`    | 参数错误（未知参数、缺少 `--json`/`--offline`）。                       |
| `3`    | `doctor`：blocked — Node 版本过低，或 Pi Hub 主目录不可写。             |
| `4`    | `doctor`：degraded — 可运行，但有检查项告警（例如缺少构建产物）。       |

凭据和环境变量的值永远不会被输出；`doctor` 只报告解析后的目录路径和环境变量是否设置的布尔值。完整稳定契约见 [docs/pi-hub/pi-hub-cli-contract-v1.md](./docs/pi-hub/pi-hub-cli-contract-v1.md)。
