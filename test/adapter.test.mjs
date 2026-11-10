import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AcpAdapter, providerIdFor, extractLastUserText } from '../src/adapter.mjs'
import { CHUNK } from '../src/v1-mapping.mjs'

const agentJs = fileURLToPath(
  new URL('../node_modules/@agentclientprotocol/sdk/dist/examples/agent.js', import.meta.url),
)

const agentDef = {
  id: 'example',
  name: 'Example agent',
  protocolVersion: 'v1',
  distribution: { command: `${process.execPath} ${agentJs}` },
}

test('adapter: providerIdFor prefixes acp:', () => {
  assert.equal(providerIdFor('qoder'), 'acp:qoder')
})

test('adapter: extractLastUserText joins text blocks of the latest user message', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ]
  assert.equal(extractLastUserText(messages), 'hello\nworld')
  assert.equal(extractLastUserText([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]), '')
})

test('adapter: stream drives an ACP agent and yields text + finish', { timeout: 30000 }, async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      sessionId: 'test-session',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello, agent!' }] }],
    })) {
      chunks.push(chunk)
    }
  } finally {
    await adapter.dispose()
  }

  const text = chunks.filter((c) => c.type === CHUNK.textDelta).map((c) => c.text).join('')
  const finishes = chunks.filter((c) => c.type === CHUNK.finish)
  assert.match(text, /help you/i)
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'stop')
})

test('adapter: reuses one ACP session across two turns', { timeout: 30000 }, async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  try {
    const read = async (text) => {
      const chunks = []
      for await (const chunk of adapter.stream({
        sessionId: 'reuse-session',
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      })) chunks.push(chunk)
      return chunks
    }
    const first = await read('first turn')
    const second = await read('second turn')
    assert.ok(first.some((c) => c.type === CHUNK.textDelta))
    assert.ok(second.some((c) => c.type === CHUNK.textDelta))
    assert.equal(adapter.sessions.size, 1, 'should reuse one session')
  } finally {
    await adapter.dispose()
  }
})
