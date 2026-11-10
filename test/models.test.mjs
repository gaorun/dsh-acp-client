import { test } from 'node:test'
import assert from 'node:assert/strict'

import { V1Session, findModelConfigOption } from '../src/v1-session.mjs'

/** 构造一个最小 fake V1Session（不连真实 Agent）。 */
function fakeSession({ newSessionResponse, request = async () => ({}) }) {
  return new V1Session({
    proc: { kill() {} },
    connection: { agent: { request } },
    session: { sessionId: 's1', newSessionResponse, dispose() {} },
    agent: { id: 'x', name: 'X' },
  })
}

test('models: classic models.availableModels', () => {
  const session = fakeSession({
    newSessionResponse: {
      sessionId: 's1',
      models: {
        availableModels: [
          { modelId: 'auto', name: 'Auto', description: 'Vision · 0.5x' },
          { modelId: 'fast', name: 'Fast' },
        ],
        currentModelId: 'fast',
      },
    },
  })
  assert.deepEqual(session.models, [
    { id: 'auto', name: 'Auto', description: 'Vision · 0.5x' },
    { id: 'fast', name: 'Fast' },
  ])
  assert.equal(session.currentModelId, 'fast')
})

test('models: falls back to configOptions model select', () => {
  const session = fakeSession({
    newSessionResponse: {
      sessionId: 's1',
      configOptions: [
        { id: 'mode', category: 'mode', currentValue: 'auto', options: [] },
        { id: 'model', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] },
      ],
    },
  })
  assert.deepEqual(session.models, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  assert.equal(session.currentModelId, 'a')
})

test('models: empty when agent advertises none', () => {
  const session = fakeSession({ newSessionResponse: { sessionId: 's1' } })
  assert.deepEqual(session.models, [])
  assert.equal(session.currentModelId, undefined)
})

test('findModelConfigOption: prefers category then id', () => {
  assert.equal(findModelConfigOption([{ id: 'x', category: 'mode' }, { id: 'model' }])?.id, 'model')
  assert.equal(findModelConfigOption([{ id: 'm', category: 'model' }])?.id, 'm')
  assert.equal(findModelConfigOption(undefined), undefined)
})

test('setModel: sends session/set_config_option with configId + value', async () => {
  let called = null
  const session = fakeSession({
    request: async (method, params) => {
      called = { method, params }
      return { configOptions: [{ id: 'model', category: 'model', currentValue: 'b' }] }
    },
    newSessionResponse: {
      sessionId: 's1',
      models: { availableModels: [{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }], currentModelId: 'a' },
    },
  })
  await session.setModel('b')
  assert.equal(called.method, 'session/set_config_option')
  assert.equal(called.params.sessionId, 's1')
  assert.equal(called.params.configId, 'model')
  assert.equal(called.params.value, 'b')
  assert.equal(session.currentModelId, 'b')
})

test('setModel: no-op when already current', async () => {
  let calls = 0
  const session = fakeSession({
    request: async () => { calls += 1; return {} },
    newSessionResponse: {
      sessionId: 's1',
      models: { availableModels: [{ modelId: 'a', name: 'A' }], currentModelId: 'a' },
    },
  })
  await session.setModel('a')
  assert.equal(calls, 0)
})

import { AcpAdapter } from '../src/adapter.mjs'

test('reasoning: reads the thought_level config option', () => {
  const session = fakeSession({
    newSessionResponse: {
      sessionId: 's1',
      configOptions: [
        { id: 'model', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
        { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      ],
    },
  })
  const reasoning = session.reasoning
  assert.equal(reasoning.configId, 'reasoning_effort')
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'high'])
  assert.equal(reasoning.current, 'high')
})

test('modes: reads classic modes', () => {
  const session = fakeSession({
    newSessionResponse: {
      sessionId: 's1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }], currentModeId: 'auto' },
    },
  })
  assert.deepEqual(session.modes.map((m) => m.id), ['default', 'auto'])
  assert.equal(session.currentModeId, 'auto')
})

test('setMode / setReasoningEffort send session/set_config_option', async () => {
  const calls = []
  const session = fakeSession({
    request: async (method, params) => { calls.push({ method, params }); return { configOptions: [] } },
    newSessionResponse: {
      sessionId: 's1',
      configOptions: [
        { id: 'mode', category: 'mode', currentValue: 'auto', options: [{ value: 'auto' }, { value: 'yolo' }] },
        { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
      ],
    },
  })
  await session.setMode('yolo')
  await session.setReasoningEffort('low')
  assert.equal(calls[0].method, 'session/set_config_option')
  assert.equal(calls[0].params.configId, 'mode')
  assert.equal(calls[0].params.value, 'yolo')
  assert.equal(calls[1].params.configId, 'reasoning_effort')
  assert.equal(calls[1].params.value, 'low')
})

test('adapter: resolveModel carries agent-prefixed name + reasoning efforts', async () => {
  const adapter = new AcpAdapter({ id: 'qoder', name: 'Qoder', protocolVersion: 'v1', distribution: { command: 'true' } }, undefined)
  adapter._models = [{ provider: 'acp:qoder', id: 'dfmodel', name: 'Qoder:DeepSeek-V4-Flash' }]
  adapter._reasoning = { configId: 'reasoning_effort', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], current: 'high' }
  const info = await adapter.resolveModel('acp:qoder', 'dfmodel')
  assert.equal(info.name, 'Qoder:DeepSeek-V4-Flash')
  assert.deepEqual(info.reasoning.efforts.map((e) => e.id), ['low', 'high'])
  assert.equal(info.reasoning.defaultEffort, 'high')
})

test('adapter: acp-mode command lists and switches modes', async () => {
  const adapter = new AcpAdapter({ id: 'qoder', name: 'Qoder', protocolVersion: 'v1', distribution: { command: 'true' } }, undefined)
  const registered = []
  const commandsService = { register: (def) => { registered.push(def); return () => {} } }
  const agent = { ctx: { get: (n) => (n === 'commands' ? commandsService : undefined) }, session: { id: 's1' } }
  const modes = [{ id: 'auto', name: 'Auto' }, { id: 'yolo', name: 'Yolo' }]
  const switched = []
  adapter.sessions.set('s1', { modes, currentModeId: 'auto', setMode: async (m) => { switched.push(m) } })
  adapter.registerModeCommand(agent)

  const command = registered.find((def) => def.name === 'acp-mode')
  assert.ok(command, 'should register /acp-mode')
  const listed = await command.handler({ agent, rawInput: '' })
  assert.match(listed.text, /auto/)
  const changed = await command.handler({ agent, rawInput: 'yolo' })
  assert.equal(changed.kind, 'success')
  assert.deepEqual(switched, ['yolo'])
})
