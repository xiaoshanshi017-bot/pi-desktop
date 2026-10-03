# Pi Desktop

**Pi Coding Agent 的非官方 Windows 桌面客户端。**

**Unofficial Windows desktop GUI client for Pi Coding Agent.**

Pi Desktop 用 Electron 和 React 为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供图形界面，通过 Pi RPC 使用上游的模型、工具与会话能力。本项目独立维护，不代表 Pi 官方，也不表示获得上游背书。Pi 的名称用于说明本客户端所兼容的上游项目。

[Pi 官网](https://pi.dev/) · [Pi 上游源码](https://github.com/earendil-works/pi) · [下载安装包](https://github.com/xiaoshanshi017-bot/pi-desktop/releases) · [反馈问题](https://github.com/xiaoshanshi017-bot/pi-desktop/issues)

## 功能

- 图形化对话，显示 Markdown、思考过程、流式回复和工具执行结果。
- 多会话、多项目并行运行；切换会话保留原任务，标签与侧栏展示后台状态和完成提示。
- 任务进度显示当前阶段、耗时与工具调用记录；收起的工具卡片也显示最新五行日志，15 秒无新输出时提示等待时长。
- 自定义模型搜索与分组；按模型能力选择带中英文说明的思考档位。
- 多项目入口、历史搜索、会话恢复、重命名、分支和上下文压缩。
- 导入已有 Pi / Pi Web 项目，沿用模型配置与历史，不移动项目代码。
- 图片与文本附件、扩展弹窗、Skills、提示模板、任务引导和后续消息。
- 深浅主题、中文输入法支持；本地保存草稿和客户端偏好。
- Windows x64 安装包内置 Pi、Node.js、Git Bash、npm、ripgrep 和 fd。

## 安装与使用

从 [GitHub Releases](https://github.com/xiaoshanshi017-bot/pi-desktop/releases/latest) 下载 `Pi-Desktop-Setup-0.2.3-x64.exe` 并安装。日常使用推荐安装版，内置环境只需展开一次。也提供 `Pi-Desktop-0.2.3-x64.exe` 单文件便携版，启动时会展开运行环境。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

安装客户端后无需单独安装 Pi、Node 或 Git Bash。模型仍需自己的 API 密钥或服务商登录；Pi Desktop 不附赠模型服务。已有 Pi 用户默认继续使用 `~/.pi/agent` 下的模型配置、凭据和 JSONL 会话，也尊重 Pi 的代理目录环境变量。

打开项目文件夹，然后输入需求。Enter 发送，Shift+Enter 换行；任务进行中可发送引导指令、排队后续消息，或请求停止。

输入框上方的任务进度区显示思考、输出说明、准备工具、执行、等待和重试的实际阶段，点击“执行记录”可查看各步骤。工具卡片下方显示最新输出，展开可查看完整参数与结果。历史调用没有最终结果时显示“未记录结果”，不会一直转圈。桌面版也会通过当前 Pi 进程的追加系统提示，引导模型在关键步骤之间主动汇报进展；单个工具执行期间的反馈来自真实日志与计时，模型汇报频率取决于模型和服务商。

任务执行时，点击“新建会话”（Ctrl N）或打开另一个项目即可并行推进。顶部标签切换已打开的会话，后台完成会显示新消息提示；每个会话分别保留草稿、附件、日志和阅读位置。停止按钮只停止当前会话。详情面板默认收起，点击顶部“上下文”或详情按钮查看；进度默认显示一行，执行记录按需展开。

已打开的会话从本地缓存即时切换，后台只更新当前选择，不会再次传输完整聊天或读取模型列表。同项目历史入口也复用已打开会话。长聊天每页渲染 40 条消息，可查看更早、较新消息，并跳到最早或最新；全部记录保留，各会话分别恢复历史页、滚动位置和草稿。并行流式输出按浏览器帧合并绘制，减少频繁更新带来的卡顿。

内置 Pi 的模型 Bash 调用未指定 `timeout` 时，默认在 5 分钟后结束命令并返回超时错误；显式设置的时限继续生效，长任务可以指定更长时间。超时会终止该命令的进程树，已有日志仍会保留。这个默认值只作用于桌面启动的内置 Pi，不改写项目或全局配置；手动覆盖的 Pi 使用自身的工具策略。

在“导入 Pi Web 项目”中扫描并选择已有项目。导入保存项目入口，不复制凭据、不移动代码或会话，也不会接管网页版运行中的任务。任务结束后再从桌面客户端恢复同一会话。

设置中的“关于 Pi Desktop”包含上游、客户端源码与许可链接。“运行环境”显示 Pi、Node 和 Bash 的实际来源。已有手动覆盖继续生效，清空覆盖即可恢复自动选择。

## 从源码运行

Windows x64；开发环境需要 Node.js 22.19.0 或以上版本。

```powershell
git clone https://github.com/xiaoshanshi017-bot/pi-desktop.git
cd pi-desktop
npm ci
npm run prepare:runtime
npm run dev
```

`prepare:runtime` 下载固定版本的官方运行组件、校验 SHA-256，并按独立锁文件安装 Pi 的生产依赖。需要网络连接；准备成功后可复用本地构建缓存。没有准备内置环境的开发启动也可以使用系统 Pi / Node。

## 打包

```powershell
npm run pack
npm run dist
```

- `pack`：生成 `release/win-unpacked/` 完整应用目录。
- `dist`：生成 Windows x64 安装包和单文件便携版。

这两个命令都会先准备内置环境并构建界面。完整目录中的 `Pi Desktop.exe` 可直接运行，但必须保留整个目录。安装版默认采用用户级安装，支持选择目录和桌面 / 开始菜单快捷方式。

运行组件在应用自己的 `resources/runtime` 中，不修改系统 PATH。组件的固定版本、官方下载链接和完整性值见 [runtime/sources.json](runtime/sources.json)。构建会拒绝本地目录依赖、Junction 与符号链接，避免打包目录循环。

## 数据与兼容性

- Pi Web、终端和客户端默认共用 Pi 的 `models.json`、`auth.json`、`settings.json` 与历史。客户端偏好保存在 Electron 用户数据目录，凭据不会传给界面。
- 修改模型配置后可在设置中重新读取；已连接的 Pi 进程在任务结束后重新连接，才会完整应用变化。
- 每个打开的会话各自管理一个 Pi 进程，切换时后台任务继续执行。同一历史 JSONL 在客户端内复用已有进程；不要同时用其他入口写同一份会话。分支保留对话，不回滚项目文件。
- 普通 RPC 扩展选择、确认、输入、编辑器和通知可用。依赖 TUI 绘制的扩展需要额外适配；Pi 0.84.2 的无超时启动交互可能阻塞 RPC 初始化。
- 服务商登录与密钥配置目前使用 Pi 原有配置流程。模型能力、费用估算、认证与工具行为由 Pi 和服务商提供。
- 工具使用当前系统用户权限操作所选项目；客户端不提供执行沙箱。
- 当前 Windows 构建没有代码签名。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

自动测试覆盖 RPC 分帧与生命周期、模型信息脱敏、项目迁移、会话缓存 / 恢复、内置环境选择、中文路径启动器，以及构建目录循环的回归检查。真实 Pi 集成测试通过本机模拟模型验证流式回复、中文文件读取、会话保存和恢复，不请求外部模型。

没有系统 Pi 时，可先准备运行组件，再指定内置 CLI，避免跳过真实 Pi 集成测试：

```powershell
$env:PI_TEST_CLI = (Resolve-Path 'build/runtime/win32-x64/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js').Path
npm test
```

桌面验收使用独立配置和离线测试数据：

```powershell
# 完整运行环境、中文路径工具执行和会话恢复
npm run pack
node scripts/run-bundled-runtime-smoke.mjs

# 模型选择器、思考档位、键盘操作和主题
node scripts/run-selector-smoke.mjs

# 实时阶段、命令日志、静默等待、失败与停止（自行启动本地模拟模型）
npm run build
node scripts/run-progress-smoke.mjs

# 多会话与多项目并行、消息/草稿隔离、后台完成、定向停止与窄屏布局
node scripts/run-parallel-smoke.mjs

# 千条历史切换性能、有界消息渲染、草稿与阅读位置（隔离的离线会话）
node scripts/run-switch-smoke.mjs
```

输出报告与截图保存在 `output/`，不提交到仓库。可选的现有模型 / 项目验收说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `src/` | React 界面、会话和消息显示 |
| `electron/` | 窗口、受控 IPC、Pi RPC、本地数据 |
| `shared/` | 桌面桥接类型 |
| `runtime/` | 固定版本、校验值与 Pi 生产依赖锁文件 |
| `scripts/` | 开发、构建、运行环境准备和桌面验收 |
| `tests/` | 自动测试与本机模拟模型 |

## 开源与致谢

客户端代码和文档采用 [MIT 许可证](LICENSE)。Pi、Node、Git/Bash 和其他第三方组件保留各自许可证；本项目的 MIT 许可不替换这些许可。参见 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)。

感谢 Pi 原作者 Mario Zechner 和上游贡献者。Pi 的模型、工具和会话引擎来自上游，本仓库实现桌面客户端及其集成。

欢迎提交 Issue 与 Pull Request；参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿上传密钥、认证文件、私人会话或本机项目数据。
