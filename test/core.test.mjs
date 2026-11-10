import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createMapperState, mapUpdate, stopReasonToFinish, CHUNK } from '../src/v1-mapping.mjs'
import { platformTarget, candidateTargets, resolveLaunch } from '../src/launch.mjs'
import { validateAgent, normalizeRegistryEntry, normalizeAgentDefinition } from '../src/registry.mjs'

test('v1-mapping: agent text chunk maps to text-delta', () => {
  const state = createMapperState()
  const chunks = mapUpdate(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } },
    state,
  )
  assert.deepEqual(chunks, [{ type: CHUNK.textDelta, index: 0, text: 'hi there' }])
})

test('v1-mapping: empty text chunk produces no chunks', () => {
  const chunks = mapUpdate(
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
    createMapperState(),
  )
  assert.equal(chunks.length, 0)
})

test('v1-mapping: thought chunk maps to reasoning-delta', () => {
  const chunks = mapUpdate(
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
    createMapperState(),
  )
  assert.deepEqual(chunks, [{ type: CHUNK.reasoningDelta, index: 1, text: 'thinking…' }])
})

test('v1-mapping: tool lifecycle renders as reasoning text', () => {
  const chunks = mapUpdate(
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', status: 'running', kind: 'read' },
    createMapperState(),
  )
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, CHUNK.reasoningDelta)
  assert.match(chunks[0].text, /Read/)
  assert.match(chunks[0].text, /running/)
})

test('v1-mapping: usage maps to usage chunk and records in state', () => {
  const state = createMapperState()
  const chunks = mapUpdate(
    { sessionUpdate: 'usage_update', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    state,
  )
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0].usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  assert.deepEqual(state.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
})

test('v1-mapping: unknown update variants are ignored', () => {
  for (const sessionUpdate of ['user_message_chunk', 'plan', 'notice', 'config_option_update']) {
    assert.deepEqual(mapUpdate({ sessionUpdate }, createMapperState()), [])
  }
})

test('v1-mapping: stop reasons map to finish kinds', () => {
  assert.equal(stopReasonToFinish(undefined).reason.kind, 'stop')
  assert.equal(stopReasonToFinish('end_turn').reason.kind, 'stop')
  assert.equal(stopReasonToFinish('max_tokens').reason.kind, 'max-tokens')
  assert.equal(stopReasonToFinish('cancelled').reason.kind, 'aborted')
  assert.equal(stopReasonToFinish('error', { code: 'X', message: 'm' }).reason.kind, 'error')
})

test('launch: platformTarget normalizes node platform/arch', () => {
  assert.equal(platformTarget('darwin', 'arm64'), 'darwin-aarch64')
  assert.equal(platformTarget('darwin', 'x64'), 'darwin-x86_64')
  assert.equal(platformTarget('linux', 'x64'), 'linux-x86_64')
  assert.equal(platformTarget('win32', 'x64'), 'windows-x86_64')
  assert.equal(platformTarget('win32', 'arm64'), 'windows-aarch64')
})

test('launch: candidateTargets prefers exact then same-os fallbacks', () => {
  const t = candidateTargets('darwin', 'arm64')
  assert.equal(t[0], 'darwin-aarch64')
  assert.ok(t.includes('darwin-x86_64'))
})

test('launch: resolves npx/uvx/command/binary', () => {
  assert.deepEqual(
    resolveLaunch({ distribution: { npx: { package: 'pkg', args: ['--acp'] } } }, 'darwin', 'arm64'),
    { command: 'npx', args: ['-y', 'pkg', '--acp'], env: {}, shell: false },
  )
  assert.deepEqual(
    resolveLaunch({ distribution: { uvx: { package: 'pkg@1', args: ['--mode', 'acp'] } } }, 'linux', 'x64'),
    { command: 'uvx', args: ['pkg@1', '--mode', 'acp'], env: {}, shell: false },
  )
  assert.deepEqual(
    resolveLaunch({ distribution: { command: '/usr/local/bin/agent --acp' } }, 'linux', 'x64'),
    { command: '/usr/local/bin/agent --acp', args: [], env: {}, shell: true },
  )
  const binary = resolveLaunch(
    { distribution: { binary: { 'darwin-aarch64': { archive: 'x.zip', cmd: './agent', args: ['acp'], env: { A: '1' } } } } },
    'darwin',
    'arm64',
  )
  assert.deepEqual(binary, { command: './agent', args: ['acp'], env: { A: '1' }, shell: false })
})

test('launch: missing distribution or binary target reports error', () => {
  assert.ok(resolveLaunch({}).error)
  assert.ok(resolveLaunch({ distribution: { npx: {} } }, 'linux', 'x64').error)
  assert.ok(resolveLaunch({ distribution: { binary: {} } }, 'darwin', 'arm64').error)
})

test('registry: validate requires id/name/version/description/distribution', () => {
  const good = {
    id: 'someagent', name: 'SomeAgent', version: '1.0.0', description: 'd',
    distribution: { npx: { package: 'someagent', args: ['--acp'] } },
  }
  assert.equal(validateAgent(good).ok, true)
  assert.equal(validateAgent({ ...good, id: 'Bad_ID' }).ok, false)
  assert.equal(validateAgent({ ...good, distribution: {} }).ok, false)
  assert.equal(validateAgent({}).ok, false)
})

test('registry: normalize sets protocolVersion default v1', () => {
  const entry = {
    id: 'qoder', name: 'Qoder', version: '1.0.0', description: 'd',
    repository: 'https://github.com/qoder', license: 'MIT',
    distribution: { npx: { package: 'qoder', args: ['--acp'] } },
  }
  const r = normalizeRegistryEntry(entry)
  assert.equal(r.ok, true)
  assert.equal(r.value.protocolVersion, 'v1')
  assert.equal(r.value.id, 'qoder')
  assert.equal(r.value.distribution.npx.package, 'qoder')
  assert.equal(normalizeRegistryEntry(entry, 'v2').value.protocolVersion, 'v2')
})

test('registry: normalizeAgentDefinition accepts custom command distribution', () => {
  const r = normalizeAgentDefinition({
    id: 'my-agent', name: 'My Agent', protocolVersion: 'v1',
    distribution: { command: '~/bin/agent --acp' },
  })
  assert.equal(r.ok, true)
  assert.equal(r.value.id, 'my-agent')
  assert.equal(r.value.distribution.command, '~/bin/agent --acp')
  assert.equal(r.value.protocolVersion, 'v1')
})

test('registry: normalizeAgentDefinition rejects bad definitions', () => {
  assert.equal(normalizeAgentDefinition(null).ok, false)
  assert.equal(normalizeAgentDefinition({ id: 'Bad_ID', name: 'x', distribution: { command: 'a' } }).ok, false)
  assert.equal(normalizeAgentDefinition({ id: 'ok', name: '', distribution: { command: 'a' } }).ok, false)
  assert.equal(normalizeAgentDefinition({ id: 'ok', name: 'x', distribution: {} }).ok, false)
  assert.equal(normalizeAgentDefinition({ id: 'ok', name: 'x', distribution: { command: '  ' } }).ok, false)
})

test('registry: normalizeAgentDefinition accepts registry-entry shapes', () => {
  const entry = {
    id: 'qoder', name: 'Qoder', version: '1.0.0', description: 'd',
    distribution: { npx: { package: 'qoder', args: ['--acp'] } },
  }
  const r = normalizeAgentDefinition(entry)
  assert.equal(r.ok, true)
  assert.equal(r.value.distribution.npx.package, 'qoder')
})
