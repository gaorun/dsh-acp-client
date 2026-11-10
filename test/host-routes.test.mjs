import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config, inject } from '../lib/index.js'

/** 构造一个最小 fake Host ctx，记录 connection.fetch.register 注册的路由。 */
function makeFakeCtx() {
  const routes = []
  const ctx = {
    llm: { registerAdapter: () => () => {} },
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
    },
    effect: (cb) => cb(),
    get: () => undefined,
    fiber: { entry: {} },
  }
  return { ctx, routes }
}

test('host: Config schema has defaults', () => {
  assert.ok(Config)
  assert.deepEqual(inject, ['llm', 'connection'])
})

test('host: apply registers the four ACP fetch routes', () => {
  const { ctx, routes } = makeFakeCtx()
  const cleanup = apply(ctx, { protocolVersion: 'v1', agents: [] })
  assert.equal(typeof cleanup, 'function')

  const byPath = Object.fromEntries(routes.map((r) => [r.path, r]))
  assert.deepEqual(byPath['/api/acp.registry'].methods, ['GET'])
  assert.deepEqual(byPath['/api/acp.agents'].methods, ['GET'])
  assert.deepEqual(byPath['/api/acp.install'].methods, ['POST'])
  assert.deepEqual(byPath['/api/acp.remove'].methods, ['POST'])
  for (const route of routes) {
    assert.equal(typeof route.fetch, 'function')
    assert.equal(route.requestBody, 'buffered')
  }
})

test('host: install route validates and writes via configEditor', async () => {
  const { ctx, routes } = makeFakeCtx()
  let edited
  ctx.get = (name) => (name === 'configEditor' ? { edit: async (entry, change) => { edited = change({ protocolVersion: 'v1', agents: [] }) } } : undefined)
  apply(ctx, { protocolVersion: 'v1', agents: [] })

  const install = routes.find((r) => r.path === '/api/acp.install')
  const request = new Request('http://x/api/acp.install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: { id: 'my-agent', name: 'My Agent', distribution: { command: '~/bin/agent --acp' } } }),
  })
  const response = await install.fetch(request)
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(edited.agents.length, 1)
  assert.equal(edited.agents[0].id, 'my-agent')
})

test('host: install route rejects invalid definition', async () => {
  const { ctx, routes } = makeFakeCtx()
  apply(ctx, { protocolVersion: 'v1', agents: [] })
  const install = routes.find((r) => r.path === '/api/acp.install')
  const response = await install.fetch(new Request('http://x/api/acp.install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: { id: 'BAD', name: '' } }),
  }))
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.ok(body.errors.length > 0)
})
