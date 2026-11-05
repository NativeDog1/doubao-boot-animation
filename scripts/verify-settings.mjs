/**
 * verify-settings.mjs — 设置面板的服务端行为，不开浏览器。
 *
 * 为什么要有这个：设置是"用户唯一能改片头的地方"，它的失败是**沉默**的——
 * 选中了但没写进 config.json、写了但注入器读的是别的字段、面板列出来的文件和
 * 实际能播的不一致。这些都不会报错，只会让用户觉得"选了没用"。
 *
 * 这里对真实服务做真实请求：状态、选用、随机、音量/静音/铺满/跳过开关、无 token 被拒、目录外文件被拒，
 * 每一步都回读 config.json 确认落地。
 *
 * 用法：node scripts/verify-settings.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用临时 config，别动用户真正的选择
const tmp = mkdtempSync(join(tmpdir(), 'dba-settings-'))
const configPath = join(tmp, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify({ clipsDir: 'clips', selected: 'boot-short.mp4', random: true, muted: false, volume: 0.5 }, null, 2),
)

const child = spawn(process.execPath, [join(ROOT, 'bin', 'settings.mjs'), '--no-open', '--config', configPath], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
child.stdout.on('data', (chunk) => {
  stdout += String(chunk)
})

const url = await (async () => {
  for (let i = 0; i < 100; i++) {
    const match = /SETTINGS_URL=(\S+)/.exec(stdout)
    if (match !== null) return match[1]
    await sleep(100)
  }
  return null
})()

if (url === null) {
  console.error('片库服务没有起来')
  console.error(stdout)
  child.kill()
  process.exit(2)
}

const base = new URL(url)
const token = base.searchParams.get('t')
const api = (path) => new URL(path + (path.includes('?') ? '&' : '?') + 't=' + token, base).toString()
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'))

try {
  check(typeof token === 'string' && token.length > 20, '面板带一次性 token')

  const noToken = await fetch(new URL('/api/state', base))
  check(noToken.status === 403, '不带 token 的请求被拒', String(noToken.status))

  const state = await (await fetch(api('/api/state'))).json()
  const files = state.state.clips.map((clip) => clip.file)
  check(files.includes('boot-full.mp4') && files.includes('boot-short.mp4'), '片库列出 clips/ 里的所有片头', files.join(', '))
  check(state.state.clips.some((clip) => clip.name === '完整版 · 8 秒'), 'clips.json 的展示名生效')
  check(state.state.random === true, '读到了配置里的 random')
  check(state.state.selected === 'boot-short.mp4', '读到了配置里的 selected')

  const selected = await (
    await fetch(api('/api/select'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'boot-full.mp4' }),
    })
  ).json()
  check(selected.ok === true, '选用成功')
  check(selected.turnedOffRandom === true, '明确选用会关掉随机（否则"选了没反应"）')
  check(readConfig().selected === 'boot-full.mp4', 'config.json 里 selected 已落盘')
  check(readConfig().random === false, 'config.json 里 random 已关')

  const bad = await fetch(api('/api/select'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: '../../../config.json' }),
  })
  check(bad.status === 400, '目录外的文件被拒', String(bad.status))

  const settings = await (
    await fetch(api('/api/settings'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ random: true, muted: true, volume: 3 }),
    })
  ).json()
  check(settings.ok === true, '设置保存成功')
  check(readConfig().random === true && readConfig().muted === true, 'random / muted 已落盘')
  check(readConfig().volume === 1, '音量被夹到 0~1', String(readConfig().volume))

  const skip = await (
    await fetch(api('/api/settings'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skipButton: false, skipOnClick: false, skipOnEscape: true, fit: 'contain' }),
    })
  ).json()
  check(skip.ok === true, '跳过方式 / 铺满方式保存成功')
  check(readConfig().skipButton === false && readConfig().skipOnClick === false, 'skip 开关已落盘')
  check(readConfig().skipOnEscape === true, 'skipOnEscape 保持为 true')
  check(readConfig().fit === 'contain', 'fit 已落盘', String(readConfig().fit))
  check(skip.state.skipButton === false && skip.state.fit === 'contain', '保存后的状态立刻回显给面板')

  const page = await (await fetch(url)).text()
  check(page.includes('设置') && page.includes('boot-full.mp4'), '面板 HTML 带上了状态', page.length + ' bytes')

  const media = await fetch(api('/media/boot-short.mp4'), { headers: { range: 'bytes=0-1023' } })
  check(media.status === 206, '预览走 Range（206）', String(media.status))

  await fetch(api('/api/quit'), { method: 'POST' }).catch(() => {})
} finally {
  child.kill()
  rmSync(tmp, { recursive: true, force: true })
}

console.log('')
if (failures.length === 0) {
  console.log('all settings checks passed')
  process.exit(0)
}
console.log(`${failures.length} settings check(s) failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
