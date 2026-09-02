# OrigRead Desktop AI / Web Search / Skills / MCP Guide

Language: English. See `AI_MCP_SKILLS-zh-CN.md` for Simplified Chinese.

This document covers the optional AI extension surface implemented by the Desktop app. Normal RSS/website parsing, synchronization, full-text extraction and local reading do not depend on these features.

## 1. AI Providers and Reader AI

Open **Settings → AI Reading → AI Providers** to configure multiple OpenAI-compatible providers. Each provider keeps its own:

- name;
- endpoint;
- API key;
- model list and default model;
- enabled state.

Reader AI creates a Conversation on the first send. The Conversation is bound to a primary article and the selected Provider/Model. The composer model picker can change the Provider/Model used by that Conversation for later requests.

Reader AI supports normal Chat, Article Analysis, streamed Reasoning, Stop, Regenerate, Conversation History, Chat Search, article Citations, one-shot Selection context and up to five additional articles.

## 2. Dedicated Web Search

Open **Settings → AI Reading → Web Search**.

Built-in Search Provider kinds:

- Exa
- Tavily
- Brave Search
- Perplexity Search
- Linkup
- Firecrawl
- Keenable
- SearXNG

SearXNG uses an endpoint that you provide. Keenable and SearXNG do not require an API key in their default definitions; the other built-in definitions require credentials for their corresponding service.

### Modes

- **AUTO** — request policy decides whether Dedicated Search is needed.
- **OFF** — ordinary requests do not automatically search.
- **FORCE** — request-scoped only. Arm Search in the Chat composer to force the next message to search once; OrigRead then returns to the persistent AUTO/OFF setting.

The default result limit is five and can be changed in settings. Search query, provider, result count, result list and inclusion status are persisted as part of the conversation audit trail.

## 3. Custom Instructions, Skills and Quick Messages

These features live under **Settings → AI Reading → Behavior**.

### Custom Instructions

Custom Instructions add your long-lived preferences to supported AI tasks and are stored separately from article Context.

### Skills

Skills can be bound to four task types:

- Summary
- Translation
- Chat
- Article Analysis

You can create a simple Skill or import a compatible Skill file. The management UI receives metadata; full instructions/resources remain Main-owned.

Desktop v1 safety rules:

- the main `SKILL.md` instructions are included for the bound task;
- only safe text resources explicitly referenced by those instructions are progressively included;
- imported scripts are **never executed**;
- `allowed-tools` / `allowedTools` is an experimental declaration only and **does not authorize Tools**.

### Quick Messages

Quick Messages are templates available from the Reader AI composer `+` menu. Supported template variables are:

- `{{article_title}}`
- `{{article_url}}`
- `{{selection}}`
- `{{summary}}`

If a variable is unavailable for the current context, OrigRead blocks the send locally instead of forwarding an unresolved template to the model.

## 4. Remote MCP

Remote MCP uses Streamable HTTP. Supported authentication modes are:

- None
- Bearer Token
- Custom Headers
- OAuth

Servers are not connected simply because the app starts. Use an explicit connection test or Tool Catalog refresh after saving a profile.

### Tool approval

**Every MCP Tool requires explicit user approval.**

Server-provided `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` and related metadata are descriptive risk hints only. They never grant permission and cannot bypass OrigRead's central approval gate.

An automatic Tool loop shows an approval card before execution. If denied, the Tool does not execute and the model can continue with the denial result. For a manual Tool selected from the composer `+` menu, the explicit Run action is the one-shot approval for that execution.

## 5. Local stdio MCP

A Local MCP profile contains:

- Command
- Args
- Working directory
- Environment in `KEY=VALUE` form

Environment values are stored in the Main-process SecretStore. Renderer normally receives only presence/length metadata.

Lifecycle rules:

- Local MCP is not spawned at app startup;
- it starts lazily for connection tests, Tool refresh or real execution;
- normal app exit waits for active stdio children to close;
- a parent-PID guardian covers abnormal Main-process termination so children are not left orphaned indefinitely.

## 6. Secrets and configuration backup

Sensitive values include:

- AI API keys;
- Web Search API keys;
- Remote MCP Bearer/Custom Header credentials;
- MCP OAuth tokens;
- Local stdio environment values.

They are managed by Electron Main-process secure storage instead of ordinary plaintext `app_settings` fields. Settings show presence/length by default and temporarily expose plaintext to Renderer only after an explicit reveal action.

Configuration backup excludes credentials by default. Credentials enter an encrypted backup block only when you explicitly choose to include them and protect the backup with a password.

Restore treats SQLite configuration, file-backed rule repositories and SecretStore as one logical transaction. A late restore failure rolls back previously written configuration instead of leaving a half-restored state.

## 7. Stop, crash recovery and Tool side effects

- Provider, Search and cooperative Tools respond to Stop.
- If a third-party Tool ignores AbortSignal, OrigRead still stops visible generation promptly and discards the late Tool Result. A later request in the same Conversation waits for the old Tool to settle to avoid overlapping side effects.
- Startup recovery terminates interrupted Assistant/Search/Tool states without automatically replaying RUNNING or PENDING_APPROVAL Tools.
- Persisted partial Reasoning/Answer content is retained.

## 8. Troubleshooting order

1. AI — test the Provider, confirm the key is saved and select a model.
2. Search — test the Search Provider; SearXNG needs a working endpoint.
3. Remote MCP — test the connection, then refresh the Tool Catalog. OAuth authorization URLs are restricted to HTTP/HTTPS.
4. Local MCP — verify the command exists, cwd is valid and env uses one `KEY=VALUE` per line.
5. Tool appears stuck — check Reader AI for a pending approval card.

For automated and manual release checks, see [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).
