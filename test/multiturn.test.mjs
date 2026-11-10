import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

import { AcpAdapter, renderHistory, lastUserIndex } from '../src/adapter.mjs'

const agentDef = { id: 'x', name: 'X', protocolVersion: 'v1', distribution: { command: 'true' } }

test('history: renderHistory keeps user/assistant text only', () => {
  const out = renderHistory([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'tool', content: [{ type: 'text', text: 'x' }] },
    { role: 'assistant', content: [] },
  ])
  assert.equal(out, 'User: hi\n\nAssistant: hello')
})

test('history: lastUserIndex finds the last user message', () => {
  assert.equal(lastUserIndex([{ role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }]), 3)
  assert.equal(lastUserIndex([{ role: 'assistant' }]), -1)
  assert.equal(lastUserIndex([]), -1)
})

test('prompt: fresh session prepends history, reused session does not', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] },
  ]
  const fresh = await adapter.buildPrompt({ messages }, true)
  assert.equal(fresh.length, 2)
  assert.match(fresh[0].text, /first question/)
  assert.match(fresh[0].text, /first answer/)
  assert.deepEqual(fresh[1], { type: 'text', text: 'second question' })

  const reused = await adapter.buildPrompt({ messages }, false)
  assert.deepEqual(reused, [{ type: 'text', text: 'second question' }])
})

test('prompt: fresh session with no prior history sends only the new message', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const fresh = await adapter.buildPrompt({ messages: [{ role: 'user', content: [{ type: 'text', text: 'only' }] }] }, true)
  assert.deepEqual(fresh, [{ type: 'text', text: 'only' }])
})

const qoderBin = `${homedir()}/.local/bin/qodercli`
const realTest = existsSync(qoderBin) ? test : test.skip

realTest('multiturn: adapter remembers a previous turn in one ACP session', { timeout: 90000 }, async () => {
  const adapter = new AcpAdapter(
    { id: 'qoder', name: 'Qoder CLI', protocolVersion: 'v1', distribution: { command: `${qoderBin} --acp` } },
    undefined,
  )
  const read = async (text) => {
    let out = ''
    for await (const chunk of adapter.stream({
      sessionId: 'mt',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      if (chunk.type === 'text-delta') out += chunk.text
    }
    return out
  }
  try {
    await read('My favorite color is blue. Just acknowledge.')
    const second = await read('What is my favorite color? Reply with one word.')
    assert.match(second, /blue/i, 'second turn should remember the first')
  } finally {
    await adapter.dispose()
  }
})
