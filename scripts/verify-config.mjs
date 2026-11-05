/**
 * `config.json` 字段收敛的断言。
 *
 * 为什么值得单独测：README 明确写了"直接编辑 config.json 同样有效"，那就一定会有人
 * 把 `"volume": "0.6"`、`"handoffMs": null`、`"fit": "stretch"` 写进去。这些值以前会
 * 一路走进页面，变成 `video.volume = NaN`（没声音）和 `setInterval(fn, NaN)`（0ms 紧循环），
 * 症状是"片头怪怪的"，但没有任何一处报错。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, normalizeConfig, readConfig } from '../bin/config.mjs'

const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

console.log('normalizeConfig：手改坏的值要退回默认，而不是把行为搞怪')

// 数字：字符串数字应当被接受，垃圾应当退回默认
check(normalizeConfig({ volume: '0.6' }).volume === 0.6, '字符串数字 "0.6" 被接受为 0.6', String(normalizeConfig({ volume: '0.6' }).volume))
check(normalizeConfig({ volume: 'abc' }).volume === DEFAULTS.volume, '非数字字符串退回默认音量')
check(normalizeConfig({ volume: null }).volume === DEFAULTS.volume, 'null 退回默认音量')
check(normalizeConfig({ volume: 3 }).volume === 1, '音量上限夹到 1', String(normalizeConfig({ volume: 3 }).volume))
check(normalizeConfig({ volume: -1 }).volume === 0, '音量下限夹到 0', String(normalizeConfig({ volume: -1 }).volume))

// handoffMs 是关键：NaN 会让退场计时变成 0ms 紧循环
check(normalizeConfig({ handoffMs: null }).handoffMs === DEFAULTS.handoffMs, 'handoffMs 为 null 退回默认')
check(normalizeConfig({ handoffMs: -50 }).handoffMs === 0, '负的 handoffMs 夹到 0', String(normalizeConfig({ handoffMs: -50 }).handoffMs))
check(normalizeConfig({ handoffMs: 99999 }).handoffMs === 5000, '过大的 handoffMs 夹到 5000', String(normalizeConfig({ handoffMs: 99999 }).handoffMs))
check(Number.isFinite(normalizeConfig({ handoffMs: 'abc' }).handoffMs), 'handoffMs 是坏值时仍然有限（不会 setTimeout NaN）')

check(normalizeConfig({ firstFrameMs: 10 }).firstFrameMs === 500, 'firstFrameMs 有下限 500ms', String(normalizeConfig({ firstFrameMs: 10 }).firstFrameMs))
check(normalizeConfig({ waitForWindowMs: 0 }).waitForWindowMs === 1000, 'waitForWindowMs 有下限 1000ms', String(normalizeConfig({ waitForWindowMs: 0 }).waitForWindowMs))
check(normalizeConfig({ maxVideoMB: 0 }).maxVideoMB === 1, 'maxVideoMB 有下限 1MB', String(normalizeConfig({ maxVideoMB: 0 }).maxVideoMB))

// 枚举与布尔
check(normalizeConfig({ fit: 'stretch' }).fit === 'cover', '未知的 fit 退回 cover', String(normalizeConfig({ fit: 'stretch' }).fit))
check(normalizeConfig({ fit: 'contain' }).fit === 'contain', 'fit=contain 保持')
check(normalizeConfig({ muted: true }).muted === true, 'muted=true 保持')
check(normalizeConfig({ muted: 'true' }).muted === false, 'muted 只认真正的 true（避免误判成静音）')
check(normalizeConfig({ skipButton: undefined }).skipButton === true, 'skipButton 缺省是开')
check(normalizeConfig({ skipButton: false }).skipButton === false, 'skipButton=false 保持关闭')
check(normalizeConfig({ autoplayWithSound: false }).autoplayWithSound === false, 'autoplayWithSound=false 保持')

// 字符串字段
check(normalizeConfig({ clipsDir: 123 }).clipsDir === DEFAULTS.clipsDir, 'clipsDir 不是字符串时退回默认')
check(normalizeConfig({ clipsDir: '' }).clipsDir === DEFAULTS.clipsDir, 'clipsDir 为空时退回默认')
check(normalizeConfig({ video: null }).video === '', 'video 为 null 时退回空串')

// 不抛
let threw = null
for (const input of [{}, null, undefined, [], 'x', { volume: {} }, { handoffMs: [] }]) {
  try {
    normalizeConfig(input ?? {})
  } catch (error) {
    threw = String(error?.message ?? error)
  }
}
check(threw === null, '各种垃圾输入都不抛异常', String(threw))

// readConfig 也走同一套收敛，并且坏 JSON 会给出能读懂的报错
const dir = mkdtempSync(join(tmpdir(), 'dba-cfg-'))
const bad = join(dir, 'broken.json')
writeFileSync(bad, '{ "volume": ', 'utf8')
let message = ''
try {
  readConfig(bad)
} catch (error) {
  message = String(error?.message ?? error)
}
check(/配置文件读不了/.test(message), '坏 JSON 的报错是人话（带文件路径）', message.slice(0, 60))

const good = join(dir, 'good.json')
mkdirSync(dir, { recursive: true })
writeFileSync(good, JSON.stringify({ volume: '0.4', fit: 'nope', handoffMs: null }), 'utf8')
const { config } = readConfig(good)
check(config.volume === 0.4 && config.fit === 'cover' && config.handoffMs === DEFAULTS.handoffMs, 'readConfig 读出来的已经是收敛过的值', JSON.stringify({ v: config.volume, fit: config.fit, h: config.handoffMs }))
rmSync(dir, { recursive: true, force: true })
void readFileSync

console.log('')
if (failures.length === 0) {
  console.log('all config checks passed')
  process.exit(0)
}
console.log(`${failures.length} config check(s) failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
