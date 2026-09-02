# 原读 Desktop AI / Web Search / Skill / MCP 使用指南

语言：简体中文。英文版请查看 `AI_MCP_SKILLS.md`。

这份文档只说明 Desktop 当前已经实现的 AI 扩展能力。普通 RSS、网站解析、同步、正文提取和本地阅读不依赖这些功能。

## 1. AI 服务与 Reader AI

在 **设置 → AI 阅读 → AI 服务** 中可以添加多个 OpenAI Compatible Provider。每个 Provider 独立保存：

- 名称；
- Endpoint；
- API Key；
- 模型列表与默认模型；
- 启用状态。

Reader AI 第一次发送消息时创建 Conversation。Conversation 绑定主文章和当时选择的 Provider/Model；后续可以在输入框的模型选择器中切换当前 Conversation 使用的服务/模型。

Reader AI 支持普通 Chat、Article Analysis、Reasoning 流、Stop、Regenerate、Conversation History、Chat Search、正文 Citation、Selection 一次性上下文以及最多 5 篇额外文章。

## 2. Dedicated Web Search

打开 **设置 → AI 阅读 → Web Search**。

当前内置 Search Provider 类型：

- Exa
- Tavily
- Brave Search
- Perplexity Search
- Linkup
- Firecrawl
- Keenable
- SearXNG

其中 SearXNG 由你填写自己的实例地址；Keenable 和 SearXNG 可以在不强制 API Key 的情况下使用，其余默认定义需要对应服务凭据。

### 模式

- **AUTO**：由请求策略判断本轮是否需要 Dedicated Search。
- **OFF**：普通请求不自动搜索。
- **FORCE**：不是持久设置。Chat 输入框中手动点亮搜索按钮后，只强制下一条消息搜索一次，然后自动恢复原来的 AUTO/OFF。

默认最大结果数为 5；设置支持调整结果数量。Search 的 Query、Provider、结果数量、结果列表和实际纳入 Context 的状态会保存在对话审计信息中。

## 3. Custom Instructions、Skills 与 Quick Messages

这些功能位于 **设置 → AI 阅读 → 行为**。

### Custom Instructions

用于给支持的 AI 任务增加你自己的长期偏好。它和具体文章 Context 分开保存。

### Skills

OrigRead 的 Skill 可绑定到四类任务：

- Summary
- Translation
- Chat
- Article Analysis

可以创建简单 Skill，也可以导入兼容的 Skill 文件。管理界面只展示 metadata；完整 instructions/resource 由 Main Process 管理。

第一版安全规则：

- `SKILL.md` 主体 instructions 会进入对应任务；
- 只有被 instructions 明确引用的安全文本资源才会按需加入；
- 导入包中的脚本**不会执行**；
- `allowed-tools` / `allowedTools` 只作为实验性声明展示，**不会授权任何 Tool**。

### Quick Messages

Quick Message 是可以从 Reader AI 输入框 `+` 菜单直接发送的模板。支持的模板变量包括：

- `{{article_title}}`
- `{{article_url}}`
- `{{selection}}`
- `{{summary}}`

如果某个变量在当前上下文不可用，OrigRead 会在本地阻止发送，而不是把未展开的模板交给模型。

## 4. Remote MCP

Remote MCP 使用 Streamable HTTP。当前认证方式：

- None
- Bearer Token
- Custom Headers
- OAuth

服务器默认不会因为应用启动就自动连接。保存配置后可以显式测试连接或刷新 Tool Catalog。

### Tool 审批

**所有 MCP Tool 都需要显式用户批准。**

MCP Server 返回的 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` 等 metadata 只用于风险说明，不能授予权限，也不能绕过 OrigRead 的中央审批。

自动 Tool loop 遇到需要执行的 MCP Tool 时会显示审批 Card；拒绝后 Tool 不执行，模型可以收到拒绝结果继续生成。手动 Tool 从输入框 `+` 菜单发起时，点击明确的运行操作就是这一轮的一次性批准。

## 5. Local stdio MCP

Local MCP 配置包含：

- Command
- Args
- Working directory
- `KEY=VALUE` 形式的 Environment

Environment 的值进入 Main Process SecretStore；Renderer 平时只看到“是否配置”和长度，不保存真实值。

生命周期规则：

- 应用启动时不会自动 spawn Local MCP；
- 只有连接测试、刷新 Tool 或真实执行时才按需启动；
- App 正常退出时会等待活跃 stdio 子进程关闭；
- guardian 会用父 PID 保护异常退出场景，避免长期遗留孤儿进程。

## 6. Secret 与配置备份

以下内容属于敏感数据：

- AI API Key
- Web Search API Key
- Remote MCP Bearer / Custom Header credential
- MCP OAuth token
- Local stdio environment value

它们由 Electron Main Process 的安全存储管理，不写入普通 `app_settings` 明文字段。设置页默认只显示是否存在和长度；只有显式 reveal 时才暂时把明文送入 Renderer。

配置备份默认**不包含**这些凭据。只有你主动选择“包含凭据”并设置备份密码时，凭据才进入加密备份块。

恢复配置时，OrigRead 会把 SQLite 配置、文件型规则仓储和 SecretStore 作为一个逻辑事务处理；后段恢复失败时会回滚已经写入的配置，避免留下半恢复状态。

## 7. Stop、崩溃恢复与 Tool 副作用

- Provider、Search 和协作式 Tool 会响应 Stop。
- 如果第三方 Tool 忽略 AbortSignal，OrigRead 仍会先停止当前可见生成，并丢弃迟到 Tool Result；同一 Conversation 的下一请求会等待旧 Tool 真正结束，避免副作用重叠。
- 应用异常退出后，启动恢复会把未完成 Assistant/Search/Tool 收口为可解释终态；不会自动重放 RUNNING/PENDING_APPROVAL Tool，避免重复副作用。
- 已经持久化的部分 Reasoning/Answer 会保留。

## 8. 出问题时先检查什么

1. AI：先在 AI 服务页测试 Provider，并确认 Key 已保存、模型已选中。
2. Search：测试 Search Provider；SearXNG 需要正确的实例 Endpoint。
3. Remote MCP：先测试连接，再刷新 Tool Catalog；OAuth 只会打开 HTTP/HTTPS 授权地址。
4. Local MCP：确认命令在本机可执行、cwd 正确、env 使用一行一个 `KEY=VALUE`。
5. Tool 一直等待：检查 Reader AI 中是否有待处理的审批 Card。

发布前的自动化覆盖和人工检查项见 [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)。
