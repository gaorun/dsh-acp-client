# dsh-acp-client 设计

> 目标：让 DeepSeek Harness（DSH）作为 **ACP 客户端**，把外部 ACP Agent（Qoder、Claude Code、Gemini CLI 等）当作「模型」接入：在模型下拉框里选中 Agent 及其模型，对话 / 轨迹 / 统计与原生模型一致。
>
> 本文是探索结论 + 落地方案。DSH 版本：`0.2.2-rc.1`。

## 0. 结论先行

DSH 已经有一条干净的 **LLM adapter 抽象**（`@deepseek-ai/dsh-llm`），模型下拉框、对话、轨迹、统计全部由它驱动。因此 **ACP Agent 的正确接入点 = 一个新的 LLM adapter**（本仓库 `dsh-acp-client`），而不是改 agent-loop 或 session。现有 `@deepseek-ai/dsh-acp` 是**方向相反的 ACP v1 服务器**（让外部客户端驱动 DSH），不能直接复用，但它的「update ↔ 语义」映射表是反方向的绝佳参考；官方 `@agentclientprotocol/sdk@1.4.0` 已随 DSH 打包，直接提供 v1 稳定客户端 + v2 实验客户端。

一句话：**新增 `dsh-acp-client` bundle（Host adapter + 一个 ACP Registry 设置页 + 模型下拉自动出现），ACP Agent 以 provider 身份进入 `ctx.llm`，其余交互全部继承。**

---

## 1. 现状：DSH 已经有什么、缺什么

| 需求 | 现状 | 结论 |
|---|---|---|
| 模型下拉框 | `dsh-client-ui-model-selection` 读取 `ctx.remote.session.modelCatalog()`，其 `groups[]` 按 provider 分组，来自各 adapter 的 `listModels()` | 只要 adapter 注册 provider 并实现 `listModels`，Agent 的模型自动出现在下拉框 |
| 对话 / 轨迹 / 统计 | agent-loop → `ctx.llm.stream()` → `BlockAssembler` 组装消息 → session 持久化 / trajectory / stats | adapter 只返回 chunk 流，其余全部免费继承 |
| ACP 客户端 | **无**。仅有 `dsh-acp`（v1 服务器） | 需新写 |
| ACP SDK | `@agentclientprotocol/sdk@1.4.0`（v1 稳定 + `experimental/v2`）已随 DSH 打包在 `dsh/node_modules` | 直接 import，无需再装 |
| Registry 页 | 设置页是「surface plugin」：Host 半 `apply()` + Client 半（`dsh.client` 声明），注册进 settings shell 的 slot | 新增一个 `dsh-client-ui-settings-acp` 风格的 UI 半 |

### 1.1 LLM adapter 契约（关键）

`dsh-llm` 的 `LlmAdapter`（`dsh-llm/lib/index.js`）是 adapter 要实现的接口：

- `registerAdapter(providers: string[], adapter)` —— 注册 provider 路由，同名 provider 冲突即 `DUPLICATE_ADAPTER`。
- `listModels(provider) → Promise<ModelCatalogEntry[]>` —— 返回 `{provider, id, name, description?, inputModalities?, badge?}`，决定下拉框内容。
- `resolveModel(provider, model, signal) → Promise<{provider, id, name, description?, context?, inputModalities?, systemPromptUpdate?, toolUpdate?, reasoning?}>` —— 精确模型元数据。
- `prepareCall(provider, model, signal) → { model, stream(options) }` —— 绑定一次调度的代次。
- `stream(options) → AsyncIterable<StreamChunk>` —— 真正的流，chunk 类型：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。

`GenerateOptions` 含 `provider, model, reasoningEffort?, temperature?, maxTokens?, stop?, messages, tools?, toolHistory?, sessionId?, signal?, purpose?`。`messages` 是完整会话（system/user/assistant/tool），深冻结、不可改写。

### 1.2 ACP 客户端语义与 LLM stream 的本质差异（必须处理）

ACP Agent 是**有状态、自带工具、整回合**的：

- ACP 客户端：`initialize` → `session/new` → `session/prompt`（只发新增用户内容，Agent 自己维护历史）→ 消费 `session/update` 通知 → `session/close`。
- LLM stream：**无状态、单次调用**，每次把完整 `messages` 传给 provider，返回 text/tool-call 增量。

