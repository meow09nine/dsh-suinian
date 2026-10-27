# dsh-suinian（碎念）

**版本 v0.2.0** · MIT License · 作者：上若拾梦（Finnley_evokia）

让 DSH agent **主动**给用户发 QQ 消息：随机时间点心跳、长时间未互动问候、随时想发就发。

基于 QQ 官方 Bot 主动消息 API（私聊额度 1000 条/天/用户），**不需要**第三方协议（NapCat/SnowLuma）。

> ⚠ **两套宿主、两套实现，不通用**：
> 本包是 **DSH（DeepSeek Harness / Cordis）** 插件；另有一个同名的 OpenClaw 版
> `suinian-heartbeat`，两者宿主不同、代码不同、配置不通用。装错宿主不会起作用。

---

## 依赖

- DSH 0.2.x（Cordis 插件宿主）
- 一个 QQ 官方 Bot（QQ 开放平台注册）
- 一个已接入该 bot 的 DSH profile（如通过 `@tencent-connect/dsh-qqbot`）

## 安装（按顺序）

1. 解压到任意目录。
2. **填配置**（二选一）：
   - **交互式向导**：`node setup.mjs`（逐项问 AppID/AppSecret/openid 和发送节奏，自动生成配置）
   - **手动**：编辑本目录的 `cordis.patch.yml`，把 `YOUR_APPID` / `YOUR_APPSECRET` /
     `YOUR_C2C_OPENID` 换成你的值（见下面「配置」）
3. **自检**（强烈建议，先确认能发再装）：

   ```bash
   node selfcheck.mjs --dry-run   # 只校验配置 + 拿 token，不发消息
   node selfcheck.mjs             # 真发一条测试消息，检查 QQ 是否收到
   ```

4. **装进 DSH**：
   - 方式一（推荐）：用 DSH 的**插件管理器**安装本目录（`install_bundle`）。
   - 方式二（手动）：把本目录放到目标 profile 的 `node_modules/dsh-suinian/`，
     再把 `- insert:` 那段并入 profile 的 `cordis.patch.yml`，最后重启 DSH。

> ⚠ `cordis.patch.yml` 里的新行必须用 `- insert:` 包裹——写 `- id:` 是「覆盖已存在的行」，
> 新行不存在会被跳过（插件不会加载）。

## 配置

必填三项（在 `cordis.patch.yml` 的 `config` 里）：

| 字段 | 含义 |
|---|---|
| `appId` | QQ 机器人 AppID |
| `appSecret` | QQ 机器人 AppSecret |
| `openId` | 接收主动消息的用户的 **c2c openid** |

> 怎么拿 openId：让用户先私聊 bot 一条消息，bot 收到的 `author.id` / 会话 targetId 就是它。

可选：

| 字段 | 默认 | 含义 |
|---|---|---|
| `startHour` / `endHour` | 8 / 24 | 随机时间窗口 |
| `windowMinutes` | 120 | 窗口长度（分钟） |
| `minPerWindow` / `maxPerWindow` | 3 / 4 | 每窗口随机次数 |
| `minGapMinutes` | 21 | **全局最小间隔**（跨窗口也管，防连发） |
| `linesPerPoint` | [2, 4] | **每次唤醒连发几条**（注入 prompt 的 `{lines}`） |
| `catchupMinutes` | 20 | **过期窗口**：错过的点超过这个时长不补发 |
| `maxPerDay` | 40 | 每日上限 |
| `idleHours` | 3 | 用户多久不说话触发问候 |
| `idleCooldownMs` | 7200000 | 问候冷却 |
| `maxIdlePerDay` | 3 | 每日问候上限 |
| `wakePreset` | `''` | 唤醒哪个预设会话，空 = 任意 |
| `wakeTimeoutMs` | 120000 | 单次唤醒超时（配合 in-flight 保护） |
| `dryRun` | false | **演练模式**：只记日志、不真发（每天每条只记一次 dry-run） |
| `logMaxBytes` | 2097152 | 日志轮转阈值（超过后改名 `.old`） |
| `checkMs` | 60000 | 检查间隔（毫秒） |
| `logFile` / `stateFile` | 插件目录 `logs/` | 日志/状态文件路径 |
| `promptText` / `idlePromptText` | 内置 | 自定义唤醒提示词（支持 `{lines}` 占位） |

> 日志和状态默认在**插件目录**的 `logs/` 下（`suinian.log` / `suinian-state.json`），
> 可用 `logFile` / `stateFile` 改到别处。

## 建议的启用顺序

1. `dryRun: true` 跑一两天 → 看日志里的 `dry-run` 节奏是否合适（每天每条只记一次）
2. 觉得可以了再关掉 dryRun 正式发
3. 首日观察 `suinian.log` 里的 `plan` / `woke` / `sent` / `voided` 记录

## 能力

- **工具 `qq_send(text)`**：agent 在任何会话里都能主动发一条消息
- **随机心跳**：每天 8:00–24:00 分窗口随机，到点唤醒 agent 生成内容
- **事件触发**：用户超过 `idleHours` 没说话 → 主动问候（带冷却与日上限）
- **审计日志**：`<插件目录>/logs/suinian.log`，记录每次发送/唤醒/计划

## 工作方式

```
定时器到点 → 唤醒 agent 会话（sessionController.prompt）
          → agent 生成内容 → 调用 qq_send 工具
          → POST https://api.sgroup.qq.com/v2/users/{openId}/messages
```

## 注意

- 主动消息额度：1000 条/天/用户、20 条/分钟
- 群聊：官方 bot 群聊只能 @ 触发（「接收所有消息」权限个人开发者通常没有）
- 过期时间点不补发（避免重启后轰炸）
- 无人值守时不会乱发：每窗口有次数上限、每日有上限
- 日志/状态文件默认在插件内 `logs/`，可配置到别处




