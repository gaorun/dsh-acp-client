/**
 * dsh-acp-client 浏览器半（M3，待实现）：ACP Registry 设置页。
 *
 * 注册进 settings shell 的 `settings.section` slot（与 dsh-client-ui-settings-models
 * 的「Models」页一致）。页面内容：
 *  1. 拉取 registry.json 渲染 Agents（src/registry.mjs 的逻辑在 client 侧由
 *     ctx.remote.* / 宿主暴露的 registry RPC 提供），点击「安装」写 agent 定义。
 *  2. 「自定义 ACP Agent」表单：名称、启动命令/分布、protocolVersion（v1/v2）。
 *
 * 本文件是占位骨架：真正的列表/表单/安装动作待 M3 实现。
 */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-acp-client',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function AcpRegistrySection() {
      return h('div', { style: { padding: 16 } },
        h('h2', null, 'ACP Registry'),
        h('p', null, 'TODO(M3): 拉取 registry.json 渲染 Agents、安装、自定义 ACP Agent（见 docs/design.md §3）。'),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const NS = 'dsh-acp-client'
          ctx.locale.register(NS, {
            'meta.title': 'ACP Registry',
            'meta.description': 'Discover and install ACP agents to use as models.',
            nav: 'ACP Registry',
          })
        })

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'acp',
          order: 40,
          label: () => ctx.locale.t('dsh-acp-client.nav'),
        }, AcpRegistrySection))
      },
    }
  },
})
