import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AcpAdapter } from '../src/adapter.mjs'

const agentDef = { id: 'example', name: 'Example agent', protocolVersion: 'v1', distribution: { command: 'true' } }

/** 最小 fake DSH Agent：记录 commands.register 与 followup。 */
function makeFakeAgent() {
  const registered = []
  const followed = []
  const agent = {
    ctx: {
      commands: {
        register: (definition) => {
          registered.push(definition)
          return () => {}
        },
      },
    },
    followup: (message) => {
      followed.push(message)
    },
  }
  return { agent, registered, followed }
}

test('commands: registers ACP availableCommands as agent-scoped commands', () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const { agent, registered } = makeFakeAgent()

  adapter.registerCommands(agent, [
    { name: 'goal', description: 'Set a goal', input: { hint: '<objective>' } },
    { name: 'rewind', description: 'Rewind' },
  ])

  assert.equal(registered.length, 2)
  assert.equal(registered[0].name, 'goal')
  assert.deepEqual(registered[0].input, { hint: '<objective>' })
  assert.equal(typeof registered[0].handler, 'function')
})

test('commands: handler sends /name rawInput as next user message', () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const { agent, registered, followed } = makeFakeAgent()
  adapter.registerCommands(agent, [{ name: 'goal' }])

  const result = registered[0].handler({ agent, rawInput: 'ship it' })
  assert.equal(result.kind, 'success')
  assert.equal(followed.length, 1)
  assert.deepEqual(followed[0].content, [{ type: 'text', text: '/goal ship it' }])
  assert.deepEqual(followed[0].source, { kind: 'user' })
})

test('commands: no-op when commands unchanged, re-registers when changed', () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const { agent, registered } = makeFakeAgent()
  adapter.registerCommands(agent, [{ name: 'goal' }])
  const afterFirst = registered.length
  adapter.registerCommands(agent, [{ name: 'goal' }])
  assert.equal(registered.length, afterFirst, 'same list should not re-register')
  adapter.registerCommands(agent, [{ name: 'goal' }, { name: 'rewind' }])
  assert.equal(registered.length, afterFirst + 2, 'changed list re-registers')
})

test('commands: handler without receiving agent returns error', () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  const { agent, registered } = makeFakeAgent()
  adapter.registerCommands(agent, [{ name: 'goal' }])
  const result = registered[0].handler({ agent: undefined, rawInput: '' })
  assert.equal(result.kind, 'error')
})

test('commands: skips registration when agent ctx has no commands service', () => {
  const adapter = new AcpAdapter(agentDef, undefined)
  // 不应抛错
  adapter.registerCommands({ ctx: {} }, [{ name: 'goal' }])
  adapter.registerCommands(undefined, [{ name: 'goal' }])
})

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const qoderBin = `${homedir()}/.local/bin/qodercli`
const realTest = existsSync(qoderBin) ? test : test.skip

realTest('commands: real Qoder advertises slash commands end-to-end', { timeout: 60000 }, async () => {
  const { agent, registered } = makeFakeAgent()
  const fakeCtx = {
    get: (name) => (name === 'agents' ? { get: () => agent } : undefined),
  }
  const adapter = new AcpAdapter(
    { id: 'qoder', name: 'Qoder CLI', protocolVersion: 'v1', distribution: { command: `${qoderBin} --acp` } },
    fakeCtx,
  )
  try {
    for await (const _chunk of adapter.stream({
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'say hi' }] }],
    })) {
      // drain
    }
  } finally {
    await adapter.dispose()
  }
  assert.ok(registered.length > 0, 'should register at least one command')
  assert.ok(registered.some((definition) => definition.name === 'goal'), 'Qoder should advertise /goal')
})
