/**
 * ACP v1 `session/update` → DSH LLM stream chunk 映射（纯函数，可单测）。
 *
 * 方向：外部 ACP v1 Agent 的通知 → DSH agent-loop 消费的 `StreamChunk`。
 * 设计取舍见 docs/design.md §1.2：
 *  - agent_message_chunk(text) → text-delta（助手正文）
 *  - agent_thought_chunk       → reasoning-delta（思考轨迹）
 *  - tool_call / tool_call_update → reasoning-delta（Agent 已自行执行完的工具，
 *    v1 MVP 降级为思考轨迹文本；原始结构保留在 chunk 之外由调用方记录）
 *  - usage_update              → usage
 *  - 其余变体                    → 忽略（safe passthrough 不产生块）
 *
 * 本模块不依赖任何 SDK，只消费 ACP v1 的稳定 JSON 形状；chunk 类型名与
 * `@deepseek-ai/dsh-llm` 的 BlockAssembler 协议一致。
 */

/** 稳定 chunk 类型名（与 dsh-llm 的 StreamChunk 协议对齐）。 */
export const CHUNK = Object.freeze({
  textDelta: 'text-delta',
  reasoningDelta: 'reasoning-delta',
  usage: 'usage',
  finish: 'finish',
})

/** 一次映射的推进状态：block 索引单调递增，文本与思考各占一个 block。 */
export function createMapperState() {
  return { textIndex: 0, reasoningIndex: 1, usage: undefined }
}

/** 判断一个 update 是否属于「应产生可见内容的 agent 文本块」。 */
function isTextChunk(update) {
  return update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text'
}

function isThoughtChunk(update) {
  return update?.sessionUpdate === 'agent_thought_chunk'
}

function isToolLifecycle(update) {
  return update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update'
}

/**
 * 把一个 ACP v1 `session/update` 通知映射为 0..n 个 stream chunk。
 * @param {object} update ACP v1 session/update 的通知 params
 * @param {object} state   由 createMapperState() 建立，会被原地推进
 * @returns {Array<object>} 产生的 chunk（可能为空）
 */
export function mapUpdate(update, state) {
  const chunks = []

  if (isTextChunk(update)) {
    const text = update.content.text ?? ''
    if (text.length > 0) chunks.push({ type: CHUNK.textDelta, index: state.textIndex, text })
    return chunks
  }

  if (isThoughtChunk(update)) {
    const text = update.content?.text ?? ''
    if (text.length > 0) chunks.push({ type: CHUNK.reasoningDelta, index: state.reasoningIndex, text })
    return chunks
  }

  if (isToolLifecycle(update)) {
    const rendered = renderToolLifecycle(update)
    if (rendered) chunks.push({ type: CHUNK.reasoningDelta, index: state.reasoningIndex, text: rendered })
    return chunks
  }

  if (update?.sessionUpdate === 'usage_update') {
    const usage = normalizeUsage(update.usage)
    if (usage) {
      chunks.push({ type: CHUNK.usage, usage })
      state.usage = usage
    }
    return chunks
  }

  // 其余变体（user_message_chunk、plan、config_option_update、notice、
  // session_info_update、compaction_*、available_commands_update …）不产生流块。
  return chunks
}

/** 把 Agent 的工具活动渲染成一行可读的思考轨迹文本（v1 MVP）。 */
function renderToolLifecycle(update) {
  const id = update.toolCallId ?? update.id ?? ''
  const title = update.title ?? update.name ?? ''
  const status = update.status ?? ''
  const kind = update.kind ? ` (${update.kind})` : ''
  if (!title && !id) return ''
  const label = title || id
  return `[tool] ${label}${kind}${status ? ` — ${status}` : ''}`
}

/** 把 ACP v1 的 usage 规范化成 DSH usage 块的最小形状。 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const out = {}
  if (Number.isFinite(usage.inputTokens)) out.inputTokens = usage.inputTokens
  if (Number.isFinite(usage.outputTokens)) out.outputTokens = usage.outputTokens
  if (Number.isFinite(usage.totalTokens)) out.totalTokens = usage.totalTokens
  if (Object.keys(out).length === 0) return undefined
  return out
}

/**
 * 把 ACP 回合终止的 stopReason / 错误映射为终止 finish chunk。
 * @param {string|undefined} stopReason ACP 回合停止原因（end_turn / max_tokens / cancelled / error …）
 * @param {object|undefined} failure    可选的失败载荷（code/message）
 * @returns {object} finish chunk
 */
export function stopReasonToFinish(stopReason, failure) {
  switch (stopReason) {
    case 'max_tokens':
    case 'max_tokens_reached':
      return { type: CHUNK.finish, reason: { kind: 'max-tokens' } }
    case 'cancelled':
    case 'cancel':
      return { type: CHUNK.finish, reason: { kind: 'aborted', failure: failure ?? { code: 'ABORTED', message: 'cancelled' } } }
    case 'error':
      return { type: CHUNK.finish, reason: { kind: 'error', failure } }
    default:
      return { type: CHUNK.finish, reason: { kind: 'stop' } }
  }
}

export default { CHUNK, createMapperState, mapUpdate, stopReasonToFinish }