映射方案（本仓库核心）：

| ACP v1 语义 | DSH LLM stream | 说明 |
|---|---|---|
| `session/new`（一次/DSH session） | 首帧前，按 `options.sessionId` 缓存 ACP 会话 | 有状态 → 无状态的桥 |
| `session/prompt` 的新用户文本 | `options.messages` 末尾的新 user 消息 | 只把「本轮新增」发给 Agent，不回放历史 |
| `agent_message_chunk`（text） | `block-start`+`text-delta` | 助手正文 |
| `agent_thought_chunk` | `reasoning-delta` | 思考轨迹（进 trajectory） |
| `tool_call` / `tool_call_update`（Agent 自己的工具活动） | `reasoning-delta`（v1 MVP 降级为文本，保留 `_meta` 原始结构） | DSH 的 `tool-call` 块是「DSH 要执行」的；Agent 自己已执行完的工具，没有对应块，v1 先以思考轨迹呈现 |
| `usage_update` | `usage` | 统计 |
| 回合结束 / `stopReason` | `finish`（stop/error/aborted） | 终止 |
| `request_permission` | 需要人工/策略应答 | v1 默认 auto-allow/reject 由策略决定 |

> **有状态桥**：adapter 维护 `sessionId → AcpSessionHandle` 的 Map。AC 进程与 ACP session 在 DSH session 生命周期内保持存活（`session/close` 于 DSH session 销毁时清理）。这样「用模型」的交互（连续对话、轨迹累积、统计）原样成立。

---

## 2. 目标架构

```
┌─ DSH agent-loop ─────────────────────────────┐
│  ctx.llm.stream({provider:"acp:qoder", ...}) │
└──────────────────┬───────────────────────────┘
                   │ listModels / stream
┌──────────────────▼───────────────────────────┐
│  dsh-acp-client  (Host: LLM adapter)         │
│   ├─ adapter.js      LlmAdapter 子类         │
│   ├─ session-store.js  sessionId→ACP 会话    │
│   ├─ v1-session.js   ACP v1 客户端（SDK）    │
│   ├─ (future) v2-session.js  ACP v2 客户端   │
│   ├─ launch.js        registry 条目→spawn    │
│   └─ registry.js      registry.json 拉取/校验 │
└──────────────────┬───────────────────────────┘
                   │ spawn stdio
┌──────────────────▼───────────────────────────┐
│  外部 ACP Agent（qodercli --acp / npx …）     │
└──────────────────────────────────────────────┘
```

UI 半（`dsh-client-ui-settings-acp`）：ACP Registry 设置页（侧栏 Settings 入口），拉取 registry 渲染 Agent，「安装」= 写入 agent 定义，「自定义」= 表单填命令/版本，模型下拉框由 adapter 自动填充。

### 2.1 provider 命名

一个已安装的 ACP Agent = 一个 provider 路由。命名用 `acp:<agentId>`（如 `acp:qoder`），避免与内建 provider 冲突。`listModels` 返回该 Agent 在 `initialize`/`session/new` 里 `availableModes`/`availableModels` 声明的模型 id（v1 的 `availableModes`，通常 `primary`）。

### 2.2 安装 = 持久化 agent 定义

不手写 profile 的 `cordis.patch.yml`。用 Host 的 `configEditor` 持久化 adapter 自身的 config（`agents: [...]`，每项含 `id/name/version(protocolVersion)/distribution`），见 `cordis-plugin-development` 的「Persist your own configuration」。注册表条目与自定义条目都落进这个数组；adapter 启动时按数组 `registerAdapter`（每个 agent 一个 provider）。

---

## 3. ACP Registry 设置页

数据源与用户给的 URL 有一处要澄清：`agent.schema.json` 是 **manifest 的 JSON Schema**（校验单个 `<id>/agent.json`），不是列表。真正的列表是聚合后的 `registry.json`：

