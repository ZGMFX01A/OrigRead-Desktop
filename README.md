# OrigRead Desktop

OrigRead（原读）的独立桌面客户端。

当前桌面端从 Android 项目重新迁移，技术栈为 Electron + TypeScript + React。Desktop 与 Android 是两个独立 Git 仓库；Android 是业务行为基线，桌面端只迁移业务语义，不要求共享运行时代码，也不允许为了桌面端方便而反向破坏 Android。

## 开发环境

- Node.js 24+
- npm 11+
- Windows 10/11 x64（最低桌面目标）
- macOS 13+ Apple Silicon（发布目标）

## 常用命令

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm run package:win
npm run package:mac
```

## 架构

```text
src/main       Electron 主进程：窗口、文件、数据库、网络、Chromium 调度
src/preload    最小权限 IPC 桥
src/renderer   React UI
src/shared     仅 Desktop 内部的类型/IPC 契约
```

Renderer 默认 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`。远程网页不会直接获得 Node/Electron API。

本地数据层使用 Electron 内置 Node 的 `node:sqlite`，避免额外 native SQLite addon 带来的 Electron ABI 和跨平台重编译成本。

详细迁移计划见 `docs/DEVELOPMENT_PLAN.md`。

