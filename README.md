# Obsidian MCP Server

**Your Obsidian vault, shared with MCP-compatible AI agents. Self-hosted, searchable, and ready wherever you work.**

**让 Obsidian 成为支持 MCP 的 AI Agent 的共享记忆：自托管、可检索、可协作、可追溯。**

[English](#english) · [中文](#中文)

---

## English

### Your notes are already valuable. Let every agent work with them.

Give MCP-compatible AI agents **one shared, human-readable memory** in your own
Obsidian vault. Search past decisions, follow connections, work with Skills,
and safely update Markdown — while you review the very same knowledge in a
built-in web workspace.

**Self-hosted · Remote MCP over HTTPS · Hybrid search · Safe, auditable writes ·
Web workspace · Multi-vault access**

Run it on a home server, NAS, VPS, or private host. Your Markdown files remain
yours; neither Obsidian nor an always-open desktop app is required for server
operations.

**For example:** Ask an agent, *“What did we decide about authentication,
and which design notes support it?”* It can retrieve relevant notes, follow
links, and propose a revision. The decision stays in the vault, where you or
another connected agent can inspect and build on it.

### The idea

| What you share | What it means |
| --- | --- |
| **Memory** | A durable, human-readable memory area for agents and people. Capture facts, decisions, and context; recall them later from any connected client. |
| **Knowledge** | Your Obsidian vault: notes, links, tags, properties, tasks, Bases, Canvas, attachments, and search. The vault stays the source of truth. |
| **Skills** | Reusable instructions and workflows stored as Markdown. Agents can list, match against, and validate skills, then follow them in later work. |
| **Real time** | Live updates in the web workspace, revision-aware writes, and optional Git auto-commit so humans and agents see changes as they happen. |
| **Any place** | MCP over HTTPS for agents, a responsive web workspace for people, and multi-vault support for separate knowledge spaces. (Installable PWA support is planned.) |
| **Always online** | A small Docker Compose deployment with persistent storage, health checks, backups, OAuth, scopes, and an admin plane. |

The point is not another note app. It is a **shared layer between people and
agents** where the same memory, knowledge, and skills are readable, writable,
searchable, and auditable in real time.

### How it works

```text
┌──────────────────────┐        MCP over HTTPS        ┌────────────────────────┐
│ Agents               │  ──────────────────────────> │  Obsidian MCP Server   │
│ Claude, ChatGPT,     │  <────────────────────────── │  Docker + Node.js      │
│ Cursor, Codex, ...   │                              │                        │
└──────────────────────┘                              │   ┌────────────────┐   │
                                                      │   │ Obsidian vault │   │
┌──────────────────────┐        Web workspace         │   │ Markdown + YAML│   │
│ Humans               │  ──────────────────────────> │   └────────────────┘   │
│ Desktop, tablet,     │  <────────────────────────── │                        │
│ phone                │                              │   Admin + audit plane  │
└──────────────────────┘                              └────────────────────────┘
```

- **The vault is the database.** Notes remain ordinary Markdown and YAML files.
  There is no proprietary note format and no lock-in.
- **MCP is the agent interface.** A Streamable HTTP MCP endpoint exposes notes,
  search, links, files, plans, history, trash, Publish, Git, memory, skills,
  retrieval, Bases, and Canvas tools.
- **The web app is the human interface.** Read, edit, search, manage properties,
  work with Bases and Canvas, and publish notes from a browser.
- **The admin plane is the control surface.** OAuth clients, API keys, scopes,
  vault allowlists, audit history, time-window authorization, and per-vault Git
  settings are managed in one place.

### What you can do

- **Knowledge work:** read, write, patch, search, and organize notes; follow
  links, backlinks, aliases, tags, properties, and the graph; manage tasks,
  daily notes, templates, attachments, archives, Bases, and Canvas.
- **Shared memory:** capture durable facts and decisions into a memory area that
  both agents and humans can read, search, and correct.
- **Skills for agents:** keep reusable procedures in Markdown; let agents
  discover and validate the right skill for a task instead of repeating prompts.
- **Safe collaboration:** revision checks, optimistic concurrency, version
  history, trash, multi-note plans with diffs, and a mutation journal for
  recovery.
- **Publish and share:** turn selected notes into public pages with an opaque
  publication identity, without exposing the rest of the vault.
- **Agent-native access:** domain-oriented MCP tools, progressive tool discovery, scoped
  credentials, per-vault access, and support for multiple vaults.
- **Operations:** Docker Compose, health checks, persistent data, audit logs,
  optional per-vault Git integration, and OAuth/API-key authentication.
- **Anywhere access:** a responsive web workspace and remote MCP over HTTPS.
  An installable PWA is on the roadmap.

### Quick start

Requirements: Docker with Compose, and an Obsidian vault directory.

```bash
git clone https://github.com/OhiyoX/obsidian-mcp-server-public.git
cd obsidian-mcp-server-public
cp .env.example .env
# Edit .env: point OBSIDIAN_VAULT_PATH at your vault and set an API key or OAuth.
docker compose up -d --build
```

Local endpoints:

| Surface | URL |
| --- | --- |
| MCP | `http://localhost:18923/mcp` |
| Web login | `http://localhost:18923/auth/login` |
| Admin | `http://localhost:18923/admin/auth` |
| Health | `http://localhost:18923/healthz` |

For a remote or public deployment, put the service behind an HTTPS reverse
proxy and set at least:

```dotenv
OAUTH_ENABLED=true
PUBLIC_BASE_URL=https://mcp.example.com
OAUTH_ADMIN_PASSWORD=replace-with-a-strong-secret
OAUTH_INITIAL_USERNAME=admin
OAUTH_INITIAL_PASSWORD=replace-with-a-strong-secret
TRUST_PROXY=127.0.0.1
```

Never expose the service directly to the internet without TLS and
authentication. The example values are placeholders, not production secrets.

### Connect an agent

Use the Streamable HTTP MCP endpoint and either an API key or OAuth:

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-API-Key": "replace-with-your-key"
      }
    }
  }
}
```

- For API keys, set `API_KEY` in `.env` and keep the header name in
  `API_KEY_HEADER` (default `X-API-Key`).
- For interactive clients, prefer OAuth 2.1 with PKCE and set
  `PUBLIC_BASE_URL` to the externally reachable HTTPS origin.
- The repository also ships a project skill:
  [`skills/connect-obsidian-mcp`](skills/connect-obsidian-mcp).

### Use it from the browser

Open the web workspace and sign in. The same vault is available to people and
agents, with live updates and revision-safe edits. The admin plane at
`/admin/auth` manages accounts, API keys, OAuth clients, scopes, vault access,
audit history, and time-window authorization.

### Security and data ownership

- **Self-hosted by design.** The vault stays on your server. There is no hosted
  account layer. Plain Markdown files remain readable and portable.
- **Authentication and authorization.** OAuth 2.1/PKCE for people, API keys for
  agents, scopes, vault allowlists, optional read-only mode, trusted-proxy
  configuration, audit history, and time-window authorization.
- **Safe writes.** Atomic writes, SHA-256 revisions, optimistic concurrency,
  version history, trash, plan/diff review, and a persistent mutation journal.
- **Embeddings are explicit.** Only the embedding endpoint you configure
  receives text selected for embedding. Use a local model or a provider you
  trust.
- **Operational hygiene.** Keep `.env` and data directories out of Git, back up
  the vault and `./data`, and use TLS for every remote connection.

### Operations

- Persistent application data lives under `./data`; the vault is mounted from
  `OBSIDIAN_VAULT_PATH`.
- Health: `GET /healthz`.
- Update: pull the new source, rebuild the image, and restart the service; the
  Compose setup does not use a file watcher for source changes.
- Optional Git integration per vault: status, diff, log, commit, pull, push,
  and debounced auto-commit.
- Back up both the vault and `./data` before upgrades. Version history and trash
  are useful, but they are not a substitute for external backups.

### Documentation

- [Setup and configuration](docs/USER_CONFIGURATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Web operations](docs/WEB_OPERATIONS.md)
- [Publish and public pages](docs/ADMIN_PUBLISH.md)
- [Per-vault Git settings](docs/ADMIN_VAULT_GIT.md)
- [Mutation recovery](docs/MUTATION_RECOVERY.md)
- [Time-window authorization](docs/AUTHZ_TIME_WINDOWS.md)
- [Release and deployment](docs/RELEASE_AND_DEPLOY.md)
- [Private Gitea / public GitHub workflow](docs/DUAL_REPOSITORY_WORKFLOW.md)
- [Agent setup prompt](docs/AGENT_SETUP_PROMPT.md)
- [Connect skill](skills/connect-obsidian-mcp)

### Repository model: private development, public source

- **Gitea is the private source of truth:** development, review, immutable
  release tags, and production provenance.
- **[GitHub public distribution](https://github.com/OhiyoX/obsidian-mcp-server-public)**
  is a curated, reviewed source snapshot and the community entry point.
  Source history and commit SHAs may differ by design; snapshots are not
  an automatic bidirectional mirror.
- External GitHub issues and PRs are welcome; accepted contributions are
  reviewed before being integrated into the private development line.
- Read the [dual-repository workflow](docs/DUAL_REPOSITORY_WORKFLOW.md) for
  source authority, review rules, public-safety checks, and version mapping.

### Repository, community, and license

This repository is a source distribution of the project. Issues and pull
requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report security
issues privately via [SECURITY.md](SECURITY.md).

The project is licensed under the [MIT License](LICENSE). Third-party packages
and bundled fonts retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Obsidian is a trademark of Dynalist Inc. This is an independent, unofficial
integration and is not affiliated with or endorsed by Obsidian.

---

## 中文

### 让你的 Obsidian 知识库，成为所有 Agent 的共享记忆

让支持 MCP 的 AI Agent 通过**同一份人类可读的记忆**协作：找回以前的决策、
关联笔记、复用 Skills、修改 Markdown；你则在内置 Web 工作区中查看、纠正和继续编辑。

**自托管 · HTTPS 远程 MCP · 混合检索 · 安全可审计写入 · Web 工作区 · 多 Vault**

部署在 NAS、家庭服务器、VPS 或私有主机上。数据仍是你拥有的 Markdown 文件；
服务端工作不依赖 Obsidian 桌面应用一直运行。

**一个场景：**你问 Agent「我们上次为什么选择这个认证方案？依据在哪些笔记里？」
它可以检索决策、追踪关联文档，再提出修订方案。修改留在 Vault 中，方便你或其他
Agent 核对与继续使用。

### 核心理念

| 共享什么 | 含义 |
| --- | --- |
| **记忆** | 一块持久、人类可读的共享记忆区。记录事实、决策与上下文，之后任何接入方都能召回。 |
| **知识** | 你的 Obsidian Vault：笔记、链接、标签、属性、任务、Bases、Canvas、附件与搜索。Vault 始终是事实源。 |
| **技能** | 以 Markdown 保存的可复用指令与工作流。Agent 可以发现、匹配并校验技能，然后在后续任务中执行。 |
| **实时** | Web 工作区实时更新、写入带修订检查，可选 Git 自动提交，让人与 Agent 及时看到变化。 |
| **任何地方** | Agent 用 HTTPS 上的 MCP；人用响应式 Web 工作区；多 Vault 支持独立知识空间。可安装 PWA 仍在规划中。 |
| **永远在线** | 小型 Docker Compose 部署，持久化存储、健康检查、备份、OAuth、Scope 与 Admin 管理面。 |

目标不是再做一个笔记应用，而是做**人与 Agent 之间的共享层**：同一份记忆、知识与
技能，可以实时读取、写入、搜索与审计。

### 如何工作

```text
┌──────────────────────┐        HTTPS 上的 MCP        ┌────────────────────────┐
│ Agent                │  ──────────────────────────> │  Obsidian MCP Server   │
│ Claude、ChatGPT、    │  <────────────────────────── │  Docker + Node.js      │
│ Cursor、Codex…       │                              │                        │
└──────────────────────┘                              │   ┌────────────────┐   │
                                                      │   │ Obsidian Vault │   │
