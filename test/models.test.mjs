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
