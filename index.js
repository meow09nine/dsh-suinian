/**
 * dsh-suinian v0.2.0 —— 主动心跳插件（DSH 侧）
 * =====================================================================
 * 让 agent 主动给用户发 QQ 消息：
 *   · 随机时间点（默认 8:00–24:00，分窗口撒点）
 *   · 事件触发（用户长时间不说话 → 主动问候）
 *   · 工具 qq_send（agent 想发就发）
 *
 * 2026-10-28 按一位审计者的建议逐项修复：
 *   · in-flight 标志：唤醒是异步的，前一轮未完成时 tick 早退
 *   · no-session 不再白吃点：先解析目标会话，再标记 fired
 *   · getToken 缓存到 expires_in（提前 60 秒过期）
 *   · state 原子写（tmp + rename）+ 活动事件节流
 *   · 逐窗口构造撒点（避免「先撒后过滤吃掉每窗次数」）
 *   · sentToday 先判后加；过期窗口可配置；日志轮转；时区日志；armed 脱敏
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'suinian'
export const inject = ['sessionController', 'sessions']

const HERE = dirname(fileURLToPath(import.meta.url))
const MINUTE_MS = 60 * 1000
const TOKEN_SAFETY_MS = 60 * 1000

const DEFAULTS = {
  enabled: true,
  /** QQ Bot 凭据（在 profile patch 里配置，勿写死） */
  appId: '',
  appSecret: '',
  /** 接收主动消息的用户的 c2c openid */
  openId: '',
  /** 随机时间窗口（小时，左闭右开） */
  startHour: 8,
  endHour: 24,
  /** 窗口长度（分钟）与每窗口随机次数范围 */
  windowMinutes: 120,
  minPerWindow: 3,
  maxPerWindow: 4,
  /** 全局最小间隔（分钟）——跨窗口也管 */
  minGapMinutes: 21,
  /** 每次唤醒连发几条的范围（注入 prompt 的 {lines}） */
  linesPerPoint: [2, 4],
  /** 过期窗口（分钟）：错过的点超过这个时长不补发 */
  catchupMinutes: 20,
  /** 每日上限 */
  maxPerDay: 40,
  /** 事件触发：用户超过 idleHours 小时没说话 → 主动问候 */
  idleHours: 3,
  idleCooldownMs: 2 * 60 * 60 * 1000,
  maxIdlePerDay: 3,
  /** 只唤醒这个预设的会话；留空 = 任意 */
  wakePreset: '',
  /** 检查间隔（毫秒） */
  checkMs: 60000,
  /** 单次唤醒的超时（毫秒），配合 in-flight 使用 */
  wakeTimeoutMs: 120000,
  /** 演练模式：只记日志、不真发（让用户先看节奏） */
  dryRun: false,
  /** 日志轮转阈值（字节），超过后改名 .old */
  logMaxBytes: 2 * 1024 * 1024,
  logFile: join(HERE, 'logs', 'suinian.log'),
  stateFile: join(HERE, 'logs', 'suinian-state.json'),
  promptText:
    '[heartbeat] 现在是随机时间点。请主动给用户发 QQ 消息：可以连发 {lines} 条（一句一条），' +
    '内容自然、有情绪。只发 QQ 消息，本轮不要写长回复；用 qq_send 工具发送。',
  idlePromptText:
    '[idle] 用户已经好几个小时没来互动了。请主动发 QQ 消息：可以连发 2-3 条（一句一条），' +
    '问候、关心，或者说说自己在做什么。只发 QQ 消息，本轮不要写长回复；用 qq_send 工具发送。',
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  try {
    return applyInner(ctx, config)
  } catch (e) {
    try {
      mkdirSync(dirname(config.logFile), { recursive: true })
      appendFileSync(config.logFile, JSON.stringify({
        ts: new Date().toISOString(),
        ev: 'apply-fail',
        error: String(e && e.message ? e.message : e),
        stack: String(e && e.stack ? e.stack : '').slice(0, 1200),
      }) + '\n', 'utf8')
    } catch { /* 忽略 */ }
    throw e
  }
}