┌──────────────────────┐        Web workspace         │   │ Markdown + YAML│   │
│ 人                   │  ──────────────────────────> │   └────────────────┘   │
│ 桌面、平板、手机     │  <────────────────────────── │                        │
│                      │                              │   Admin + 审计面       │
└──────────────────────┘                              └────────────────────────┘
```

- **Vault 就是数据库。** 笔记仍是普通 Markdown + YAML 文件，没有私有格式，没有锁定。
- **MCP 是 Agent 接口。** 通过 Streamable HTTP 暴露笔记、搜索、链接、文件、计划、
  历史、回收站、Publish、Git、记忆、技能、检索、Bases 与 Canvas 能力。
- **Web 是人的界面。** 在浏览器中阅读、编辑、搜索、管理属性、
  使用 Bases/Canvas、发布笔记。
- **Admin 是控制面。** 集中管理 OAuth 客户端、API Key、Scope、Vault allowlist、
  审计历史、定时授权与按库 Git 配置。

### 可以做什么

- **知识工作：** 读写、修补、搜索与整理笔记；跟踪链接、反链、别名、标签、属性与
  关系图；管理任务、日记、模板、附件、归档、Bases 与 Canvas。
- **共享记忆：** 把事实与决策写入记忆区，Agent 与人人都能读取、搜索和纠正。
- **Agent 技能：** 把可复用流程保存为 Markdown，让 Agent 自己发现并校验适合当前
  任务的技能，而不是反复堆提示词。
- **安全协作：** 修订检查、乐观并发、版本历史、回收站、多笔记计划与 diff、
  可恢复的 mutation journal。
- **发布分享：** 把选定笔记发布为公开页面，使用不透明发布 ID，不暴露 Vault 其余内容。
- **Agent 原生：** 领域化 MCP 工具、渐进式工具发现、带 Scope 的凭据、按 Vault 授权、
  多 Vault 支持。
- **运维：** Docker Compose、健康检查、持久化数据、审计日志、可选的按库 Git 集成、
  OAuth/API Key 认证。
- **任何地方访问：** 响应式 Web 与 HTTPS 远程 MCP；可安装 PWA 属于待交付功能。

### 快速开始

前置条件：Docker + Compose，以及一个 Obsidian Vault 目录。

```bash
git clone https://github.com/OhiyoX/obsidian-mcp-server-public.git
cd obsidian-mcp-server-public
cp .env.example .env
# 编辑 .env：把 OBSIDIAN_VAULT_PATH 指向你的 Vault，并设置 API Key 或 OAuth
docker compose up -d --build
```

本地入口：

| 面 | 地址 |
| --- | --- |
| MCP | `http://localhost:18923/mcp` |
| Web 登录 | `http://localhost:18923/auth/login` |
| Admin | `http://localhost:18923/admin/auth` |
| 健康检查 | `http://localhost:18923/healthz` |

