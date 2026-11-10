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
import { LlmAdapter, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
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
 * 把 ACP 命令名规范成 DSH 合法命令名（`^[a-z][a-z0-9_-]*$`）。
 * 例如 `opsx:apply` → `opsx-apply`、`Presentations:pptx` → `presentations-pptx`。
 * 执行时仍用原始名发给外部 Agent。
 */
export function sanitizeCommandName(raw) {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const name = /^[a-z]/.test(cleaned) ? cleaned : `cmd-${cleaned || 'tool'}`
  return name.length > 64 ? name.slice(0, 64).replace(/-+$/g, '') : name
}

/** 最后一条 user 消息的下标（无则 -1）。 */
export function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') return i
  return -1
}

/** 把历史里的 user/assistant 文本渲染成上下文块。 */
export function renderHistory(messages) {
  const lines = []
  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length === 0) continue
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
  }
  return lines.join('\n\n')
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
    /** @type {{configId:string, efforts:Array<object>, current?:string}|undefined} 缓存的思考等级 */
    this._reasoning = undefined
    /** @type {Map<object, () => void>} DSH agent 作用域 → /acp-mode 命令 disposer */
    this._modeCommands = new Map()
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
        // 模型名带上外部 Agent 名（如 Qoder:DeepSeek-V4-Flash）；同时缓存思考等级。
        const reasoning = probe.reasoning
        this._reasoning = reasoning
        return models.map((model) => ({
          provider: this.provider,
          id: model.id,
          name: `${this.agent.name}:${model.name}`,
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
    const reasoning = this._reasoning
    return {
      provider: this.provider,
      id: model,
      name: entry?.name ?? (model === 'primary' ? this.agent.name : model),
      ...(entry?.description ? { description: entry.description } : {}),
      ...(reasoning !== undefined && model !== 'primary'
        ? {
            reasoning: {
              efforts: reasoning.efforts,
              ...(reasoning.current ? { defaultEffort: reasoning.current } : {}),
            },
          }
        : {}),
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
   * 构造本轮发给外部 Agent 的 prompt。
   * 新会话（fresh=true）额外带上 DSH 会话此前的 user/assistant 文本作上下文，
   * 使切换模型或 DSH 重启后外部 Agent 仍知道之前聊过什么；既有会话只发新消息。
   */
  async buildPrompt(options, fresh, signal) {
    const messages = options?.messages ?? []
    const content = await this.extractLastUserContent(messages, signal)
    if (!fresh) return content
    const index = lastUserIndex(messages)
    if (index < 0) return content
    const history = renderHistory(messages.slice(0, index))
    if (history.length === 0) return content
    return [
      { type: 'text', text: `以下是本次对话此前的上下文，请据此理解接下来的消息：\n\n${history}\n\n---\n\n` },
      ...content,
    ]
  }

  /**
   * 把一条 ACP 工具活动补成 DSH 会话事件，使其在轨迹里显示为原生工具卡片：
   *  - 首次 → 先追加声明该调用的 `assistant/message`，再追加 `tool/call`
   *  - completed/failed → 追加 `tool/result`（surface 事件，带 surfaceOp: 'append'）
   * @param {{provider?: string, model?: string}} [source] 声明消息的来源（provider/model）
   * @returns {Promise<boolean>} 是否已按事件处理（false 时调用方回退到思考轨迹文本）
   */
  async appendToolEvent(dshAgent, update, source) {
    const session = dshAgent?.session
    if (session?.append === undefined) return false
    const callId = update?.toolCallId ?? update?.id
    if (typeof callId !== 'string' || callId.length === 0) return false
    // tool/call 与 tool/result 的 data.turn/step 必须精确等于当前 open 的 turn/step，
    // 否则会话日志在重放时被判为 corrupt。拿不到精确位置就回退思考轨迹文本，绝不瞎写。
    const position = this.toolPosition(session)
    if (position === undefined) return false
    const { turn, step } = position
    // tool/call 必须与某条 assistant/message 里声明的 tool-call block 完全一致
    // （id/name/arguments）。两者用同一组字符串构造，保证重放校验能配上。
    const name = update.title ?? update.kind ?? 'tool'
    const args = safeJson(update.rawInput ?? {})
    try {
      let record = this._toolCalls.get(callId)
      if (record === undefined) {
        session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content: [{ type: 'tool-call', id: callId, name, arguments: args }],
            source: { provider: source?.provider ?? this.provider, model: source?.model ?? 'primary' },
          }),
        }, { surfaceOp: 'append' })
        const event = session.append('tool/call', { turn, step, callId, name, arguments: args })
        record = { seq: event.seq, turn, step }
        this._toolCalls.set(callId, record)
      }
      if (update.status === 'completed' || update.status === 'failed') {
        session.append('tool/result', {
          turn: record.turn ?? turn,
          step: record.step ?? step,
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

  /**
   * 回合结束时收尾仍无结果的工具调用：声明过却没配对的 tool/call 会让
   * step/end 因 unresolved tool call 判为 corrupt，这里补一条失败的 tool/result。
   */
  resolvePendingTools(dshAgent) {
    const session = dshAgent?.session
    if (session?.append === undefined) return
    for (const [callId, record] of [...this._toolCalls]) {
      try {
        session.append('tool/result', {
          turn: record.turn,
          step: record.step,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: 'ACP agent did not report a result before the turn ended.' }],
            isError: true,
          }),
        }, { surfaceOp: 'append', sourceEventSeqs: [record.seq] })
      } catch {
        // 会话已不可追加时放弃；不阻断回合收尾。
      }
      this._toolCalls.delete(callId)
    }
  }

  /**
   * 读取当前 open 的 turn/step。step 号从 `turnBoundary` 的 lastStepStartSeq 指向的
   * step/start 事件里取；无法确定时返回 undefined（调用方回退文本）。
   */
  toolPosition(session) {
    try {
      const boundary = this.ctx?.get('agents')?.turnBoundaryOf?.(session)
      if (boundary === undefined) return undefined
      const turn = typeof boundary.lastTurn === 'number' ? boundary.lastTurn : undefined
      if (turn === undefined) return undefined
      const stepSeq = boundary.lastStepStartSeq
      if (stepSeq === null || stepSeq === undefined || typeof session.eventAt !== 'function') return undefined
      const startEvent = session.eventAt(stepSeq)
      const step = startEvent?.data?.step
      return typeof step === 'number' ? { turn, step } : undefined
    } catch {
      return undefined
    }
  }

  /** 把一次 DSH 模型调用映射为一次 ACP 回合（v1）。 */
  async *stream(options) {
    const signal = options?.signal
    const sessionId = String(options?.sessionId ?? 'default')
    const dshAgent = this.ctx?.get('agents')?.get(options?.sessionId)

    let session = this.sessions.get(sessionId)
    const fresh = session === undefined
    if (fresh) {
      try {
        session = await V1Session.open(this.agent, { cwd: this.resolveCwd(options) })
        this.sessions.set(sessionId, session)
        this.registerModeCommand(dshAgent)
      } catch (error) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: error?.message ?? String(error) } } }
        return
      }
    }

    // 新 ACP 会话没有历史：把 DSH 会话此前的 user/assistant 文本作为上下文一起发送，
    // 这样切换模型 / DSH 重启后外部 Agent 仍知道之前聊过什么；既有会话只发新消息。
    const userContent = await this.buildPrompt(options, fresh, signal)

    // 按 DSH 选中的模型切换外部 Agent 的模型（best-effort，失败不阻断回合）。
    if (options?.model && options.model !== 'primary') {
      await session.setModel(options.model)
    }
    // 按 DSH 选中的思考等级切换外部 Agent 的 reasoning effort。
    if (options?.reasoningEffort !== undefined) {
      await session.setReasoningEffort(options.reasoningEffort)
    }

    const onAbort = () => session.cancel()
    signal?.addEventListener('abort', onAbort)

    const state = createMapperState()
    try {
      for await (const update of session.prompt(userContent)) {
        if (signal?.aborted) break
        if (update?.sessionUpdate === 'available_commands_update') {
          this.registerCommands(dshAgent, update.availableCommands ?? [])
        }
        // 工具活动优先补成会话事件（原生工具卡片）；失败则退回思考轨迹文本。
        const isTool = update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update'
        if (isTool && (await this.appendToolEvent(dshAgent, update, { provider: options?.provider, model: options?.model }))) continue
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
      this.resolvePendingTools(dshAgent)
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
      const rawName = command?.name
      if (typeof rawName !== 'string' || rawName.length === 0) continue
      // DSH 命令名只允许 ^[a-z][a-z0-9_-]*$；ACP 名字可能含 `:` / 大写（如 opsx:apply），
      // 用 DSH 合法名注册，执行时仍发回原始名字。
      const name = sanitizeCommandName(rawName)
      // 名字被改写时，把原始名放进描述，菜单里仍能看到 `opsx:apply`。
      const description = rawName === name
        ? (command.description ?? `Run /${rawName} on ${this.agent.name}`)
        : `${rawName}${command.description ? ` · ${command.description}` : ''}`
      try {
        disposers.push(commandService.register({
          name,
          description,
          ...(command.input?.hint ? { input: { hint: command.input.hint } } : {}),
          handler: ({ agent, rawInput }) => this.runAgentCommand(agent, rawName, rawInput),
        }))
      } catch {
        // 名称非法或与已有命令冲突时跳过该条，不阻断其余命令。
      }
    }
    this._commandState.set(scope, { key, disposers })
  }

  /**
   * 执行一条 ACP 斜杠命令：把 `/原始名 rawInput` 作为下一条用户消息投给 agent，
   * 由 agent-loop 转成 session/prompt 交给外部 Agent 执行。
   */
  runAgentCommand(agent, originalName, rawInput) {
    if (agent === undefined) return { kind: 'error', text: `/${originalName}: no receiving agent` }
    const line = `/${originalName}${rawInput ? ` ${rawInput}` : ''}`
    try {
      agent.followup({ content: [{ type: 'text', text: line }], source: { kind: 'user' } })
      return { kind: 'success', text: `已发送 /${originalName} 给 ${this.agent.name}` }
    } catch (error) {
      return { kind: 'error', text: `/${originalName}: ${error?.message ?? String(error)}` }
    }
  }

  /** 为接收命令的 DSH agent 注册 `/acp-mode`（切换外部 Agent 的权限等级）。 */
  registerModeCommand(dshAgent) {
    const scope = dshAgent?.ctx
    if (scope === undefined) return
    if (this._modeCommands.has(scope)) return
    const commandService = typeof scope.get === 'function' ? scope.get('commands') : scope.commands
    if (commandService === undefined) return
    try {
      const dispose = commandService.register({
        name: 'acp-mode',
        description: `切换 ${this.agent.name} 的权限等级（当前 ${
          this.sessions.get(String(dshAgent?.session?.id ?? ''))?.currentModeId ?? 'unknown'
        }）`,
        input: { hint: '<mode>' },
        handler: ({ agent, rawInput }) => this.runAgentModeCommand(agent, rawInput),
      })
      this._modeCommands.set(scope, dispose)
    } catch {
      // 与已有命令冲突时跳过；不阻断其余命令。
    }
  }

  /** 执行 `/acp-mode [mode]`：列出或切换外部 Agent 的权限等级。 */
  async runAgentModeCommand(agent, rawInput) {
    const acp = this.sessions.get(String(agent?.session?.id ?? ''))
    if (acp === undefined) return { kind: 'error', text: '请先在模型下拉框选择 ACP Agent' }
    const modes = acp.modes
    if (modes.length === 0) return { kind: 'error', text: `${this.agent.name} 未暴露权限等级` }
    const mode = rawInput.trim()
    const available = modes.map((entry) => entry.id).join(', ')
    if (mode === '') {
      return { kind: 'success', text: `当前权限等级 ${acp.currentModeId}（可选：${available}）` }
    }
    if (!modes.some((entry) => entry.id === mode)) {
      return { kind: 'error', text: `未知权限等级 "${mode}"（可选：${available}）` }
    }
    await acp.setMode(mode)
    return { kind: 'success', text: `权限等级已切到 ${mode}` }
  }

  /** 关闭并清理本 adapter 持有的所有 ACP 会话与进程。 */
  async dispose() {
    for (const state of this._commandState.values()) for (const dispose of state.disposers) dispose()
    this._commandState.clear()
    for (const dispose of this._modeCommands.values()) dispose()
    this._modeCommands.clear()
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this._models = undefined
    this._reasoning = undefined
    await Promise.allSettled(sessions.map((session) => session.close()))
  }
}
