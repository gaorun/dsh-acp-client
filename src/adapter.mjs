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
import { LlmAdapter, createToolResultMessage } from '@deepseek-ai/dsh-llm'
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

/** 安全地把任意值渲染成 JSON 字符串（截断）。 */
function safeJson(value) {
  try {
    const text = JSON.stringify(value ?? {})
    return typeof text === 'string' ? text : '{}'
  } catch {
    return '{}'
  }
}

/** 把 ACP tool_call_update 的内容转成 DSH tool-result 的 ContentBlock[]。 */
function toolResultContent(update) {
  const blocks = []
  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item?.type === 'content' && item.content?.type === 'text') {
        blocks.push({ type: 'text', text: item.content.text })
      } else if (item?.type === 'diff') {
        blocks.push({ type: 'text', text: `diff ${item.path ?? ''}${typeof item.newText === 'string' ? `\n${item.newText}` : ''}` })
      } else if (item?.type === 'terminal') {
        blocks.push({ type: 'text', text: `terminal: ${item.terminalId ?? ''}` })
      }
    }
  }
  if (blocks.length === 0 && update.rawOutput !== undefined) blocks.push({ type: 'text', text: safeJson(update.rawOutput) })
  if (blocks.length === 0) blocks.push({ type: 'text', text: `${update.title ?? 'tool'} ${update.status ?? ''}`.trim() })
  return blocks
}

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
    /** @type {Map<string, {seq:number}>} ACP toolCallId → 已追加的 tool/call 事件 */
    this._toolCalls = new Map()
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

  /**
   * 从 messages 末尾取最近一条 user 消息，转成 ACP 内容块：
   * 文本原样；图片读附件字节后转 base64（ACP ImageContent）。
   * @returns {Promise<Array<object>>} ACP prompt content blocks
   */
  async extractLastUserContent(messages, signal) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.role !== 'user') continue
      const blocks = []
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          blocks.push({ type: 'text', text: block.text })
          continue
        }
        if (block?.type === 'image' && block.offloaded !== true && block.attachment) {
          const image = await this.toAcpImage(block.attachment, signal)
          blocks.push(image ?? { type: 'text', text: '[image omitted: attachment store unavailable]' })
        }
      }
      if (blocks.length > 0) return blocks
    }
    return []
  }

  /** DSH 图片引用 → ACP ImageContent（base64）。读不到时返回 undefined。 */
  async toAcpImage(ref, signal) {
    const attachments = this.ctx?.get('attachments')
    if (attachments === undefined) return undefined
    try {
      const { data } = await attachments.readImage(ref, signal)
      return { type: 'image', data: Buffer.from(data).toString('base64'), mimeType: ref.mediaType }
    } catch {
      return undefined
    }
  }

  /**
   * 把一条 ACP 工具活动补成 DSH 会话事件，使其在轨迹里显示为原生工具卡片：
   *  - 首次 → 追加 `tool/call`（log-only 事件）
   *  - completed/failed → 追加 `tool/result`（surface 事件，带 surfaceOp: 'append'）
   * @returns {Promise<boolean>} 是否已按事件处理（false 时调用方回退到思考轨迹文本）
   */
  async appendToolEvent(dshAgent, update) {
    const session = dshAgent?.session
    if (session?.append === undefined) return false
    const callId = update?.toolCallId ?? update?.id
    if (typeof callId !== 'string' || callId.length === 0) return false
    try {
      const turn = this.currentTurn(session)
      let record = this._toolCalls.get(callId)
      if (record === undefined) {
        const event = session.append('tool/call', {
          turn,
          step: 0,
          callId,
          name: update.title ?? update.kind ?? 'tool',
          arguments: safeJson(update.rawInput ?? {}),
        })
        record = { seq: event.seq }
        this._toolCalls.set(callId, record)
      }
      if (update.status === 'completed' || update.status === 'failed') {
        session.append('tool/result', {
          turn,
          step: 0,
          message: createToolResultMessage({
            callId,
            content: toolResultContent(update),
            isError: update.status === 'failed',
          }),
        }, { surfaceOp: 'append', sourceEventSeqs: [record.seq] })
        this._toolCalls.delete(callId)
      }
      return true
    } catch {
      // 会话不是可追加状态 / 事件形状被拒：若已补上 tool/call 就避免与思考轨迹重复，
      // 否则回退到思考轨迹文本，不阻断回合。
      return this._toolCalls.has(callId)
    }
  }

  /** 当前 turn（tool 事件的归属由事件 seq 决定，turn/step 仅作记录）。 */
  currentTurn(session) {
    try {
      const boundary = this.ctx?.get('agents')?.turnBoundaryOf?.(session)
      return typeof boundary?.lastTurn === 'number' ? boundary.lastTurn : 0
    } catch {
      return 0
    }
  }

  /** 把一次 DSH 模型调用映射为一次 ACP 回合（v1）。 */
  async *stream(options) {
    const signal = options?.signal
    const sessionId = String(options?.sessionId ?? 'default')
    const userContent = await this.extractLastUserContent(options?.messages ?? [], signal)

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
      for await (const update of session.prompt(userContent)) {
        if (signal?.aborted) break
        if (update?.sessionUpdate === 'available_commands_update') {
          this.registerCommands(dshAgent, update.availableCommands ?? [])
        }
        // 工具活动优先补成会话事件（原生工具卡片）；失败则退回思考轨迹文本。
        const isTool = update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update'
        if (isTool && (await this.appendToolEvent(dshAgent, update))) continue
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
    if (scope === undefined) return
    // ctx.get() 免 inject 读取服务，且返回的 traceable 实例会把 this.ctx 绑到 scope，
    // 因此 register 落在该 agent 的作用域层。
    const commandService = typeof scope.get === 'function' ? scope.get('commands') : scope.commands
    if (commandService === undefined) return
    const key = JSON.stringify(commands)
    const previous = this._commandState.get(scope)
    if (previous?.key === key) return
    if (previous !== undefined) for (const dispose of previous.disposers) dispose()

    const disposers = []
    for (const command of commands) {
      const name = command?.name
      if (typeof name !== 'string' || name.length === 0) continue
      try {
        disposers.push(commandService.register({
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