远程或公网部署时，请在 HTTPS 反向代理之后运行，并至少设置：

```dotenv
OAUTH_ENABLED=true
PUBLIC_BASE_URL=https://mcp.example.com
OAUTH_ADMIN_PASSWORD=替换为强随机口令
OAUTH_INITIAL_USERNAME=admin
OAUTH_INITIAL_PASSWORD=替换为强随机口令
TRUST_PROXY=127.0.0.1
```

不要把服务在没有 TLS 和认证的情况下直接暴露到公网。示例值只是占位符，不是生产密钥。

### 接入 Agent

使用 Streamable HTTP MCP 端点，并通过 API Key 或 OAuth 认证：

```json
{
  "mcpServers": {
    "obsidian": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-API-Key": "替换为你的密钥"
      }
    }
  }
}
```

- API Key：在 `.env` 设置 `API_KEY`，请求头名由 `API_KEY_HEADER` 控制
  （默认 `X-API-Key`）。
- 交互式客户端优先使用 OAuth 2.1 + PKCE，并把 `PUBLIC_BASE_URL` 设为外部可达的
  HTTPS 源。
- 仓库自带项目 Skill：
  [`skills/connect-obsidian-mcp`](skills/connect-obsidian-mcp)。

### 浏览器使用

打开 Web 工作区并登录。人与 Agent 使用同一个 Vault，支持实时更新与修订安全写入。
`/admin/auth` 管理账户、API Key、OAuth 客户端、Scope、Vault 访问、审计历史与
定时授权。

