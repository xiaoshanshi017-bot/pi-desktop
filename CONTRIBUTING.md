# 参与开发

Pi Desktop 是独立维护的 Pi Coding Agent 非官方客户端。客户端问题请在[本仓库](https://github.com/xiaoshanshi017-bot/pi-desktop/issues)反馈；确认属于 Pi 引擎的问题再参考[上游项目](https://github.com/earendil-works/pi)。

## 本地开发

Windows x64，Node.js 22.19.0 或更高版本：

```powershell
npm ci
npm run prepare:runtime
npm run dev
```

运行组件固定在 `runtime/sources.json`，Pi 生产依赖使用独立锁文件。调整它们时需要同时验证下载校验值、运行组件选择和打包结果。

## 验证变更

```powershell
npm run typecheck
npm test
npm run build
```

真实 Pi 集成测试会寻找可用 Pi；在没有系统 Pi 的环境可指定内置 CLI：

```powershell
$env:PI_TEST_CLI = (Resolve-Path 'build/runtime/win32-x64/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js').Path
npm test
```

协议与模型测试使用本机模拟服务，不需要真实模型密钥。桌面验收入口见 README；它们生成独立的 `output/` 测试配置。`model-config-smoke.cjs` 和 `project-migration-smoke.cjs` 是可选的已有配置验收，需要当前账户已经保存模型或项目，会只读这些配置并将结果保存在隔离目录。

## 提交与反馈

说明变更解决的问题、用户可见行为和实际验证结果。界面变更可以附经过检查的截图。

请不要提交 API 密钥、认证文件、个人项目、会话 JSONL、用户配置、构建缓存或含私人路径的验收输出。故障截图和日志也应去掉凭据与私人对话；复现优先使用离线验收配置。
