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
    /** @type {Map<string, {key:string, disposers:Array<() => void>}>} DSH agent → 已注册的 ACP 斜杠命令 */
    this._commandState = new Map()
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
    const dshAgent = this.ctx?.get('agents')?.get(options?.sessionId)
    try {
      for await (const update of session.prompt(userText)) {
        if (signal?.aborted) break
        if (update?.sessionUpdate === 'available_commands_update') {
          this.registerCommands(dshAgent, update.availableCommands ?? [])
        }
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

  /**
   * 把 ACP Agent 声明的斜杠命令注册为**该 DSH agent 作用域**的命令
   * （agent.ctx.commands.register → scopeOf(agent.ctx) 生效，只对该 agent 可见）。
   * 命令列表变化时先注销旧的再重注册。
   * @param {object|undefined} dshAgent 接收命令的 DSH Agent
   * @param {Array<object>} commands ACP availableCommands
   */
  registerCommands(dshAgent, commands) {
    const scope = dshAgent?.ctx
    if (scope?.commands === undefined) return
    const key = JSON.stringify(commands)
    const previous = this._commandState.get(scope)
    if (previous?.key === key) return
    if (previous !== undefined) for (const dispose of previous.disposers) dispose()

    const disposers = []
    for (const command of commands) {
      const name = command?.name
      if (typeof name !== 'string' || name.length === 0) continue
      try {
        disposers.push(scope.commands.register({
          name,
          description: command.description ?? `Run /${name} on ${this.agent.name}`,
          ...(command.input?.hint ? { input: { hint: command.input.hint } } : {}),
          handler: ({ agent, rawInput }) => this.runAgentCommand(agent, name, rawInput),
        }))
      } catch {
        // 名称非法或与已有命令冲突时跳过该条，不阻断其余命令。
      }
    }
    this._commandState.set(scope, { key, disposers })
  }

  /**
   * 执行一条 ACP 斜杠命令：把 `/name rawInput` 作为下一条用户消息投给 agent，
   * 由 agent-loop 转成 session/prompt 交给外部 Agent 执行。
   */
  runAgentCommand(agent, name, rawInput) {
    if (agent === undefined) return { kind: 'error', text: `/${name}: no receiving agent` }
    const line = `/${name}${rawInput ? ` ${rawInput}` : ''}`
    try {
      agent.followup({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
      return { kind: 'success', text: `已发送 /${name} 给 ${this.agent.name}` }
    } catch (error) {
      return { kind: 'error', text: `/${name}: ${error?.message ?? String(error)}` }
    }
  }

  /** 关闭并清理本 adapter 持有的所有 ACP 会话与进程。 */
  async dispose() {
    for (const state of this._commandState.values()) for (const dispose of state.disposers) dispose()
    this._commandState.clear()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this._models = undefined
    await Promise.allSettled(sessions.map((session) => session.close()))
  }
}
