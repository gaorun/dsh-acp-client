import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AcpAdapter } from '../src/adapter.mjs'

const agentDef = { id: 'x', name: 'X', protocolVersion: 'v1', distribution: { command: 'true' } }

function fakeSetup(options = {}) {
  const { step = 1, lastStepStartSeq = 42, withEventAt = true } = options
  const appended = []
  const session = {
    append: (type, data, opts) => {
      appended.push({ type, data, opts })
      return { seq: appended.length - 1 }
    },
    ...(withEventAt ? { eventAt: () => ({ data: { turn: 3, step } }) } : {}),
  }
  const dshAgent = { session }
  const ctx = {
    get: (name) =>
      name === 'agents' ? { turnBoundaryOf: () => ({ lastTurn: 3, lastStepStartSeq }) } : undefined,
  }
  return { adapter: new AcpAdapter(agentDef, ctx), dshAgent, appended }
}

test('tool events: advertises the call, then appends tool/call and tool/result', async () => {
  const { adapter, dshAgent, appended } = fakeSetup({ step: 1 })
  const started = await adapter.appendToolEvent(dshAgent, {
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'Read',
    rawInput: { path: '/a' },
  })
  assert.equal(started, true)
  // 会话格式要求 tool/call 前必须有一条 assistant/message 声明同一个 tool-call block。
  assert.equal(appended[0].type, 'assistant/message')
  assert.equal(appended[0].opts.surfaceOp, 'append')
  assert.equal(appended[0].data.turn, 3)
  assert.equal(appended[0].data.step, 1)
  const advertised = appended[0].data.message.content[0]
  assert.equal(advertised.type, 'tool-call')
  assert.equal(advertised.id, 'c1')
  assert.equal(advertised.name, 'Read')
  assert.equal(advertised.arguments, '{"path":"/a"}')

  assert.equal(appended[1].type, 'tool/call')
  assert.equal(appended[1].data.turn, 3)
  assert.equal(appended[1].data.step, 1)
  assert.equal(appended[1].data.callId, 'c1')
  // 声明与调用必须逐字一致，否则重放时判为 corrupt。
  assert.equal(appended[1].data.name, advertised.name)
  assert.equal(appended[1].data.arguments, advertised.arguments)

  const finished = await adapter.appendToolEvent(dshAgent, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  })
  assert.equal(finished, true)
  assert.equal(appended[2].type, 'tool/result')
  assert.equal(appended[2].data.turn, 3)
  assert.equal(appended[2].data.step, 1)
  assert.equal(appended[2].data.message.role, 'tool')
  assert.deepEqual(appended[2].data.message.content, [{ type: 'text', text: 'ok' }])
  assert.equal(appended[2].opts.surfaceOp, 'append')
  assert.deepEqual(appended[2].opts.sourceEventSeqs, [1])
})

test('tool events: failed status maps to isError', async () => {
  const { adapter, dshAgent, appended } = fakeSetup()
  await adapter.appendToolEvent(dshAgent, { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Bash' })
  await adapter.appendToolEvent(dshAgent, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c2',
    status: 'failed',
    rawOutput: { error: 'boom' },
  })
  assert.equal(appended[2].data.message.isError, true)
})

test('tool events: non-terminal update appends no result', async () => {
  const { adapter, dshAgent, appended } = fakeSetup()
  await adapter.appendToolEvent(dshAgent, { sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'Read' })
  await adapter.appendToolEvent(dshAgent, { sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'in_progress' })
  assert.equal(appended.length, 2)
})

test('tool events: resolves started calls before the step closes', async () => {
  const { adapter, dshAgent, appended } = fakeSetup()
  await adapter.appendToolEvent(dshAgent, { sessionUpdate: 'tool_call', toolCallId: 'c4', title: 'Read' })
  adapter.resolvePendingTools(dshAgent)
  assert.equal(appended[2].type, 'tool/result')
  assert.equal(appended[2].data.message.isError, true)
  assert.deepEqual(appended[2].opts.sourceEventSeqs, [1])
  // 已收尾的调用不会在后续回合重复补结果。
  adapter.resolvePendingTools(dshAgent)
  assert.equal(appended.length, 3)
})

test('tool events: refuses to append when the open turn/step cannot be determined', async () => {
  // lastStepStartSeq 为空 → 不知道 step，必须回退文本而不是写入错误的 step
  const { adapter, dshAgent, appended } = fakeSetup({ lastStepStartSeq: null })
  assert.equal(await adapter.appendToolEvent(dshAgent, { toolCallId: 'c1', title: 'X' }), false)
  assert.equal(appended.length, 0)

  // 没有 eventAt 也同样拒绝
  const second = fakeSetup({ withEventAt: false })
  assert.equal(await second.adapter.appendToolEvent(second.dshAgent, { toolCallId: 'c1', title: 'X' }), false)
  assert.equal(second.appended.length, 0)
})

test('tool events: returns false without an appendable session', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  assert.equal(await adapter.appendToolEvent(undefined, { toolCallId: 'c1', title: 'X' }), false)
  assert.equal(await adapter.appendToolEvent({ session: {} }, { toolCallId: 'c1', title: 'X' }), false)
  assert.equal(await adapter.appendToolEvent({ session: {} }, {}), false)
})

test('tool events: append failure falls back (returns false)', async () => {
  const session = { append: () => { throw new Error('not appendable') }, eventAt: () => ({ data: { step: 1 } }) }
  const ctx = { get: (name) => (name === 'agents' ? { turnBoundaryOf: () => ({ lastTurn: 1, lastStepStartSeq: 0 }) } : undefined) }
  const adapter = new AcpAdapter(agentDef, ctx)
  assert.equal(await adapter.appendToolEvent({ session }, { toolCallId: 'c1', title: 'X' }), false)
})