function applyInner(ctx, config) {
  if (!config.enabled) return
  if (!config.appId || !config.appSecret || !config.openId) return

  const abort = new AbortController()

  // ── 日志（带简单轮转）──
  const log = (entry) => {
    try {
      mkdirSync(dirname(config.logFile), { recursive: true })
      try {
        if (existsSync(config.logFile) && statSync(config.logFile).size > Number(config.logMaxBytes || 0)) {
          renameSync(config.logFile, config.logFile + '.old')
        }
      } catch { /* 忽略 */ }
      appendFileSync(config.logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    } catch { /* 审计失败不冒泡 */ }
  }

  // ── 状态（原子写）──
  const loadState = () => {
    try {
      if (!existsSync(config.stateFile)) return null
      return JSON.parse(readFileSync(config.stateFile, 'utf8'))
    } catch { return null }
  }
  const saveState = (st) => {
    try {
      mkdirSync(dirname(config.stateFile), { recursive: true })
      const tmp = config.stateFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
      renameSync(tmp, config.stateFile)
    } catch { /* 忽略 */ }
  }

  const todayKey = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  // ── 撒点：逐窗口构造（审计的量化结论：先撒后过滤会把每窗 3-4 次压到 2.3 次）──
  const pickTimes = () => {
    const times = []
    const win = Math.max(30, Number(config.windowMinutes) || 120)
    const minN = Math.max(1, Number(config.minPerWindow) || 3)
    const maxN = Math.max(minN, Number(config.maxPerWindow) || 4)
    const gap = Math.max(0, Number(config.minGapMinutes) || 0)
    const from = Math.max(0, Number(config.startHour) || 0) * 60
    const to = Math.min(24, Number(config.endHour) || 24) * 60

    let last = from - gap
    for (let start = from; start < to; start += win) {
      const end = Math.min(to, start + win)
      if (end <= start) break
      // 该窗内所有「与上一点间隔 ≥ gap」的候选分钟
      const eligible = []
      for (let m = start; m < end; m += 1) {
        if (m - last >= gap) eligible.push(m)
      }
      if (!eligible.length) continue
      let n = Math.min(minN + Math.floor(Math.random() * (maxN - minN + 1)), eligible.length)
      if (n <= 0) continue
      // 先随机抽，抽不到满足内部间隔的就按步长均匀铺开
      let picked = null
      for (let attempt = 0; attempt < 60 && !picked; attempt += 1) {
        const bag = eligible.slice()
        const candidate = []
        for (let i = 0; i < n; i += 1) candidate.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0])
        candidate.sort((a, b) => a - b)
        if (candidate.every((t, i) => i === 0 || t - candidate[i - 1] >= gap)) picked = candidate
      }
      if (!picked) {
        const stride = n > 1 ? (eligible.length - 1) / (n - 1) : 0
        const uniform = []
        for (let i = 0; i < n; i += 1) uniform.push(eligible[Math.round(i * stride)])
        picked = [...new Set(uniform)].sort((a, b) => a - b)
      }
      for (const t of picked) {
        times.push(t)
        last = Math.max(last, t)
      }
    }
    return times
  }

  // ── 目标会话解析（先解析，再消费点）──
  const resolveTarget = () => {
    const live = ctx.sessions?.list?.() ?? []
    return live.find((s) =>
      (!config.wakePreset || s?.header?.agentPreset === config.wakePreset) && !s?.header?.parentSession
    ) || null
  }

  // ── 状态初始化 ──
  let state = loadState()
  if (!state || state.date !== todayKey()) {
    state = { date: todayKey(), times: pickTimes(), fired: [], sentToday: 0 }
    saveState(state)
    log({ ev: 'plan', date: state.date, points: state.times.length })
  }

  // no-session 日志节流：同一原因 10 分钟内只记一次（否则没会话时每 60 秒一条）
  let lastNoSessionLog = 0
  const logNoSession = (reason, point) => {
    if (Date.now() - lastNoSessionLog < 600000) return
    lastNoSessionLog = Date.now()
    log({ ev: 'no-session', reason, ...(point ? { point } : {}) })
  }

  // ── 事件触发：记录用户最后一次说话（节流：只有时间戳变化才写）──
  let lastUserActivityAt = Number(state.lastUserActivityAt) || Date.now()
  let lastIdleSentAt = Number(state.lastIdleSentAt) || 0
  let lastActivitySaved = lastUserActivityAt
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('api-session/activity', (sessionId, updatedAt) => {
        const ms = Number(updatedAt) || Date.now()
        if (ms === lastActivitySaved) return
        lastUserActivityAt = ms
        lastActivitySaved = ms
        state.lastUserActivityAt = ms
        saveState(state)
      })
    }
  } catch (e) {
    log({ ev: 'event-hook-fail', error: String(e?.message ?? e) })
  }

  // ── QQ 主动发送（token 缓存到 expires_in - 60s）──
  let tokenCache = { token: '', expiresAt: 0 }
  async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token
    const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
    })
    const j = await r.json()
    if (!j.access_token) throw new Error('token failed: ' + JSON.stringify(j).slice(0, 200))
    const ttl = Number(j.expires_in || 7200) * 1000 - TOKEN_SAFETY_MS
    tokenCache = { token: j.access_token, expiresAt: Date.now() + Math.max(60000, ttl) }
    return tokenCache.token
  }

  async function sendQQ(text) {
    if (config.dryRun) {
      log({ ev: 'dry-run', text: String(text).slice(0, 200) })
      return '{"dryRun":true}'
    }
    const token = await getToken()
    const r = await fetch(`https://api.sgroup.qq.com/v2/users/${config.openId}/messages`, {
      method: 'POST',
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(text), msg_type: 0 }),
    })
    const body = await r.text()
    if (!r.ok) {
      // 401/403 可能是 token 过期，清缓存让下次重取
      if (r.status === 401 || r.status === 403) tokenCache = { token: '', expiresAt: 0 }
      throw new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`)
    }
    log({ ev: 'sent', text: String(text).slice(0, 200), ok: true })
    return body
  }

  // ── 工具：agent 想发就发 ──
  const tools = ctx.get?.('tools')
  if (tools?.register) {
    tools.register({
      name: 'qq_send',
      description:
        '主动给用户发一条 QQ 消息（官方 Bot 主动消息）。用于主动找话题、问候、提醒。'
        + '文本简短自然，一般一句到两句。不需要群权限，也不需要对方先发消息。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要发送的文本内容。' } },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, messageId: { type: 'string' } },
          required: ['ok'],
          additionalProperties: false,
        },
        // dsh-tools 要求 output 必须带 render
        render: (_args, value) => [{ type: 'text', text: (value && value.ok) ? '已发送' : '发送失败' }],
      },
      async execute(args) {
        const text = String(args?.text ?? '').trim()
        if (!text) throw new Error('qq_send: text 不能为空')
        const body = await sendQQ(text)
        let messageId = ''
        try { messageId = JSON.parse(body).id ?? '' } catch { /* 忽略 */ }
        return { ok: true, messageId }
      },
    })
  } else {
    log({ ev: 'tools-unavailable' })
  }

  // ── 唤醒（in-flight 保护：代次 + 真 abort）──
  let waking = false
  let wakeGen = 0
  async function wakeOnce(target, text) {
    const gen = ++wakeGen
    waking = true
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), Math.max(10000, Number(config.wakeTimeoutMs) || 120000))
    try {
      await ctx.sessionController.prompt({
        requestId: `suinian-${Date.now()}`,
        sessionId: target.id,
        mode: 'queue',
        content: [{ type: 'text', text: text || config.promptText }],
        clientTimeZone: 'Asia/Shanghai',
      }, ctl.signal)
      log({ ev: 'wake-ok', sessionId: target.id })
    } catch (e) {
      log({ ev: 'wake-fail', error: String(e?.message ?? e), aborted: ctl.signal.aborted })
    } finally {
      clearTimeout(timer)
      // 只清「我还是最新那一轮」的标志——旧轮的 finally 不能清新轮的
      if (gen === wakeGen) waking = false
    }
  }

  const tick = () => {
    try {
      if (waking) { log({ ev: 'skip', reason: 'in-flight' }); return }
      const now = new Date()
      const key = todayKey()
      if (state.date !== key) {
        state = { date: key, times: pickTimes(), fired: [], sentToday: 0 }
        saveState(state)
        log({ ev: 'plan', date: state.date, points: state.times.length })
        return
      }
      const nowMin = now.getHours() * 60 + now.getMinutes()
      if (now.getHours() < config.startHour || now.getHours() >= config.endHour) return

      // ── 事件触发 ──
      const idleMs = Math.max(1, Number(config.idleHours) || 3) * 3600 * 1000
      const idleCooldown = Math.max(60000, Number(config.idleCooldownMs) || 2 * 3600 * 1000)
      const nowMs = now.getTime()
      if (
        nowMs - lastUserActivityAt > idleMs &&
        nowMs - lastIdleSentAt > idleCooldown &&
        (state.idleCount || 0) < Number(config.maxIdlePerDay || 3)
      ) {
        const target = resolveTarget()
        if (!target) { logNoSession('idle'); return }
        state.idleCount = (state.idleCount || 0) + 1
        state.lastIdleSentAt = nowMs
        lastIdleSentAt = nowMs
        saveState(state)
        log({ ev: 'idle-trigger', hours: Math.round((nowMs - lastUserActivityAt) / 3600000) })
        void wakeOnce(target, config.idlePromptText)
        return
      }

      // ── 随机点 ──
      const catchup = Math.max(1, Number(config.catchupMinutes) || 20)
      for (let i = 0; i < state.times.length; i++) {
        if (state.fired.includes(i)) continue
        const t = state.times[i]
        if (nowMin < t) break
        if (nowMin - t > catchup) {
          state.fired.push(i)
          state.voided = (state.voided || 0) + 1
          saveState(state)
          log({ ev: 'voided', point: i + 1, ageMin: nowMin - t })
          continue
        }
        // 先解析会话，解析不到不消费这个点（它自然会过期）
        const target = resolveTarget()
        if (!target) { logNoSession('point', i + 1); return }
        // 先判上限，再加计数
        if (Number(state.sentToday || 0) >= Number(config.maxPerDay || 40)) {
          log({ ev: 'limit-hit' })
          return
        }
        state.fired.push(i)
        // dryRun：只标记 fired（防重复日志），不推进 sentToday，不真唤醒
        if (!config.dryRun) state.sentToday = Number(state.sentToday || 0) + 1
        saveState(state)
        const linesRange = Array.isArray(config.linesPerPoint) ? config.linesPerPoint : [2, 4]
        const lLo = Math.max(1, Number(linesRange[0]) || 2)
        const lHi = Math.max(lLo, Number(linesRange[1]) || 4)
        const lines = lLo + Math.floor(Math.random() * (lHi - lLo + 1))
        if (config.dryRun) {
          log({ ev: 'dry-run', point: i + 1, at: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, lines })
          return
        }
        const rendered = String(config.promptText || '').replaceAll('{lines}', String(lines))
        void wakeOnce(target, rendered)
        return
      }
    } catch (e) {
      log({ ev: 'tick-fail', error: String(e?.message ?? e) })
    }
  }

  const timer = setInterval(tick, Math.max(10000, Number(config.checkMs) || 60000))
  const stop = () => {
    clearInterval(timer)
    try { abort.abort() } catch { /* 忽略 */ }
    log({ ev: 'stopped' })
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => stop)
  else if (typeof ctx.on === 'function') ctx.on('dispose', stop)

  // 启动日志：脱敏 + 时区 + 关键参数自检
  const tzOffset = -new Date().getTimezoneOffset() / 60
  log({
    ev: 'armed',
    appIdTail: String(config.appId).slice(-4),
    openIdLen: String(config.openId).length,
    window: `${config.startHour}-${config.endHour}`,
    perWindow: `${config.minPerWindow}-${config.maxPerWindow}`,
    minGap: config.minGapMinutes,
    catchup: config.catchupMinutes,
    maxPerDay: config.maxPerDay,
    tzOffset,
    dryRun: !!config.dryRun,
    points: state.times.length,
  })
  if (Number(config.minGapMinutes) >= Number(config.windowMinutes)) {
    log({ ev: 'warn', msg: 'minGapMinutes >= windowMinutes：每窗只能放 1 点，minPerWindow 会失效' })
  }
}

export default { name, inject, apply }


