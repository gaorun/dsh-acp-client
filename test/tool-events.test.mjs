import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AcpAdapter } from '../src/adapter.mjs'

const agentDef = { id: 'x', name: 'X', protocolVersion: 'v1', distribution: { command: 'true' } }

function fakeSetup() {
  const appended = []
  const session = {
    append: (type, data, opts) => {
      appended.push({ type, data, opts })
      return { seq: appended.length - 1 }
    },
  }
  const dshAgent = { session }
  const ctx = {
    get: (name) => (name === 'agents' ? { turnBoundaryOf: () => ({ lastTurn: 3 }) } : undefined),
  }
  return { adapter: new AcpAdapter(agentDef, ctx), dshAgent, appended }
}

test('tool events: appends tool/call then tool/result', async () => {
  const { adapter, dshAgent, appended } = fakeSetup()

  const started = await adapter.appendToolEvent(dshAgent, {
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'Read',
    rawInput: { path: '/a' },
  })
  assert.equal(started, true)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'tool/call')
  assert.equal(appended[0].data.callId, 'c1')
  assert.equal(appended[0].data.name, 'Read')
  assert.equal(appended[0].data.turn, 3)

  const finished = await adapter.appendToolEvent(dshAgent, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  })
  assert.equal(finished, true)
  assert.equal(appended.length, 2)
  assert.equal(appended[1].type, 'tool/result')
  assert.equal(appended[1].data.message.role, 'tool')
  assert.equal(appended[1].data.message.toolCallId, 'c1')
  assert.deepEqual(appended[1].data.message.content, [{ type: 'text', text: 'ok' }])
  assert.equal(appended[1].opts.surfaceOp, 'append')
  assert.deepEqual(appended[1].opts.sourceEventSeqs, [0])
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
  assert.equal(appended[1].data.message.isError, true)
})

test('tool events: non-terminal update appends no result', async () => {
  const { adapter, dshAgent, appended } = fakeSetup()
  await adapter.appendToolEvent(dshAgent, { sessionUpdate: 'tool_call', toolCallId: 'c3', title: 'Read' })
  await adapter.appendToolEvent(dshAgent, { sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'in_progress' })
  assert.equal(appended.length, 1)
})

test('tool events: returns false without an appendable session', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  assert.equal(await adapter.appendToolEvent(undefined, { toolCallId: 'c1', title: 'X' }), false)
  assert.equal(await adapter.appendToolEvent({ session: {} }, { toolCallId: 'c1', title: 'X' }), false)
  assert.equal(await adapter.appendToolEvent({ session: {} }, {}), false)
})

test('tool events: append failure falls back (returns false)', async () => {
  const session = { append: () => { throw new Error('not appendable') } }
  const adapter = new AcpAdapter(agentDef, undefined)
  assert.equal(await adapter.appendToolEvent({ session }, { toolCallId: 'c1', title: 'X' }), false)
})