### 安全与数据归属

- **自托管优先。** Vault 留在你的服务器上，没有托管账户层；普通 Markdown 文件
  始终可读、可迁移。
- **认证与授权。** 人用 OAuth 2.1/PKCE，Agent 用 API Key；支持 Scope、Vault
  allowlist、只读模式、可信代理配置、审计历史与定时授权。
- **安全写入。** 原子写、SHA-256 修订、乐观并发、版本历史、回收站、计划/diff
  审核与持久化 mutation journal。
- **Embedding 可控。** 只有你配置的 embedding 端点会收到选定用于向量化的文本；
  可跑本地模型，也可指向你信任的提供方。
- **运维卫生。** `.env` 与数据目录不要进 Git；定期备份 Vault 与 `./data`；
  所有远程连接都走 TLS。

### 运维

- 持久化应用数据在 `./data`；Vault 从 `OBSIDIAN_VAULT_PATH` 挂载。
- 健康检查：`GET /healthz`。
- 升级：拉取新源码、重建镜像、重启服务；Compose 不使用源码文件监听器。
- 可按 Vault 启用 Git：status、diff、log、commit、pull、push，以及防抖自动提交。
- 升级前备份 Vault 与 `./data`。版本历史与回收站有用，但不能替代外部备份。

### 文档

