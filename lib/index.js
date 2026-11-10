/**
 * dsh-acp-client Host 插件入口（M3）。
 *
 * 职责：
 *  1. 按 config.agents 把每个已安装 ACP Agent 注册成一条 LLM provider 路由，
 *     使其模型出现在模型下拉框；对话/轨迹/统计由 agent-loop 免费继承。
 *  2. 通过 `ctx.connection.fetch` 暴露 ACP Registry 设置页需要的数据/安装接口：
 *     GET  /api/acp.registry  —— 拉取并缓存 agentclientprotocol registry.json
 *     GET  /api/acp.agents    —— 当前已安装 agent 定义
 *     POST /api/acp.install   —— 安装/更新一个 agent（写回 configEditor）
 *     POST /api/acp.remove    —— 卸载一个 agent
 *
 * 安装 = 用 configEditor 持久化到本插件 Config；编辑普通字段会重启插件，
 * apply 重新注册 adapter，模型下拉框随之刷新。
 */
import z from '@deepseek-ai/schemastery'
import { AcpAdapter, providerIdFor } from '../src/adapter.mjs'
import { fetchRegistry, normalizeAgentDefinition } from '../src/registry.mjs'

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

/** 注入 llm（adapter 注册）、connection（设置页 fetch 路由）、commands（斜杠命令发现）。 */
export const inject = ['llm', 'connection', 'commands']

const REGISTRY_PATH = '/api/acp.registry'
const AGENTS_PATH = '/api/acp.agents'
const INSTALL_PATH = '/api/acp.install'
const REMOVE_PATH = '/api/acp.remove'
const NO_STORE = { 'cache-control': 'no-store' }
const REGISTRY_TTL_MS = 5 * 60 * 1000

export function apply(ctx, config) {
  // 1) provider 路由：每个已安装 agent 一条。
  const agents = (config.agents ?? []).filter((agent) => agent?.protocolVersion !== 'v2')
  const adapters = agents.map((agent) => new AcpAdapter(agent, ctx))
  const disposers = adapters.map((adapter) =>
    ctx.llm.registerAdapter([providerIdFor(adapter.agent.id)], adapter),
  )

  // 2) 设置页数据/安装接口（始终注册，即使还没有 agent）。
  registerRoutes(ctx, config)

  return () => {
    for (const dispose of disposers) dispose()
    for (const adapter of adapters) adapter.dispose().catch(() => {})
  }
}

/** 注册 ACP Registry 设置页所用的 fetch 路由。 */
function registerRoutes(ctx, config) {
  let registryCache = { at: 0, agents: [] }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: REGISTRY_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          if (Date.now() - registryCache.at < REGISTRY_TTL_MS) {
            return Response.json({ ok: true, agents: registryCache.agents }, { headers: NO_STORE })
          }
          const result = await fetchRegistry()
          if (!result.ok) {
            return Response.json({ ok: false, error: result.error }, { status: 502, headers: NO_STORE })
          }
          registryCache = { at: Date.now(), agents: result.agents }
          return Response.json({ ok: true, agents: result.agents }, { headers: NO_STORE })
        },
      }),
    'acp-client: registry route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: AGENTS_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Response.json({ ok: true, agents: config.agents ?? [] }, { headers: NO_STORE }),
      }),
    'acp-client: agents route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: INSTALL_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400, headers: NO_STORE })
          }
          const normalized = normalizeAgentDefinition(body?.agent ?? body, config.protocolVersion ?? 'v1')
          if (!normalized.ok) {
            return Response.json({ ok: false, errors: normalized.errors }, { status: 400, headers: NO_STORE })
          }
          const written = await editAgents(ctx, (current) => upsertAgent(current, normalized.value))
          if (!written.ok) {
            return Response.json({ ok: false, error: written.error }, { status: 500, headers: NO_STORE })
          }
          return Response.json({ ok: true, agent: normalized.value }, { headers: NO_STORE })
        },
      }),
    'acp-client: install route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: REMOVE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400, headers: NO_STORE })
          }
          const id = body?.id
          if (typeof id !== 'string' || id.length === 0) {
            return Response.json({ ok: false, error: 'id is required' }, { status: 400, headers: NO_STORE })
          }
          const written = await editAgents(ctx, (current) => ({
            ...current,
            agents: (current.agents ?? []).filter((agent) => agent?.id !== id),
          }))
          if (!written.ok) {
            return Response.json({ ok: false, error: written.error }, { status: 500, headers: NO_STORE })
          }
          return Response.json({ ok: true }, { headers: NO_STORE })
        },
      }),
    'acp-client: remove route',
  )
}

/** 在已安装列表里按 id upsert。 */
function upsertAgent(current, agent) {
  const existing = Array.isArray(current.agents) ? current.agents : []
  const present = existing.some((item) => item?.id === agent.id)
  return {
    ...current,
    agents: present ? existing.map((item) => (item?.id === agent.id ? agent : item)) : [...existing, agent],
  }
}

/** 通过 configEditor 持久化 agent 列表变更。 */
async function editAgents(ctx, change) {
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (!editor || !entry) return { ok: false, error: 'configuration editor is unavailable in this profile' }
  try {
    await editor.edit(entry, (current) => change(current))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}
