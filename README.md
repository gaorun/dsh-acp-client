# dsh-acp-client

让 DeepSeek Harness（DSH）作为 **ACP 客户端**，把外部 ACP Agent（Qoder、Claude Code、Gemini CLI 等）当作「模型」接入：在模型下拉框里选中 Agent 及其模型，对话 / 轨迹 / 统计与原生模型一致。

> **状态：M2 已交付并验证。** ACP v1 会话驱动（SDK 落线）+ LLM adapter + 有状态桥已实现；bundle 已装进当前 profile，Host 插件激活成功（`fiberPhase: active`）；核心 19 个测试通过，并对真实 ACP v1 Agent（Qoder CLI 1.1.85）端到端冒烟通过。**M3（ACP Registry 设置页 + 模型下拉框的 GUI 验证）仍是骨架，未做。**

## 结论

DSH 已有一条干净的 LLM adapter 抽象（`@deepseek-ai/dsh-llm`），模型下拉框、对话、轨迹、统计全部由它驱动。因此 **ACP Agent = 一个新的 LLM adapter**，不是改 agent-loop 或 session。官方 `@agentclientprotocol/sdk@1.4.0` 已随 DSH 打包（v1 稳定 + v2 实验）。完整设计见 [`docs/design.md`](docs/design.md)。

## 与需求逐条对应

| # | 需求 | 落地 | 状态 |
|---|---|---|---|
| 1 | ACP Registry 设置页（侧栏入口）+ 自定义 Agent | `lib/client.js`（`settings.section` slot）+ `src/registry.mjs` + config 持久化 | 骨架（M3） |
| 2 | 模型下拉框选 Agent 及模型 | adapter `registerAdapter` + `listModels`（provider = `acp:<id>`） | 已实现（M2），GUI 未验证 |
| 3 | 对话/轨迹/统计同模型 | 全走 `ctx.llm.stream`，免费继承 | 已实现（M2），GUI 未验证 |
| 4 | V1 先、V2 可扩展 | `protocolVersion` 字段 + `v1-session` / `v2-session` 分离 | V1 设计态、V2 扩展点 |
| 5 | my-repos 下新建 `dsh-acp-client` | 本仓库 | ✅ |

## 目录

| 路径 | 作用 | 状态 |
|---|---|---|
| `docs/design.md` | 完整设计：adapter 契约、ACP↔stream 映射、Registry、V1/V2、里程碑 | ✅ |
| `src/v1-mapping.mjs` | ACP v1 `session/update` → DSH stream chunk 映射（纯函数） | ✅ 已测 |
| `src/launch.mjs` | registry 分布（npx/uvx/binary/command）→ spawn 命令 | ✅ 已测 |
| `src/registry.mjs` | registry.json 拉取 + manifest 校验/规范化 | ✅ 已测 |
| `src/adapter.mjs` | `AcpAdapter extends LlmAdapter`（listModels/resolveModel/stream + 有状态桥） | ✅ 已测（M2） |
| `src/v1-session.mjs` | ACP v1 会话驱动（SDK client/connect/buildSession） | ✅ 已测（M2） |
| `lib/index.js` | Host 插件入口：注册 adapter + Config schema + `inject:['llm']` | ✅ 已装已激活（M2） |
| `lib/client.js` | 浏览器半：ACP Registry 设置页（`settings.section`） | 骨架（M3） |
| `test/*.test.mjs` | 单测 + 端到端（example agent / 取消 / 会话复用） | ✅ 19/19 |

## 验证

```bash
node --test          # 19/19 通过（mapping / launch / registry / v1-session 端到端 / 取消 / adapter 会话复用）
```