- [安装与配置](docs/USER_CONFIGURATION.md)
- [架构](docs/ARCHITECTURE.md)
- [Web 运维](docs/WEB_OPERATIONS.md)
- [Publish 与公开页面](docs/ADMIN_PUBLISH.md)
- [按 Vault 的 Git 配置](docs/ADMIN_VAULT_GIT.md)
- [Mutation 恢复](docs/MUTATION_RECOVERY.md)
- [定时授权](docs/AUTHZ_TIME_WINDOWS.md)
- [发布与部署](docs/RELEASE_AND_DEPLOY.md)
- [双仓维护与公开快照安全边界](docs/DUAL_REPOSITORY_WORKFLOW.md)
- [Agent 配置提示词](docs/AGENT_SETUP_PROMPT.md)
- [Connect Skill](skills/connect-obsidian-mcp)

### 仓库分工：私有开发与公开源码发行

- **Gitea 私有仓是开发与生产发布权威源**：变更审查、合并、版本标签与生产回执。
- **[GitHub 公开仓](https://github.com/OhiyoX/obsidian-mcp-server-public)**
  是经检查的源码快照与社区入口，不是自动双向镜像；两边的 Git 提交 SHA 可以不同。
- GitHub 欢迎公开 issue/PR，采纳的变更须经内部代码审查再纳入发行快照。
- 双仓同步、脱敏、PR 审计和发布身份详见
  [双仓维护契约](docs/DUAL_REPOSITORY_WORKFLOW.md)。

### 仓库、社区与许可证

本仓库是项目的源码分发。欢迎提交 issue 与 pull request，见
[CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md)
私下报告。

项目采用 [MIT License](LICENSE)。第三方包与内置字体保留各自许可证，见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Obsidian 是 Dynalist Inc. 的商标；本项目是独立、非官方集成，与 Obsidian 无隶属
或背书关系。
