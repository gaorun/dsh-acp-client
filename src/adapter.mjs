/**
 * Host 半：ACP LLM adapter。
 *
 * 契约见 docs/design.md §1.1 与 @deepseek-ai/dsh-llm 的 LlmAdapter。
 * 一个已安装 ACP Agent = 一条 provider 路由；stream 走 ACP v1 会话驱动（有状态桥）。
 *
 * 模型列表来自 ACP `session/new` 的 `models.availableModels`（或 configOptions 的 model
 * select）：`listModels` 首次调用会起一个短命 probe 会话读取并缓存；`stream` 按 DSH 选中的
 * model id 调 `session/set_config_option` 切换外部 Agent 的模型。
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createMapperState, mapUpdate, stopReasonToFinish } from './v1-mapping.mjs'
import { V1Session } from './v1-session.mjs'

/** 一个已安装 ACP Agent 对应一个 provider 路由。 */
export function providerIdFor(agentId) {
  return `acp:${agentId}`
}

/** 从 messages 末尾取最近一条 user 消息的文本（v1 只回放本轮新增用户文本）。 */
export function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.length > 0) return text
  }
  return ''
}

/** 探测模型列表的超时（毫秒），避免 listModels 卡死 GUI。 */
const PROBE_TIMEOUT_MS = 15000

/**
 * 把一个已安装 agent 定义挂成一条 provider 路由的 adapter。
 * @param {object} agent 已安装 agent 定义（含 id/name/protocolVersion/distribution）
 * @param {object} ctx   Host context（用于 cwd 解析与生命周期）
 */
export class AcpAdapter extends LlmAdapter {
  constructor(agent, ctx) {
    super()
    this.agent = agent
    this.ctx = ctx
    this.provider = providerIdFor(agent.id)
    /** @type {Map<string, V1Session>} sessionId → 已建 ACP 会话 */
    this.sessions = new Map()
    /** @type {Array<object>|undefined} 缓存的模型目录 */
    this._models = undefined
    /** @type {Promise<Array<object>>|undefined} 进行中的探测 */
    this._probe = undefined
  }

  providerInfo() {
    return { id: this.provider, name: this.agent.name }
  }

  /**
   * 模型列表：首次探测外部 Agent 的 session/new.models 并缓存；
   * 探测失败则回退单一 `primary`，保证下拉框始终有可选项。
   */
  async listModels() {
    if (this._models !== undefined) return this._models
    if (this._probe === undefined) this._probe = this.probeModels()
    try {
      this._models = await this._probe
      return this._models
    } finally {
      this._probe = undefined
    }
  }

  /** 起一个短命 ACP 会话读取模型列表，读完即关。 */
  async probeModels() {
    let probe
    try {
      probe = await Promise.race([
        V1Session.open(this.agent, { cwd: this.resolveCwd({}) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('model probe timed out')), PROBE_TIMEOUT_MS)),
      ])
      const models = probe.models
      if (models.length > 0) {
        return models.map((model) => ({
          provider: this.provider,
          id: model.id,
          name: model.name,
          ...(model.description ? { description: model.description } : {}),
        }))
      }
    } catch {
      // 探测失败（未登录 / 不支持 / 超时）：回退。
    } finally {
      if (probe !== undefined) await probe.close().catch(() => {})
    }
    return [{ provider: this.provider, id: 'primary', name: this.agent.name }]
  }

  async resolveModel(_provider, model) {
    const entry = this._models?.find((item) => item.id === model)
    return {
      provider: this.provider,
      id: model,
      name: entry?.name ?? (model === 'primary' ? this.agent.name : model),
      ...(entry?.description ? { description: entry.description } : {}),
    }
  }

  /** 解析当前 DSH session 的工作目录，供 ACP session/new 的 cwd。 */
  resolveCwd(options) {
    const workingDirectory = this.ctx?.get('workingDirectory')
    const sessionId = options?.sessionId
    if (sessionId !== undefined && workingDirectory !== undefined) {
      try {
        const agent = this.ctx.get('agents')?.get(sessionId)
        const session = agent?.session
        if (session !== undefined) return workingDirectory.get(session)
      } catch {
        // 会话不可解析时回退到默认目录。
      }
    }
    return workingDirectory?.defaultDirectory ?? process.cwd()
  }

  /** 把一次 DSH 模型调用映射为一次 ACP 回合（v1）。 */
  async *stream(options) {
    const signal = options?.signal
    const sessionId = String(options?.sessionId ?? 'default')
    const userText = extractLastUserText(options?.messages ?? [])

    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      try {
        session = await V1Session.open(this.agent, { cwd: this.resolveCwd(options) })
        this.sessions.set(sessionId, session)
      } catch (error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: error?.message ?? String(error) } } }
        return
      }
    }

    // 按 DSH 选中的模型切换外部 Agent 的模型（best-effort，失败不阻断回合）。
    if (options?.model && options.model !== 'primary') {
      await session.setModel(options.model)
    }

    const onAbort = () => session.cancel()
    signal?.addEventListener('abort', onAbort)

    const state = createMapperState()
    try {
      for await (const update of session.prompt(userText)) {
        if (signal?.aborted) break
        for (const chunk of mapUpdate(update, state)) yield chunk
      }
      if (signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }
      } else {
        yield stopReasonToFinish(session.stopReason)
      }
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: error?.message ?? String(error) } } }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 关闭并清理本 adapter 持有的所有 ACP 会话与进程。 */
  async dispose() {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this._models = undefined
    await Promise.allSettled(sessions.map((session) => session.close()))
  }
}