- **真实 Agent 冒烟**：`src/v1-session.mjs` 驱动 Qoder CLI 1.1.85（`~/.local/bin/qodercli --acp`）→ `initialize` + `session/new` + `session/prompt` 成功，`stopReason=end_turn`。
- **bundle 安装**：`plugin_manager install_bundle /Users/run/my-repos/dsh-acp-client` → `application: applied`，`list_plugins` 显示 `include:acp-client` `enabled:true` `fiberPhase:active`，Config schema 正常投影。
- **未验证（如实说明）**：模型下拉框里出现 `acp:<agent>` 并完成一次 GUI 对话 —— 这需要先通过 M3 的 Registry 设置页写入一个 agent 配置；当前 config 默认为 `agents: []`，adapter 未注册任何 provider。此外已装 bundle 是链接式安装，`inject: ['llm']` 修复会在下一次 DSH 重启/插件重激活后生效。

## 关键设计决策（详见 design.md）

- **接入点**：LLM adapter（`ctx.llm.registerAdapter`），provider 命名 `acp:<id>`。
- **有状态桥**：DSH 的 `stream(messages)` 是无状态单次调用，而 ACP Agent 是整回合有状态；adapter 用 `options.sessionId → ACP 会话` 的 Map 桥接，只把「本轮新增用户文本」发成 `session/prompt`。
- **语义映射**：`agent_message_chunk→text-delta`、`agent_thought_chunk→reasoning-delta`、`tool_call→reasoning`（v1 降级）、`usage_update→usage`、`stopReason→finish`。
- **模型选择**：`listModels` 首次起一个短命 probe 会话读取 ACP `session/new.models.availableModels`（或 configOptions 的 model select）并缓存；模型显示名带上 Agent 前缀（`Qoder:DeepSeek-V4-Flash`）；`stream` 按 DSH 选中的 model id 调 `session/set_config_option` 切换外部 Agent 模型。已验证 Qoder CLI 返回 15 个模型。
- **思考等级**：把 ACP configOption `category=thought_level`（如 `reasoning_effort`）映射成 DSH 的 `reasoning.efforts`，模型下拉框出现思考等级；`stream` 按选中的 effort 调 `session/set_config_option` 切换。已验证 Qoder 的 `high/max/low/none`。
- **权限等级**：注册 agent 作用域的 `/acp-mode [mode]` 命令，列出/切换 ACP configOption `category=mode`（Qoder 的 `default/acceptEdits/auto/dontAsk/yolo`）。
- **斜杠命令**：`stream` 捕获 ACP `available_commands_update`，把外部 Agent 的命令注册成**该 DSH agent 作用域**的 `commands`（`agent.ctx.commands.register`，只对该 agent 的输入框可见）；执行时把 `/name args` 作为下一条用户消息投给 agent（`agent.followup`），由 agent-loop 转成 `session/prompt` 交给外部 Agent。已验证 Qoder CLI 广告 `/goal` 等命令。
- **V1/V2**：`protocolVersion` 字段切换 `v1-session` / `v2-session`，上层（registry 页/下拉/轨迹/统计）不动。
- **数据源澄清**：用户给的 `agent.schema.json` 是校验 manifest 的 JSON Schema；真正的列表是聚合的 `registry.json`（CDN `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`）。

## 里程碑

1. **M2 ✅**：`src/v1-session.mjs` SDK 落线 `client()/connect/buildSession`，接进 `lib/index.js`；bundle 已装、Host 插件 `fiberPhase: active`；Qoder CLI 端到端冒烟通过。
2. **M3 ✅**：`lib/client.js` 真正的 ACP Registry 设置页（Registry / 已安装 / 自定义 + 搜索 + 安装/卸载），Host 侧 `ctx.connection.fetch` 路由持久化到 `configEditor`。
3. **模型选择 ✅**：外部 Agent 的模型进入模型下拉框，选中后通过 `session/set_config_option` 切换。
4. **M4（待做）**：`src/v2-session.mjs` 用 `@agentclientprotocol/sdk/experimental/v2`，按 `protocolVersion` 切换。

先例可复用：`my-repos/acp-v2v1-shim`（v2↔v1 逐方法映射，已验证 Qoder v1 / Delta v2 真实流量）；DSH 自带的 `dsh-acp` 服务器是反方向的 update↔语义映射参考。
