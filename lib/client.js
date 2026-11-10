/**
 * dsh-acp-client 浏览器半（M3）：ACP Registry 设置页。
 *
 * 通过 Host 暴露的 fetch 路由读写：
 *   GET  /api/acp.registry  → registry.json（Host 侧拉取并缓存）
 *   GET  /api/acp.agents    → 已安装 agent
 *   POST /api/acp.install   → 安装/更新 agent
 *   POST /api/acp.remove    → 卸载 agent
 *
 * 渲染为 settings.section 槽里的 React 组件；样式只用 --dsw-alias-* 主题 token。
 */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-acp-client',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useState } = React

    const CSS = `
.acp-root { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; }
.acp-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.acp-tab { border:none; background:none; padding:8px 12px; font-size:13px; cursor:pointer; color:var(--dsw-alias-label-secondary); border-bottom:2px solid transparent; }
.acp-tab[data-active="true"] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-brand-primary); }
.acp-list { display:flex; flex-direction:column; gap:8px; overflow:auto; min-height:0; padding-right:2px; }
.acp-card { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
.acp-card:hover { background:var(--dsw-alias-bg-layer-2); }
.acp-name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.acp-desc { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.5; margin-top:2px; }
.acp-meta { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:4px; }
.acp-btn { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; white-space:nowrap; }
.acp-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.acp-btn:disabled { opacity:.5; cursor:default; }
.acp-btn.primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.acp-input { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:6px; padding:6px 8px; font-size:13px; outline:none; width:100%; box-sizing:border-box; }
.acp-input:focus { border-color:var(--dsw-alias-brand-primary); }
.acp-row { display:flex; gap:8px; align-items:center; }
.acp-banner { padding:6px 10px; border-radius:6px; font-size:12px; }
.acp-banner.error { color:var(--dsw-alias-state-error-primary); border:1px solid var(--dsw-alias-state-error-primary); }
.acp-banner.notice { color:var(--dsw-alias-state-success-primary); border:1px solid var(--dsw-alias-state-success-primary); }
.acp-form { display:grid; grid-template-columns:1fr 1fr; gap:8px; max-width:640px; }
.acp-form label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.acp-empty { color:var(--dsw-alias-label-secondary); font-size:13px; padding:16px 0; }
.acp-icon { flex:0 0 22px; width:22px; height:22px; border-radius:5px; object-fit:contain; background:var(--dsw-alias-bg-layer-2); }
.acp-icon.letter { display:flex; align-items:center; justify-content:center; font-size:11px; color:var(--dsw-alias-label-secondary); }
.acp-body { flex:1; min-width:0; }
`

    async function apiJson(path, init) {
      const res = await fetch(path, init)
      let data = null
      try { data = await res.json() } catch { /* ignore */ }
      if (!res.ok || !data?.ok) {
        const reason = data?.error || (Array.isArray(data?.errors) ? data.errors.join('; ') : '') || `HTTP ${res.status}`
        throw new Error(reason)
      }
      return data
    }

    function distLabel(dist) {
      const kinds = ['npx', 'uvx', 'binary', 'command'].filter((k) => dist?.[k] !== undefined)
      return kinds.length ? kinds.join(' + ') : '—'
    }

    function AgentIcon({ agent }) {
      const [failed, setFailed] = useState(false)
      if (agent.icon && !failed) {
        return h('img', { className: 'acp-icon', src: agent.icon, alt: '', onError: () => setFailed(true) })
      }
      return h('div', { className: 'acp-icon letter' }, (agent.name || '?')[0].toUpperCase())
    }

    function AgentCard({ agent, installed, busy, onInstall, onRemove }) {
      return h('div', { className: 'acp-card' },
        h(AgentIcon, { agent }),
        h('div', { className: 'acp-body' },
          h('div', { className: 'acp-name' }, agent.name),
          agent.description ? h('div', { className: 'acp-desc' }, agent.description) : null,
          h('div', { className: 'acp-meta' },
            [distLabel(agent.distribution), agent.license, agent.version ? `v${agent.version}` : null]
              .filter(Boolean).join(' · ')),
        ),
        h('button', {
          className: installed ? 'acp-btn' : 'acp-btn primary',
          disabled: busy,
          onClick: installed ? () => onRemove(agent) : () => onInstall(agent),
        }, busy ? '…' : installed ? '卸载' : '安装'),
      )
    }

    function AcpRegistrySection() {
      const [tab, setTab] = useState('registry')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [registry, setRegistry] = useState([])
      const [installed, setInstalled] = useState([])
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState('')
      const [custom, setCustom] = useState({ id: '', name: '', command: '', protocolVersion: 'v1' })

      const installedIds = useMemo(() => new Set(installed.map((a) => a.id)), [installed])

      const load = async () => {
        setLoading(true); setError('')
        try {
          const [reg, inst] = await Promise.all([apiJson('/api/acp.registry'), apiJson('/api/acp.agents')])
          setRegistry(reg.agents ?? [])
          setInstalled(inst.agents ?? [])
        } catch (e) {
          setError(e.message)
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => { void load() }, [])

      const refreshInstalled = async () => {
        const inst = await apiJson('/api/acp.agents')
        setInstalled(inst.agents ?? [])
      }

      const install = async (agent) => {
        setBusy(agent.id); setError(''); setNotice('')
        try {
          await apiJson('/api/acp.install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent }),
          })
          await refreshInstalled()
          setNotice(`已安装 ${agent.name}，可在模型下拉框选择`)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }

      const remove = async (agent) => {
        setBusy(agent.id); setError(''); setNotice('')
        try {
          await apiJson('/api/acp.remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: agent.id }),
          })
          await refreshInstalled()
          setNotice(`已卸载 ${agent.name}`)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }

      const installCustom = async () => {
        setError(''); setNotice('')
        const agent = {
          id: custom.id.trim(),
          name: custom.name.trim(),
          protocolVersion: custom.protocolVersion,
          distribution: { command: custom.command.trim() },
        }
        try {
          await apiJson('/api/acp.install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent }),
          })
          await refreshInstalled()
          setCustom({ id: '', name: '', command: '', protocolVersion: 'v1' })
          setNotice(`已添加自定义 Agent ${agent.name}`)
        } catch (e) { setError(e.message) }
      }

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return registry
        return registry.filter((a) =>
          `${a.name ?? ''} ${a.id ?? ''} ${a.description ?? ''}`.toLowerCase().includes(q))
      }, [registry, query])

      const tabs = [
        ['registry', 'Registry'],
        ['installed', `已安装 (${installed.length})`],
        ['custom', '自定义'],
      ]

      return h('div', { className: 'acp-root' },
        h('style', null, CSS),

        h('div', { className: 'acp-tabs' },
          ...tabs.map(([key, label]) => h('button', {
            key,
            className: 'acp-tab',
            'data-active': tab === key ? 'true' : 'false',
            onClick: () => setTab(key),
          }, label)),
        ),

        error ? h('div', { className: 'acp-banner error' }, error) : null,
        notice ? h('div', { className: 'acp-banner notice' }, notice) : null,

        tab === 'registry'
          ? h('div', { className: 'acp-root' },
            h('div', { className: 'acp-row' },
              h('input', {
                className: 'acp-input',
                placeholder: '搜索 Agent（名称 / 描述）…',
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
              h('button', { className: 'acp-btn', onClick: () => void load(), disabled: loading }, loading ? '加载中…' : '刷新'),
            ),
            h('div', { className: 'acp-list' },
              loading && registry.length === 0
                ? h('div', { className: 'acp-empty' }, '正在拉取 registry.json…')
                : filtered.length === 0
                  ? h('div', { className: 'acp-empty' }, '没有匹配的 Agent')
                  : filtered.map((agent) => h(AgentCard, {
                    key: agent.id,
                    agent,
                    installed: installedIds.has(agent.id),
                    busy: busy === agent.id,
                    onInstall: install,
                    onRemove: remove,
                  })),
            ),
          )
          : null,

        tab === 'installed'
          ? h('div', { className: 'acp-list' },
            installed.length === 0
              ? h('div', { className: 'acp-empty' }, '还没有安装任何 Agent，去 Registry 里挑一个吧。')
              : installed.map((agent) => h(AgentCard, {
                key: agent.id,
                agent: { ...agent, version: undefined },
                installed: true,
                busy: busy === agent.id,
                onInstall: install,
                onRemove: remove,
              })),
          )
          : null,

        tab === 'custom'
          ? h('div', { className: 'acp-form' },
            h('label', null, 'ID（小写字母/数字/连字符）',
              h('input', {
                className: 'acp-input',
                value: custom.id,
                placeholder: 'my-agent',
                onChange: (e) => setCustom((c) => ({ ...c, id: e.target.value })),
              })),
            h('label', null, '显示名称',
              h('input', {
                className: 'acp-input',
                value: custom.name,
                placeholder: 'My Agent',
                onChange: (e) => setCustom((c) => ({ ...c, name: e.target.value })),
              })),
            h('label', { style: { gridColumn: '1 / span 2' } }, '启动命令（stdio，ACP）',
              h('input', {
                className: 'acp-input',
                value: custom.command,
                placeholder: '~/.local/bin/qodercli --acp',
                onChange: (e) => setCustom((c) => ({ ...c, command: e.target.value })),
              })),
            h('label', null, 'ACP 版本',
              h('select', {
                className: 'acp-input',
                value: custom.protocolVersion,
                onChange: (e) => setCustom((c) => ({ ...c, protocolVersion: e.target.value })),
              },
                h('option', { value: 'v1' }, 'v1（可用）'),
                h('option', { value: 'v2' }, 'v2（预留）'),
              )),
            h('div', { style: { gridColumn: '1 / span 2', display: 'flex', justifyContent: 'flex-end' } },
              h('button', {
                className: 'acp-btn primary',
                disabled: !custom.id.trim() || !custom.name.trim() || !custom.command.trim(),
                onClick: installCustom,
              }, '添加'),
            ),
          )
          : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const NS = 'dsh-acp-client'
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.locale.register(NS, {
          en: { nav: 'ACP Registry' },
          zh: { nav: 'ACP Registry' },
        }), 'dsh-acp-client: dictionaries')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'acp',
          order: 40,
          label: () => t('nav'),
        }, AcpRegistrySection))
      },
    }
  },
})
