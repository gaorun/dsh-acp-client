# dsh-acp-client

让 DeepSeek Harness（DSH）作为 **ACP 客户端**，把外部 ACP Agent（Qoder、Claude Code、Gemini CLI 等）当作「模型」接入：在模型下拉框里选中 Agent 及其模型，对话 / 轨迹 / 统计与原生模型一致。

> **状态：探索 + 设计 + 骨架已交付；核心纯函数已实现并通过单测；GUI 接入（Host adapter 落线 + 设置页）为设计态，尚未在 dsh 运行时内安装验证。**

## 结论

DSH 已有一条干净的 LLM adapter 抽象（`@deepseek-ai/dsh-llm`），模型下拉框、对话、轨迹、统计全部由它驱动。因此 **ACP Agent = 一个新的 LLM adapter**，不是改 agent-loop 或 session。官方 `@agentclientprotocol/sdk@1.4.0` 已随 DSH 打包（v1 稳定 + v2 实验）。完整设计见 [`docs/design.md`](docs/design.md)。

## 与需求逐条对应

| # | 需求 | 落地 | 状态 |
|---|---|---|---|
| 1 | ACP Registry 设置页（侧栏入口）+ 自定义 Agent | `lib/client.js`（`settings.section` slot）+ `src/registry.mjs` + config 持久化 | 设计态（M3） |
| 2 | 模型下拉框选 Agent 及模型 | adapter `registerAdapter` + `listModels`（provider = `acp:<id>`） | 设计态（M2） |
| 3 | 对话/轨迹/统计同模型 | 全走 `ctx.llm.stream`，免费继承 | 设计态（M2） |
| 4 | V1 先、V2 可扩展 | `protocolVersion` 字段 + `v1-session` / `v2-session` 分离 | V1 设计态、V2 扩展点 |
| 5 | my-repos 下新建 `dsh-acp-client` | 本仓库 | ✅ |

## 目录

| 路径 | 作用 | 状态 |
|---|---|---|
| `docs/design.md` | 完整设计：adapter 契约、ACP↔stream 映射、Registry、V1/V2、里程碑 | ✅ |
| `src/v1-mapping.mjs` | ACP v1 `session/update` → DSH stream chunk 映射（纯函数） | ✅ 已测 |
| `src/launch.mjs` | registry 分布（npx/uvx/binary/command）→ spawn 命令 | ✅ 已测 |
| `src/registry.mjs` | registry.json 拉取 + manifest 校验/规范化 | ✅ 已测 |
| `src/adapter.mjs` | `AcpAdapter extends LlmAdapter`（listModels/resolveModel/stream） | 骨架（M2） |
| `src/v1-session.mjs` | ACP v1 会话驱动（SDK connectWith/buildSession）占位 | 骨架（M2） |
| `lib/index.js` | Host 插件入口：注册 adapter + Config schema | 骨架（M2） |
| `lib/client.js` | 浏览器半：ACP Registry 设置页（`settings.section`） | 骨架（M3） |
| `test/core.test.mjs` | 核心纯函数单测 | ✅ 13/13 |

## 验证

```bash
node --test          # 13/13 通过（v1-mapping / launch / registry）
```

未验证（如实说明）：Host adapter 与设置页需经 `plugin_manager install_bundle` 装进 profile 并在 dsh 运行时内验证；本仓库未做 git init / 安装（见 AGENTS.md「未经确认不主动执行 Git 操作」）。

## 关键设计决策（详见 design.md）

- **接入点**：LLM adapter（`ctx.llm.registerAdapter`），provider 命名 `acp:<id>`。
- **有状态桥**：DSH 的 `stream(messages)` 是无状态单次调用，而 ACP Agent 是整回合有状态；adapter 用 `options.sessionId → ACP 会话` 的 Map 桥接，只把「本轮新增用户文本」发成 `session/prompt`。
- **语义映射**：`agent_message_chunk→text-delta`、`agent_thought_chunk→reasoning-delta`、`tool_call→reasoning`（v1 降级）、`usage_update→usage`、`stopReason→finish`。
- **V1/V2**：`protocolVersion` 字段切换 `v1-session` / `v2-session`，上层（registry 页/下拉/轨迹/统计）不动。
- **数据源澄清**：用户给的 `agent.schema.json` 是校验 manifest 的 JSON Schema；真正的列表是聚合的 `registry.json`（CDN `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`）。

## 后续（按里程碑推进）

1. **M2**：`src/v1-session.mjs` 用 SDK 落线 `client()/connectWith/buildSession`，接进 `lib/index.js`，装 bundle 验证「模型下拉框出现 Agent、可对话」。
2. **M3**：`lib/client.js` 实现 registry 列表 + 安装 + 自定义表单。
3. **M4**：`src/v2-session.mjs` 用 `@agentclientprotocol/sdk/experimental/v2`，切换 `protocolVersion`。

先例可复用：`my-repos/acp-v2v1-shim`（v2↔v1 逐方法映射，已验证 Qoder v1 / Delta v2 真实流量）；DSH 自带的 `dsh-acp` 服务器是反方向的 update↔语义映射参考。
