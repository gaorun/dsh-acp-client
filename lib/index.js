/**
 * dsh-acp-client Host 插件入口（M2）。
 *
 * 职责：按 config.agents 把每个已安装 ACP Agent 注册成一条 LLM provider 路由，
 * 使其模型自动出现在模型下拉框；对话/轨迹/统计由 agent-loop 免费继承。
 * 持久化通过 configEditor 完成（见 cordis-plugin-development「Persist your own configuration」）。
 */
import z from '@deepseek-ai/schemastery'
import { AcpAdapter, providerIdFor } from '../src/adapter.mjs'

/** 单个已安装 agent 定义；distribution 形状见 src/launch.mjs / src/registry.mjs。 */
const AgentDefinition = z.object({
  id: z.string(),
  name: z.string(),
  protocolVersion: z.union([z.const('v1'), z.const('v2')]).default('v1'),
  distribution: z.dict(z.any()),
})

export const Config = z.object({
  protocolVersion: z.union([z.const('v1'), z.const('v2')]).default('v1'),
  agents: z.array(AgentDefinition).default([]),
})

/** 注入 llm 服务，使 ctx.llm.registerAdapter 可用（见 dsh-llm-deepseek 的 inject 用法）。 */
export const inject = ['llm']

export function apply(ctx, config) {
  const agents = (config.agents ?? []).filter(
    (agent) => agent?.protocolVersion !== 'v2', // v2 尚未实现，见 docs/design.md §4
  )
  if (agents.length === 0) return

  // 每个 agent 一个 adapter、一条 provider 路由；settings 页增删 agent 后重跑 apply
  // 即触发 replace，模型下拉框随之刷新。
  const adapters = agents.map((agent) => new AcpAdapter(agent, ctx))
  const disposers = adapters.map((adapter) =>
    ctx.llm.registerAdapter([providerIdFor(adapter.agent.id)], adapter),
  )

  return () => {
    for (const dispose of disposers) dispose()
    for (const adapter of adapters) {
      adapter.dispose().catch(() => {})
    }
  }
}
