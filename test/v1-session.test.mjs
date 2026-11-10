import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { V1Session } from '../src/v1-session.mjs'
import { createMapperState, mapUpdate, stopReasonToFinish, CHUNK } from '../src/v1-mapping.mjs'

const agentJs = fileURLToPath(
  new URL('../node_modules/@agentclientprotocol/sdk/dist/examples/agent.js', import.meta.url),
)

const agentDef = {
  id: 'example',
  name: 'Example agent',
  protocolVersion: 'v1',
  distribution: { command: `${process.execPath} ${agentJs}` },
}

test('v1-session: cancel aborts an in-flight turn', { timeout: 30000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-acp-'))
  const session = await V1Session.open(agentDef, { cwd })
  try {
    const iterator = session.prompt('Start a long turn')[Symbol.asyncIterator]()
    const first = await iterator.next() // 首个 update 到达
    assert.ok(first.done === false)
    session.cancel()
    // 排空到回合结束（取消 → stop 消息）。
    while (!(await iterator.next()).done) { /* drain */ }
    assert.equal(session.stopReason, 'cancelled')
  } finally {
    await session.close()
  }
})

test('v1-session: drives the SDK example agent end-to-end', { timeout: 30000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-acp-'))
  const session = await V1Session.open(agentDef, { cwd })
  const state = createMapperState()
  const chunks = []
  try {
    for await (const update of session.prompt('Hello, agent!')) {
      chunks.push(...mapUpdate(update, state))
    }
  } finally {
    await session.close()
  }

  const text = chunks.filter((c) => c.type === CHUNK.textDelta).map((c) => c.text).join('')
  const reasoning = chunks.filter((c) => c.type === CHUNK.reasoningDelta).map((c) => c.text).join('')

  assert.match(text, /help you/i, 'assistant text should be present')
  assert.match(reasoning, /\[tool\]/, 'tool lifecycle should surface as reasoning')
  assert.equal(session.stopReason, 'end_turn')

  const finish = stopReasonToFinish(session.stopReason)
  assert.equal(finish.reason.kind, 'stop')
})
