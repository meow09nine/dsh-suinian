#!/usr/bin/env node
/**
 * setup.mjs —— 安装向导：交互式填写配置，写回 cordis.patch.yml。
 *
 * 用法：
 *   node setup.mjs
 *
 * 流程：逐项询问（必填项必须填，可选项给默认值）→ 生成 cordis.patch.yml
 */
import { createInterface } from 'node:readline/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, 'cordis.patch.yml')

function readCurrent() {
  if (!existsSync(PATCH)) return {}
  const src = readFileSync(PATCH, 'utf8')
  const pick = (key) => {
    const m = src.match(new RegExp(key + ":\\s*'?([^'\\n#]+)'?"))
    const v = m ? m[1].trim() : ''
    return v.startsWith('YOUR_') ? '' : v
  }
  return {
    appId: pick('appId'),
    appSecret: pick('appSecret'),
    openId: pick('openId'),
    startHour: pick('startHour'),
    endHour: pick('endHour'),
    minPerWindow: pick('minPerWindow'),
    maxPerWindow: pick('maxPerWindow'),
    idleHours: pick('idleHours'),
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const cur = readCurrent()

async function ask(prompt, def) {
  const suffix = def !== undefined && def !== '' ? ` [${def}]` : ''
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim()
  return answer || (def !== undefined ? def : '')
}

async function askRequired(prompt, def) {
  for (;;) {
    const v = await ask(prompt, def)
    if (v) return v
    console.log('  ⚠ 这一项必填，不能为空。')
  }
}

async function askNumber(prompt, def) {
  for (;;) {
    const v = await ask(prompt, def)
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
    console.log('  ⚠ 请输入大于 0 的数字。')
  }
}

console.log('\n=== 碎念 suinian 安装向导 ===\n')
console.log('必填三项：QQ 机器人 AppID / AppSecret / 你的 c2c openid')
console.log('（没拿到 openid？先私聊 bot 一条消息，从收到的消息里取）\n')

const appId = await askRequired('AppID', cur.appId)
const appSecret = await askRequired('AppSecret', cur.appSecret)
const openId = await askRequired('你的 c2c openid（32 位十六进制）', cur.openId)

console.log('\n--- 可选：发送节奏（直接回车用默认）---')
const startHour = await askNumber('几点开始（小时，默认 8）', cur.startHour || '8')
const endHour = await askNumber('几点结束（小时，默认 24）', cur.endHour || '24')
const minPerWindow = await askNumber('每 2 小时窗口最少几次', cur.minPerWindow || '3')
const maxPerWindow = await askNumber('每 2 小时窗口最多几次', cur.maxPerWindow || '4')
const idleHours = await askNumber('用户多久不说话触发问候（小时，默认 3）', cur.idleHours || '3')

await rl.close()

const patch = `# 碎念 suinian —— agent 主动给用户发 QQ 消息
#
# 本文件由 setup.mjs 生成。三项必填：
#   appId / appSecret：QQ 开放平台机器人凭据
#   openId：接收主动消息的用户的 c2c openid
#
# ⚠ 格式：新行必须用 \`- insert:\` 包裹。
- insert:
    - id: suinian
      name: 'dsh-suinian'
      config:
        appId: '${appId}'
        appSecret: '${appSecret}'
        openId: '${openId}'
        # 随机时间窗口（小时）
        startHour: ${startHour}
        endHour: ${endHour}
        # 每 2 小时窗口随机 ${minPerWindow}-${maxPerWindow} 次
        windowMinutes: 120
        minPerWindow: ${minPerWindow}
        maxPerWindow: ${maxPerWindow}
        # 全局最小间隔（分钟）：跨窗口也管，防连发
        minGapMinutes: 21
        # 每次唤醒连发几条（注入 prompt 的 {lines}）
        linesPerPoint: [2, 4]
        # 过期窗口（分钟）：错过的点不补发
        catchupMinutes: 20
        maxPerDay: 40
        # 事件触发：用户超过 idleHours 小时没说话 → 主动问候
        idleHours: ${idleHours}
        idleCooldownMs: 7200000
        maxIdlePerDay: 3
        checkMs: 60000
`

writeFileSync(PATCH, patch, 'utf8')
console.log(`\n✅ 配置已写入: ${PATCH}`)
console.log('下一步：node selfcheck.mjs --dry-run（验证配置）→ node selfcheck.mjs（发测试消息）')
