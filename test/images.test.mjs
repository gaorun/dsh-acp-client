import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AcpAdapter } from '../src/adapter.mjs'

const agentDef = { id: 'x', name: 'X', protocolVersion: 'v1', distribution: { command: 'true' } }

test('images: image block converts to base64 ACP ImageContent', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
  const adapter = new AcpAdapter(agentDef, {
    get: (name) =>
      name === 'attachments'
        ? { readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array(bytes) }) }
        : undefined,
  })
  const blocks = await adapter.extractLastUserContent([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png' } },
      ],
    },
  ])
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'text', text: 'look at this' })
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].mimeType, 'image/png')
  assert.equal(blocks[1].data, bytes.toString('base64'))
})

test('images: missing attachment store yields text placeholder', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const blocks = await adapter.extractLastUserContent([
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x', mediaType: 'image/png' } }] },
  ])
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /image omitted/)
})

test('images: unreadable attachment yields text placeholder', async () => {
  const adapter = new AcpAdapter(agentDef, {
    get: (name) =>
      name === 'attachments'
        ? { readImage: async () => { throw new Error('ATTACHMENT_NOT_FOUND') } }
        : undefined,
  })
  const blocks = await adapter.extractLastUserContent([
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x', mediaType: 'image/jpeg' } }] },
  ])
  assert.equal(blocks[0].type, 'text')
})

test('images: offloaded images are skipped', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const blocks = await adapter.extractLastUserContent([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', attachment: { attachmentId: 'x', mediaType: 'image/png' }, offloaded: true },
      ],
    },
  ])
  assert.deepEqual(blocks, [{ type: 'text', text: 'hi' }])
})

test('images: latest user message wins and empty content falls back', async () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const blocks = await adapter.extractLastUserContent([
    { role: 'user', content: [{ type: 'text', text: 'older' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'newest' }] },
  ])
  assert.deepEqual(blocks, [{ type: 'text', text: 'newest' }])
  assert.deepEqual(await adapter.extractLastUserContent([]), [])
})

import { V1Session } from '../src/v1-session.mjs'

test('images: V1Session.prompt forwards ACP content blocks unchanged', async () => {
  let sent
  const session = new V1Session({
    proc: { kill() {} },
    connection: { agent: { request: async () => ({}) } },
    session: {
      sessionId: 's1',
      newSessionResponse: { sessionId: 's1' },
      prompt: (content) => { sent = content },
      nextUpdate: async () => ({ kind: 'stop', stopReason: 'end_turn' }),
      dispose() {},
    },
    agent: { id: 'x', name: 'X' },
  })
  const blocks = [
    { type: 'text', text: 'hi' },
    { type: 'image', data: 'abc', mimeType: 'image/png' },
  ]
  for await (const _ of session.prompt(blocks)) {}
  assert.deepEqual(sent, blocks)
})
