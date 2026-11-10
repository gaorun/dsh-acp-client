# dsh-acp-client

把外部 ACP Agent（Qoder、Claude Code、Gemini CLI 等）当作「模型」接入 DeepSeek Harness（DSH）。

每个已安装的 Agent 注册成一条 provider 路由（`acp:<id>`），其模型出现在模型下拉框里；选中后，对话、思考轨迹、工具卡片、统计都走 DSH 原有的链路，与内置模型一致。

**当前状态**：ACP v1 全链路可用，含模型/思考等级切换、权限等级命令、Agent 斜杠命令、图片输入、原生工具卡片和 ACP Registry 设置页。ACP v2 尚未实现（见「已知限制」）。

## 它解决什么问题

DSH 的模型下拉框、对话、轨迹和统计由 `@deepseek-ai/dsh-llm` 的 LLM adapter 驱动。外部 ACP Agent 是**有状态、自带工具、整回合**的进程，与 DSH 适配的**无状态单次调用**模型不是一回事。本仓库只做两件事：

1. 实现一个 `LlmAdapter`，为每个已安装 Agent 注册 provider，并把 ACP 回合实时映射成 DSH 的 chunk 流。
2. 提供一个设置页，从 ACP Registry 发现并安装 Agent，或手填启动命令。

因此 agent-loop、session、轨迹投影和统计不需要任何改动。

## 功能

- **模型列表**：首次调用 `listModels` 时起一个短命探测会话，读取 `session/new` 的 `models.availableModels`（或 `configOptions` 里的 model select）并缓存；探测失败（未登录、超时 15 秒、不支持）时回退成单个 `primary`，保证下拉框始终有选项。
- **模型名带 Agent 前缀**：下拉框显示 `Qoder:DeepSeek-V4-Flash` 这样的名字，避免不同 Agent 的同名模型混淆。
- **模型切换**：按 DSH 选中的模型调 `session/set_config_option`，切换外部 Agent 的模型。
- **思考等级**：把 ACP config option `category=thought_level`（如 `reasoning_effort`）映射为 DSH 的 `reasoning.efforts`，下拉框出现可选等级，切换时同样走 `session/set_config_option`。
- **权限等级**：会话建立后为对应 DSH agent 注册 `/acp-mode [mode]`，不带参数时列出当前等级和可选值。
- **Agent 斜杠命令**：捕获 ACP `available_commands_update`，把外部 Agent 的命令注册到该 DSH agent 作用域（只在该 agent 的输入框可见）。ACP 命令名不符合 DSH 命名规则时（如 `opsx:apply`）会改写成合法名，菜单描述里保留原名；执行时仍把原名发回 Agent。
- **工具调用**：ACP 的 `tool_call` / `tool_call_update` 补写成 DSH 的 `assistant/message` + `tool/call` + `tool/result` 会话事件，轨迹里显示为原生工具卡片。无法确定当前 turn/step 时退回思考轨迹文本，不阻断回合；回合结束时仍无结果的调用补一条失败结果，避免会话日志被判为 corrupt。
- **图片输入**：用户消息里的图片附件读取为 base64，以 ACP `ImageContent` 发给外部 Agent；读不到附件时发文本占位说明。
- **多轮上下文**：同一个 DSH session 复用同一个 ACP 会话，只发送本轮新增用户内容。新开 ACP 会话（首次调用或 DSH 重启后）会把此前的 user/assistant 文本作为上下文一并发送，避免外部 Agent「失忆」。
- **取消**：DSH 取消时转发 `session/cancel`，映射为 `aborted` 结束原因。
- **设置页**：侧栏 Settings → ACP Registry，三个标签页——Registry（拉取、搜索、安装/卸载）、已安装、自定义（填 ID、名称、启动命令、协议版本）。安装结果通过 `configEditor` 写回插件配置。

## 安装

前置条件：DSH `0.2.2-rc.1`（`@agentclientprotocol/sdk@1.4.0` 已随 DSH 打包）。本包是纯 JS，没有构建步骤，可以直接从 GitHub 仓库安装。

**方式一：Web 侧栏**

1. 侧栏进入「插件」→「添加插件」。
2. 输入 `github:gaorun/dsh-acp-client`，安装。
3. 安装完成后选择「立即启用」，重启 DSH。

**方式二：命令行**

```bash
dsh plugin --profile desktop add github:gaorun/dsh-acp-client
```

`dsh plugin` 把参数转发给 profile 目录下的 pnpm，所以这里用的是 pnpm 的 Git 依赖写法。安装完成后还要启用这个组合包：在「插件」页打开它，或把 `"@deepseek-ai/dsh-acp-client"` 加进 `$DSH_HOME/profiles/desktop/package.json` 的 `dsh.profile.bundles`，然后重启 DSH。

固定到某个提交：

```bash
dsh plugin --profile desktop add github:gaorun/dsh-acp-client#<commit>
```

升级时用新提交重新执行上面的 `add`，再重启 DSH。

重启后侧栏 Settings 出现「ACP Registry」入口，说明插件已激活。此时插件还没有任何 Agent，模型下拉框不会多出条目，需要先安装至少一个。

也可以直接写配置，跳过设置页：