- 仓库：`github.com/agentclientprotocol/registry`，结构 `<id>/agent.json` + `icon.svg`。
- 聚合产物：`registry.json`（`{version, agents:[...]}`），发布到 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`。

页面实现（与用户第 1 条对应）：
1. 拉取 `registry.json`（回退：GitHub API 列 `<id>/agent.json`）；用 `agent.schema.json` 校验条目（`src/registry.mjs` 内置一份 schema 子集 + 运行时校验）。
2. 渲染 Agent 卡片（name/description/license/distribution/icon）。
3. 「安装」→ 把条目规范化成 agent 定义写入 config → adapter `replace` 路由 → 模型下拉框即时出现。
4. 「自定义 ACP Agent」→ 表单：名称、启动命令（或 npx/uvx/binary）、`protocolVersion`（v1/v2，默认 v1）、args/env。

`protocolVersion` 与用户第 4 条对应：adapter 内部接口与版本无关，`v1-session.js` / `v2-session.js` 按条目字段选择；v1 先实现，v2 留扩展点（当前抛「暂不支持」，或走 SDK `experimental/v2`）。

---

## 4. V1 先、V2 扩展（需求 4）

- **v1（本次落地）**：SDK 稳定入口 `@agentclientprotocol/sdk` 的 `client()` + `ndJsonStream` + `buildSession`。覆盖 `initialize / session/new / session/prompt / session/cancel / session/update / request_permission / session/close`。
- **v2（扩展点）**：SDK `@agentclientprotocol/sdk/experimental/v2`；`resolveModel`/`stream` 走 `V2Session`。因为本仓库 adapter 只暴露「chunk 流」这一层，v2 只替换 `*-session.js`，registry 页、模型下拉、轨迹、统计全部不动。
- **迁移表参考**：`my-repos/acp-v2v1-shim` 已把 v2↔v1 的逐方法映射做成表（`src/map/registry.mjs`），并验证过 Qoder(v1) 与 Delta(v2) 真实流量；本仓库若要在 v1 上先通，可复用它「v2 客户端 → v1 agent」的映射方向，但 DSH 本身是客户端，优先直接用 SDK 的 v1 入口，不必引入 shim。

---

## 5. 与需求逐条对应

| # | 需求 | 落地 |
|---|---|---|
| 1 | ACP Registry 设置页 + 自定义 | `lib/client.js`（settings slot）+ `src/registry.mjs` + config 持久化 |
| 2 | 模型下拉框选 Agent 及模型 | adapter `listModels` / `registerAdapter`（provider = `acp:<id>`） |
| 3 | 对话/轨迹/统计同模型 | 全走 `ctx.llm.stream`，agent-loop/session/trajectory/stats 免费继承 |
| 4 | V1 先、V2 可扩展 | `protocolVersion` 字段 + `v1-session` / `v2-session` 分离 |
| 5 | my-repos 下新建 `dsh-acp-client` | 本仓库 |

---

## 6. 里程碑

1. **M1（核心，本仓库已含可测实现）**：`v1-mapping.mjs`（update→chunk 映射）、`launch.mjs`（distribution→spawn）、`registry.mjs`（registry 拉取/校验）。纯函数、单测可跑。
2. **M2（Host adapter）**：`lib/index.js` 注册 `LlmAdapter`，接入 `ctx.llm.registerAdapter` + `configEditor` 持久化，`session-store` 有状态桥。
3. **M3（UI）**：`lib/client.js` ACP Registry 设置页 + 自定义表单 + 安装。
4. **M4（v2 扩展）**：`v2-session.js`，切换 `protocolVersion`。

---

## 7. 已知风险 / 开放问题

- **工具轨迹保真**：ACP Agent 的工具活动没有直接对应的 DSH 流块；v1 先以 reasoning/text 呈现，若要高保真，需扩展 trajectory 投影（后续）。
- **进程生命周期**：ACP 进程随 DSH session 存活，长时间空闲需 idle 回收；崩溃要映射为 `finish(error)`，避免 loop 挂起（`acp-v2v1-shim` 的 `agent_crash` 处理可参考）。
- **图片/文件输入**：v1 仅文本 + 资源链接起步，图片在 registry/Agent 能力明确后再开。
- **权限**：ACP `request_permission` 需接入 DSH 的 approval 策略，v1 先用可配置的 auto-allow/reject。
