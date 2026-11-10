/**
 * ACP v1 会话驱动（M2）。
 *
 * 用官方 SDK 的客户端 API 启动外部 Agent、negotiate、建会话、发 prompt、逐条
 * 消费 update。一个 V1Session 对应一个 DSH session（有状态桥）；崩溃 / 关闭
 * 都映射为可被 adapter 转成 finish(error) 的异常。
 *
 * 依赖：@agentclientprotocol/sdk（随 DSH 打包，1.4.x；本仓库 devDependency 1.9.x
 * 用于本地测试）。只使用两者共有的稳定 v1 API。
 */
import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { resolveLaunch } from './launch.mjs'

/** v1 MVP 权限策略：默认选第一个 allow 选项；后续接 DSH approval 策略。 */
function defaultPermissionDecision(params) {
  const options = params?.options ?? []
  const allow = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
  if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  return { outcome: { outcome: 'cancelled' } }
}

/** 从 session/configOptions 里找模型选择器（category 优先，其次 id）。 */
export function findModelConfigOption(configOptions) {
  if (!Array.isArray(configOptions)) return undefined
  return configOptions.find((option) => option?.category === 'model') ?? configOptions.find((option) => option?.id === 'model')
}

export class V1Session {
  /**
   * @param {object} init
   * @param {import('node:child_process').ChildProcess} init.proc
   * @param {object} init.connection ClientConnectionHandle（app.connect 返回值）
   * @param {object} init.session    ActiveSession
   * @param {object} init.agent      已安装 agent 定义
   */
  constructor({ proc, connection, session, agent }) {
    this.proc = proc
    this.connection = connection
    this.session = session
    this.agent = agent
    this.stopReason = undefined
    this.failure = undefined
    this._closed = false
  }

  /**
   * 启动 Agent 并建好会话。
   * @param {object} agent 已安装 agent 定义（含 distribution）
   * @param {object} [opts]
   * @param {string} [opts.cwd] 绝对工作目录
   * @param {(params:object)=>object} [opts.permission] 权限决策函数
   * @param {(kind:string, detail:unknown)=>void} [opts.log]
   */
  static async open(agent, { cwd, permission, log } = {}) {
    const launch = resolveLaunch(agent)
    if (launch.error) throw new Error(`dsh-acp-client: cannot launch "${agent.id}": ${launch.error}`)
    const dir = cwd ?? process.cwd()

    const proc = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env },
      cwd: dir,
      shell: launch.shell,
    })
    proc.stderr?.on('data', (chunk) => log?.('stderr', String(chunk)))
    proc.on('error', (error) => log?.('error', error))

    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))
    const app = acp.client({ name: 'dsh-acp-client' })
    // 声明零 fs/terminal 能力，Agent 不应回调这些；只应答权限请求。
    app.onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      (permission ?? defaultPermissionDecision)(ctx.params))

    const connection = app.connect(stream)
    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      })
      const session = await connection.agent.buildSession(dir).start()
      return new V1Session({ proc, connection, session, agent })
    } catch (error) {
      connection.close(error)
      proc.kill('SIGTERM')
      throw error
    }
  }

  get sessionId() {
    return this.session.sessionId
  }

  /**
   * 会话声明的可用模型。优先 classic `models.availableModels`，回退到 configOptions 里
   * category/id 为 `model` 的 select 选项。
   * @returns {Array<{id: string, name: string, description?: string}>}
   */
  get models() {
    const response = this.session.newSessionResponse
    const classic = response?.models?.availableModels
    if (Array.isArray(classic) && classic.length > 0) {
      return classic.map((model) => ({
        id: model.modelId,
        name: model.name ?? model.modelId,
        ...(model.description ? { description: model.description } : {}),
      }))
    }
    const option = findModelConfigOption(response?.configOptions)
    return (option?.options ?? []).map((value) => ({
      id: value.value,
      name: value.name ?? value.value,
      ...(value.description ? { description: value.description } : {}),
    }))
  }

  /** 当前模型 id。 */
  get currentModelId() {
    if (this._modelId !== undefined) return this._modelId
    const response = this.session.newSessionResponse
    return response?.models?.currentModelId ?? findModelConfigOption(response?.configOptions)?.currentValue
  }

  /**
   * 选模型：v1 `session/set_config_option`（configId 取 model 选项的 id）。
   * best-effort：agent 不支持时记录错误但不阻断回合。
   * @param {string} modelId
   */
  async setModel(modelId) {
    if (!modelId || modelId === this.currentModelId) return
    const option = findModelConfigOption(this.session.newSessionResponse?.configOptions)
    try {
      const result = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.sessionId,
        configId: option?.id ?? 'model',
        value: modelId,
      })
      this._modelId = modelId
      const updated = findModelConfigOption(result?.configOptions)?.currentValue
      if (typeof updated === 'string') this._modelId = updated
    } catch (error) {
      this._modelSetError = error
    }
  }

  /**
   * 发一次 prompt，逐个 yield sessionUpdate payload（`update` 字段）；回合结束置 stopReason。
   * 若 Agent 崩溃 / 连接关闭，会 throw，由调用方映射为 finish(error)。
   */
  async *prompt(text) {
    this.stopReason = undefined
    this.session.prompt(text)
    for (;;) {
      const message = await this.session.nextUpdate()
      if (message.kind === 'stop') {
        this.stopReason = message.stopReason
        return
      }
      yield message.update
    }
  }

  /** 取消当前回合（对应 DSH 取消）。 */
  cancel() {
    try {
      this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
    } catch {
      // 忽略取消失败；连接关闭会兜底。
    }
  }

  async close() {
    if (this._closed) return
    this._closed = true
    try {
      this.connection.close()
    } finally {
      try { this.session.dispose() } catch { /* 忽略 */ }
      try { this.proc.kill('SIGTERM') } catch { /* 忽略 */ }
    }
  }
}

export default { V1Session, defaultPermissionDecision }