```yaml
- id: acp-client
  name: '@deepseek-ai/dsh-acp-client'
  config:
    protocolVersion: v1
    agents:
      - id: qoder
        name: Qoder CLI
        protocolVersion: v1
        distribution:
          command: ~/.local/bin/qodercli --acp
```

`distribution` 支持四种形态：`command`（直连命令行字符串）、`npx`（`package` + `args`）、`uvx`（`package` + `args`）、`binary`（按 `<os>-<arch>` 选 `cmd` + `args`）。

## 使用

1. 打开 Settings → ACP Registry，在 Registry 里安装一个 Agent，或用「自定义」填一条启动命令。
2. 配置写入后插件会重启，`apply` 重新注册 adapter，模型下拉框出现 `acp:<id>` 分组。
3. 选一个带 Agent 前缀的模型开始对话。轨迹里的思考内容、工具卡片、用量统计与内置模型表现一致。
4. 需要切换外部 Agent 的权限等级时，在该 agent 的输入框执行 `/acp-mode`；外部 Agent 广告的斜杠命令会直接出现在同一个输入框的菜单里。

## 工作原理

```
DSH agent-loop
  └─ ctx.llm.stream({ provider: "acp:qoder", sessionId, messages, ... })
       └─ AcpAdapter（src/adapter.mjs）
            ├─ listModels / resolveModel  → 短命探测会话，缓存模型与思考等级
            ├─ stream                     → 按 sessionId 复用 V1Session
            └─ V1Session（src/v1-session.mjs）
                 └─ spawn 外部 Agent（stdio NDJSON）→ initialize → session/new → session/prompt
                      └─ session/update → mapUpdate() → text-delta / reasoning-delta / usage / finish
```

关键映射（`src/v1-mapping.mjs`）：

| ACP v1 | DSH |
|---|---|
| `agent_message_chunk` | `text-delta` |
| `agent_thought_chunk` | `reasoning-delta` |
| `tool_call` / `tool_call_update` | 原生工具卡片；无法补写时降级为 `reasoning-delta` 文本 |
| `usage_update` | `usage` |
| `stopReason` | `finish`（stop / max-tokens / aborted / error） |
| 其余变体（plan、notice 等） | 忽略 |

Host 侧暴露四个接口给设置页：`GET /api/acp.registry`（拉取并缓存 registry.json，缓存 5 分钟）、`GET /api/acp.agents`、`POST /api/acp.install`、`POST /api/acp.remove`。

## 目录

| 路径 | 作用 |
|---|---|
| `src/adapter.mjs` | `LlmAdapter` 实现：模型列表、模型/思考等级切换、会话桥、工具事件、斜杠命令、`/acp-mode` |
| `src/v1-session.mjs` | ACP v1 会话驱动：spawn、initialize、session/new、prompt、cancel、close |
| `src/v1-mapping.mjs` | `session/update` → DSH stream chunk 的纯函数映射 |
| `src/launch.mjs` | `distribution` → spawn 命令解析（command / npx / uvx / binary） |
| `src/registry.mjs` | registry.json 拉取 + manifest 校验与规范化 |
| `lib/index.js` | Host 插件入口：Config schema、adapter 注册、设置页接口 |
| `lib/client.js` | 浏览器半：ACP Registry 设置页（`settings.section`） |
| `cordis.patch.yml` | bundle 补丁：插入插件行，默认 `agents: []` |
| `docs/design.md` | 完整设计：adapter 契约、状态桥、Registry、v1/v2 取舍 |
| `test/*.test.mjs` | 单元测试 + 端到端 |

## 开发与测试

```bash
node --test
```

本机执行结果：**65 个测试全部通过**，覆盖映射、启动命令解析、registry 校验、模型/思考等级/权限等级、图片、斜杠命令、工具事件、历史回放、Host 路由，以及两条端到端用例：

- 用 SDK 自带示例 Agent 跑通 `initialize → session/new → session/prompt`，并验证取消；
- 若本机存在 `~/.local/bin/qodercli`，用真实 Qoder CLI（本机 1.1.86）验证两轮对话中的上下文记忆；不存在时该用例自动跳过。

## 已知限制

- **ACP v2 未实现**：配置里可以写 `protocolVersion: v2`，但 `apply` 会跳过 v2 Agent，不会注册 provider；设置页的 v2 选项目前只是占位。后续补 `src/v2-session.mjs` 即可，上层不用动。
- **权限请求自动放行**：`session/requestPermission` 默认选择第一个 `allow_once` / `allow_always` 选项，尚未接入 DSH 的 approval 策略。
- **没有 GUI 自动化测试**：设置页与模型下拉框的浏览器端交互需要手工验证；现有测试只覆盖 Host 侧逻辑和会话驱动。
- **进程生命周期**：ACP 进程随 DSH session 存活，插件卸载时统一关闭；长时间空闲的会话没有 idle 回收。
- **Registry 依赖网络**：设置页从 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` 拉取列表，离线时设置页不可用，但不影响已安装 Agent 的使用。

## 参考

- [`docs/design.md`](docs/design.md)：接入点选择、ACP 与 LLM stream 的语义差异、里程碑与风险。
- [Agent Client Protocol](https://agentclientprotocol.com/)：协议与 Registry 规范。
