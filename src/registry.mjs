/**
 * ACP Registry：拉取聚合列表 + 校验/规范化单个 agent manifest。
 *
 * 数据源（见 docs/design.md §3）：
 *  - 聚合列表 registry.json（{version, agents:[...]}），CDN：
 *    https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 *  - 单条 manifest <id>/agent.json；agent.schema.json 是校验 manifest 的 JSON Schema。
 *
 * 本模块的校验是 agent.schema.json 的运行时子集（必需字段 + 分布形状），
 * 不依赖完整 schema 文件；fetch 使用全局 fetch，URL 可注入以便测试。
 */

/** agent id 必须满足：^[a-z][a-z0-9-]*$ */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 校验一个 registry 条目，返回 { ok, errors }。 */
export function validateAgent(entry) {
  const errors = []
  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['entry is not an object'] }
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) errors.push(`id must match ${ID_PATTERN}`)
  if (typeof entry.name !== 'string' || entry.name.length === 0) errors.push('name is required')
  if (typeof entry.version !== 'string' || entry.version.length === 0) errors.push('version is required')
  if (typeof entry.description !== 'string' || entry.description.length === 0) errors.push('description is required')

  const dist = entry.distribution
  if (!dist || typeof dist !== 'object') {
    errors.push('distribution is required')
  } else {
    const kinds = ['binary', 'npx', 'uvx'].filter((k) => dist[k] !== undefined)
    if (kinds.length === 0) errors.push('distribution needs at least one of binary/npx/uvx')
    for (const k of kinds) {
      const v = dist[k]
      if (v === null || typeof v !== 'object') {
        errors.push(`distribution.${k} must be an object`)
        continue
      }
      if (k === 'npx' || k === 'uvx') {
        if (typeof v.package !== 'string' || v.package.length === 0) errors.push(`distribution.${k}.package is required`)
      } else if (k === 'binary') {
        for (const [target, b] of Object.entries(v)) {
          if (typeof b !== 'object' || b === null) errors.push(`distribution.binary.${target} must be an object`)
          else if (typeof b.cmd !== 'string' || b.cmd.length === 0) errors.push(`distribution.binary.${target}.cmd is required`)
        }
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 把一个 registry 条目规范化为内部 agent 定义（含 protocolVersion 默认 v1）。 */
export function normalizeRegistryEntry(entry, protocolVersion = 'v1') {
  const check = validateAgent(entry)
  if (!check.ok) return { ok: false, errors: check.errors }
  return {
    ok: true,
    value: {
      id: entry.id,
      name: entry.name,
      protocolVersion,
      description: entry.description,
      ...(entry.repository ? { repository: entry.repository } : {}),
      ...(Array.isArray(entry.authors) ? { authors: entry.authors } : {}),
      ...(entry.license ? { license: entry.license } : {}),
      ...(entry.icon ? { icon: entry.icon } : {}),
      distribution: entry.distribution,
    },
  }
}

/**
 * 拉取聚合 registry.json 并返回 agents 列表。
 * @param {string} [url] 默认 CDN 地址
 * @param {typeof fetch} [fetchImpl] 可注入的 fetch
 * @returns {Promise<{ ok: true, agents: object[] } | { ok: false, error: string }>}
 */
export async function fetchRegistry(url = DEFAULT_REGISTRY_URL, fetchImpl = fetch) {
  let res
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch (cause) {
    return { ok: false, error: `fetch registry failed: ${cause?.message ?? String(cause)}` }
  }
  if (!res.ok) return { ok: false, error: `registry responded ${res.status}` }
  let data
  try {
    data = await res.json()
  } catch {
    return { ok: false, error: 'registry body is not valid JSON' }
  }
  if (!Array.isArray(data?.agents)) return { ok: false, error: 'registry.json has no agents array' }
  return { ok: true, agents: data.agents }
}

export const DEFAULT_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

/**
 * 把「注册表条目」或「自定义 Agent 定义」规范化为内部 agent 定义。
 * 自定义定义额外支持 distribution.command（直连命令字符串）。
 * @param {object} input
 * @param {'v1'|'v2'} [fallbackProtocolVersion]
 */
export function normalizeAgentDefinition(input, fallbackProtocolVersion = 'v1') {
  const errors = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['agent definition is not an object'] }

  const id = input.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) errors.push(`id must match ${ID_PATTERN}`)
  const name = input.name
  if (typeof name !== 'string' || name.trim().length === 0) errors.push('name is required')

  const dist = input.distribution
  if (!dist || typeof dist !== 'object') {
    errors.push('distribution is required')
  } else {
    const kinds = ['binary', 'npx', 'uvx', 'command'].filter((k) => dist[k] !== undefined)
    if (kinds.length === 0) errors.push('distribution needs at least one of binary/npx/uvx/command')
    if (dist.command !== undefined && (typeof dist.command !== 'string' || dist.command.trim().length === 0)) {
      errors.push('distribution.command must be a non-empty string')
    }
    if (dist.npx !== undefined && (typeof dist.npx?.package !== 'string' || dist.npx.package.length === 0)) {
      errors.push('distribution.npx.package is required')
    }
    if (dist.uvx !== undefined && (typeof dist.uvx?.package !== 'string' || dist.uvx.package.length === 0)) {
      errors.push('distribution.uvx.package is required')
    }
    if (dist.binary !== undefined && (typeof dist.binary !== 'object' || dist.binary === null)) {
      errors.push('distribution.binary must be an object')
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const protocolVersion =
    input.protocolVersion === 'v2' ? 'v2' : input.protocolVersion === 'v1' ? 'v1' : fallbackProtocolVersion

  return {
    ok: true,
    value: {
      id: id.trim(),
      name: name.trim(),
      protocolVersion,
      ...(typeof input.description === 'string' ? { description: input.description } : {}),
      ...(typeof input.repository === 'string' ? { repository: input.repository } : {}),
      ...(typeof input.license === 'string' ? { license: input.license } : {}),
      ...(typeof input.icon === 'string' ? { icon: input.icon } : {}),
      distribution: dist,
    },
  }
}

export default { validateAgent, normalizeRegistryEntry, fetchRegistry, normalizeAgentDefinition, DEFAULT_REGISTRY_URL }
