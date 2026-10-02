# 上游与第三方组件

**Pi Desktop 是 Pi Coding Agent 的非官方 Windows 图形客户端。** 本项目独立维护，不代表 Pi 上游，也不表示获得上游背书。Pi 的名称用于说明兼容的上游项目。

客户端通过 Pi RPC 调用上游提供的模型、会话和工具能力。感谢 Pi 的原作者 Mario Zechner 及上游贡献者。

- Pi 项目：[earendil-works/pi](https://github.com/earendil-works/pi)
- Pi 网站与文档：[pi.dev](https://pi.dev/)
- 本版本使用的 Pi 源码：[v0.84.2](https://github.com/earendil-works/pi/tree/v0.84.2)
- Pi 上游许可证：[MIT](https://github.com/earendil-works/pi/blob/v0.84.2/LICENSE)

## 许可证范围

根目录的 [MIT 许可证](LICENSE) 适用于本仓库自行编写的客户端代码与文档。它不替换 Pi、运行组件及其他依赖各自的许可证。

Windows 安装包将以下组件作为独立运行文件分发；原始许可证与声明随组件保留。Pi Desktop 没有修改这些组件的源文件，中文路径兼容适配由独立的客户端启动器完成。

| 组件 | 用途 | 上游与许可信息 |
| --- | --- | --- |
| Pi Coding Agent | 模型、工具与会话引擎 | [Pi](https://github.com/earendil-works/pi)，MIT |
| Node.js / npm | 运行 Pi 与项目命令 | [Node.js](https://nodejs.org/)、[Node.js 许可证](https://github.com/nodejs/node/blob/main/LICENSE)；npm 及随附依赖保留各自许可 |
| Git for Windows / Bash | Git 与命令执行 | [Git for Windows](https://github.com/git-for-windows/git)，Git 为 GPL-2.0；随附 Bash 和其他工具分别遵循各自许可 |
| ripgrep | 文本搜索 | [ripgrep](https://github.com/BurntSushi/ripgrep)，MIT / Unlicense |
| fd | 文件搜索 | [fd](https://github.com/sharkdp/fd)，MIT / Apache-2.0 |
| Electron、React、Lucide 等 | 桌面窗口与界面 | 依赖包中的原始许可证与声明 |

固定版本、官方下载链接、完整性校验值见 [runtime/sources.json](runtime/sources.json)。Git for Windows 的对应发行版和源码入口也列于该文件。分发运行组件时，请一并保留 `resources/runtime/THIRD-PARTY-NOTICES.txt`、组件内的许可证和源码信息；客户端自己的 MIT 许可不能代替这些文件。
