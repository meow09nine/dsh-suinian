#!/usr/bin/env node
/**
 * selfcheck.mjs —— 安装自检（发布版）
 *
 * 检查五件事：
 *   1. 插件模块能 import（导出 name / inject / apply 齐全）
 *   2. cordis.patch.yml 可读，三项必填已填（自动去引号）
 *   3. （可选）目标 profile 的 cordis.patch.yml 里有 id: suinian
 *   4. access_token 能拿到
 *   5. 真发一条测试消息（--dry-run 跳过）
 *
 * 用法：
 *   node selfcheck.mjs                  # 全检 + 真发一条
 *   node selfcheck.mjs --dry-run        # 不真发
 *   DSH_PROFILE_PATCH=C:\path\cordis.patch.yml node selfcheck.mjs   # 额外检查 profile 已挂载
 *
 * 退出码：0 成功 / 1 失败
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, 'cordis.patch.yml')
const dryRun = process.argv.includes('--dry-run')
const profilePatch = process.env.DSH_PROFILE_PATCH || ''

const ok = (msg) => console.log('✅ ' + msg)
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1) }

// ── 1. 模块导入检查 ──
async function checkModule() {
  let mod
  try {
    mod = await import(new URL('./index.js', import.meta.url).href)
  } catch (e) {
    fail(`插件模块导入失败: ${e.message}`)
  }
  for (const key of ['name', 'inject', 'apply']) {
    if (!(key in mod)) fail(`插件模块缺少导出: ${key}`)
  }
  if (mod.name !== 'suinian') fail(`插件 name 应为 'suinian'，实际 '${mod.name}'`)
  ok(`插件模块 OK（name=${mod.name}, inject=${JSON.stringify(mod.inject)}）`)
}

// ── 2. 配置检查（去引号）──
function unquote(v) {
  const s = String(v).trim()
  return s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))
    ? s.slice(1, -1)
    : s
}

function readConfig() {
  if (!existsSync(PATCH)) fail(`找不到配置文件: ${PATCH}`)
  const src = readFileSync(PATCH, 'utf8')
  const pick = (key) => {
    const m = src.match(new RegExp(`${key}:\\s*['"]?([^'"\\n#]+)['"]?`))
    return m ? unquote(m[1]) : ''
  }
  const cfg = { appId: pick('appId'), appSecret: pick('appSecret'), openId: pick('openId') }
  for (const [k, v] of Object.entries(cfg)) {
    if (!v || v.startsWith('YOUR_')) fail(`配置项 ${k} 还没填（当前值: ${v || '空'}）`)
  }
  ok(`配置完整（appId=${cfg.appId}, openId 前 8 位=${cfg.openId.slice(0, 8)}…）`)
  return cfg
}

// ── 3. profile 挂载检查（可选）──
function checkProfilePatch() {
  if (!profilePatch) {
    console.log('ℹ️  跳过 profile 挂载检查（设置 DSH_PROFILE_PATCH 可启用）')
    return
  }
  if (!existsSync(profilePatch)) fail(`profile patch 不存在: ${profilePatch}`)
  const src = readFileSync(profilePatch, 'utf8')
  if (!/id:\s*suinian\b/.test(src)) {
    fail('profile patch 里没有 id: suinian —— 插件不会被加载。请把本目录 cordis.patch.yml 的 - insert: 段并入，或用 install_bundle 安装')
  }
  ok('profile patch 里已挂载 id: suinian')
}

// ── 4/5. token + 发送 ──
async function getToken(appId, appSecret) {
  const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  })
  const j = await r.json()
  if (!j.access_token) fail('拿不到 access_token: ' + JSON.stringify(j).slice(0, 300))
  return j.access_token
}

async function sendTest(token, openId) {
  const r = await fetch(`https://api.sgroup.qq.com/v2/users/${openId}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'selfcheck: 插件安装成功，这条消息来自你的 QQ Bot', msg_type: 0 }),
  })
  const body = await r.text()
  if (!r.ok) fail(`发送失败 HTTP ${r.status}: ${body.slice(0, 300)}`)
  ok('测试消息已发送——请检查 QQ 是否收到')
}

await checkModule()
const cfg = readConfig()
checkProfilePatch()
const token = await getToken(cfg.appId, cfg.appSecret)
ok(`access_token 获取成功（长度 ${token.length}）`)
if (dryRun) {
  ok('dry-run：全部检查通过，未发送消息')
  process.exit(0)
}
await sendTest(token, cfg.openId)
