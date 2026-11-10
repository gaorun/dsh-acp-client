/**
 * 把已安装的 ACP Agent 定义解析成可 spawn 的命令（纯函数，可单测）。
 *
 * 支持三种分布（与 ACP Registry 的 manifest 对齐）+ 自定义直连命令：
 *  - distribution.npx            → npx -y <package> <args...>
 *  - distribution.uvx            → uvx <package> <args...>
 *  - distribution.binary[target] → 平台归档解压后的 cmd + args + env
 *  - distribution.command        → 自定义直连命令（字符串）
 */

/** 把 Node 的 process.platform / process.arch 归一化成 registry 的 <os>-<arch>。 */
export function platformTarget(platform = process.platform, arch = process.arch) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch
  return `${os}-${cpu}`
}

/** 候选目标列表：精确匹配优先，其次同 OS 的 x86_64，供 binary 兜底。 */
export function candidateTargets(platform = process.platform, arch = process.arch) {
  const exact = platformTarget(platform, arch)
  const targets = [exact]
  const [os] = exact.split('-')
  if (os === 'darwin' || os === 'linux') {
    if (exact !== `${os}-x86_64`) targets.push(`${os}-x86_64`)
    if (exact !== `${os}-aarch64`) targets.push(`${os}-aarch64`)
  } else if (os === 'windows' && exact !== 'windows-x86_64') {
    targets.push('windows-x86_64')
  }
  return targets
}

/**
 * 解析启动命令。
 * @param {object} definition 已安装的 agent 定义（含 distribution）
 * @param {string} platform   当前平台（默认 process.platform）
 * @param {string} arch       当前架构（默认 process.arch）
 * @returns {{ command: string, args: string[], env: Record<string,string> } | { error: string }}
 */
export function resolveLaunch(definition, platform = process.platform, arch = process.arch) {
  const dist = definition?.distribution
  if (!dist || typeof dist !== 'object') {
    return { error: 'agent definition has no distribution' }
  }

  if (typeof dist.command === 'string' && dist.command.trim().length > 0) {
    // 自定义直连命令：经 shell 解析（支持带空格/引号的完整命令行）。
    return { command: dist.command.trim(), args: [], env: dist.env ?? {}, shell: true }
  }

  if (dist.npx) {
    const pkg = dist.npx.package
    if (typeof pkg !== 'string' || pkg.length === 0) return { error: 'npx distribution needs a package' }
    return { command: 'npx', args: ['-y', pkg, ...(dist.npx.args ?? [])], env: dist.npx.env ?? {}, shell: false }
  }

  if (dist.uvx) {
    const pkg = dist.uvx.package
    if (typeof pkg !== 'string' || pkg.length === 0) return { error: 'uvx distribution needs a package' }
    return { command: 'uvx', args: [pkg, ...(dist.uvx.args ?? [])], env: dist.uvx.env ?? {}, shell: false }
  }

  if (dist.binary) {
    for (const target of candidateTargets(platform, arch)) {
      const entry = dist.binary[target]
      if (!entry) continue
      if (typeof entry.cmd !== 'string' || entry.cmd.length === 0) {
        return { error: `binary distribution for ${target} needs a cmd` }
      }
      return { command: entry.cmd, args: entry.args ?? [], env: entry.env ?? {}, shell: false }
    }
    return { error: `no binary distribution for platform ${platformTarget(platform, arch)}` }
  }

  return { error: 'unrecognized distribution (need command, npx, uvx, or binary)' }
}

export default { platformTarget, candidateTargets, resolveLaunch }
