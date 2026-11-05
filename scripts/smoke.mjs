/**
 * 端到端自检：真的启动一次豆包，注入，截一张图，等它自己交接完，再关掉。
 *
 * 为什么要有这个脚本：注入链路里每一步都可能"看起来成功"——
 * 页面目标选错、视频没播起来、浮层没铺满、播完没拆掉。只有把真窗口跑一遍、
 * 量到「浮层出现过」「N 秒内自己消失」「注入器 exit 0」，才算数。
 *
 * 前置：豆包**没有**在运行（脚本会自己启动并关闭它）。
 * 用法：npm run smoke [-- --keep-open]
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'scripts', '.out')
const KEEP_OPEN = process.argv.includes('--keep-open')
const PORT = 9400 + (process.pid % 100)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures += 1
}

function tasklist() {
  return new Promise((resolvePromise) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Doubao.exe', '/NH'], { windowsHide: true }, (error, stdout) =>
      resolvePromise(error ? '' : String(stdout)),
    )
  })
}

async function fetchJson(path, timeoutMs = 1500) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function waitFor(fn, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* 还没就绪 */
    }
    await sleep(stepMs)
  }
  return null
}

class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((ok, bad) => {
      socket.onopen = ok
      socket.onerror = () => bad(new Error('CDP connect failed'))
    })
    return new Cdp(socket)
  }
  constructor(socket) {
    this.socket = socket
    this.id = 0
    this.pending = new Map()
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === undefined) return
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result)
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((ok, bad) => {
      this.pending.set(id, { resolve: ok, reject: bad })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try {
      this.socket.close()
    } catch {}
  }
}

console.log('豆包开机动画 · 端到端自检\n')

if (/Doubao\.exe/i.test(await tasklist())) {
  console.error('豆包正在运行。请先从托盘退出豆包，再跑这个自检（它要自己启动一次）。')
  process.exit(2)
}

const exe = join(process.env.LOCALAPPDATA ?? '', 'Doubao', 'Application', 'Doubao.exe')
// 和 bin/inject.mjs 用同一组启动参数：调试端口 + 允许带声音自动播放。
// 否则自检会在"没有 --autoplay-policy"的豆包里跑，声音必然被拦，测到的不是真实行为。
const launcher = spawn(
  exe,
  [
    `--remote-debugging-port=${PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--autoplay-policy=no-user-gesture-required',
  ],
  {
    cwd: dirname(exe),
    detached: true,
    stdio: 'ignore',
  },
)
launcher.unref()

let cdp = null
let injector = null
try {
  const version = await waitFor(() => fetchJson('/json/version'), 20000)
  check(version !== null, '调试端点就绪', version ? version.Browser : '超时')

  const page = await waitFor(async () => {
    const targets = await fetchJson('/json/list')
    return targets.find((t) => t.type === 'page' && /doubao-chat/i.test(t.url)) ?? null
  }, 15000)
  check(page !== null, '找到主窗口页面目标', page ? page.url : '超时')

  cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')

  const started = Date.now()
  injector = spawn(process.execPath, [join(ROOT, 'bin', 'inject.mjs'), '--no-launch', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: 'inherit',
  })

  const appeared = await waitFor(
    async () => {
      const result = await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const root = document.getElementById('dba-root')
          if (!root) return null
          const rect = root.getBoundingClientRect()
          return { full: rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1 }
        })()`,
      })
      return result.result?.value ?? null
    },
    12000,
    100,
  )
  check(appeared !== null, '浮层出现', appeared ? '' : '12s 内没有注入')
  if (appeared) {
    check(appeared.full, '浮层铺满窗口', JSON.stringify(appeared))

    const chrome = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `JSON.stringify({
        skip: !!document.getElementById('dba-skip'),
        actions: !!document.getElementById('dba-actions'),
        noisy: document.querySelectorAll('#dba-actions button').length,
      })`,
    })
    const buttons = JSON.parse(chrome.result.value)
    check(buttons.actions, '右下角按钮组存在（豆包赢窗口按钮在右上角）')
    check(buttons.skip, '「跳过」可用')
    check(buttons.noisy === 1, '片头画面上只有「跳过」一个控件（设置不塞在这里）', `${String(buttons.noisy)} 个`)

    // 出现 ≠ 出画面：等真正的首帧（readyState >= HAVE_CURRENT_DATA 且没暂停）。
    const firstFrame = await waitFor(
      async () => {
        const result = await cdp.send('Runtime.evaluate', {
          returnByValue: true,
          expression: `(() => {
            const video = document.getElementById('dba-video')
            if (!video) return null
            return video.readyState >= 2 && !video.paused
              ? {
                  size: [video.videoWidth, video.videoHeight],
                  t: Math.round(video.currentTime * 100) / 100,
                  muted: video.muted,
                  volume: Math.round(video.volume * 100) / 100,
                  policy: navigator.getAutoplayPolicy ? navigator.getAutoplayPolicy('mediaelement') : 'n/a',
                }
              : null
          })()`,
        })
        return result.result?.value ?? null
      },
      9000,
      100,
    )
    check(firstFrame !== null, '出现首帧（真在播）', firstFrame ? JSON.stringify(firstFrame) : '9s 内没有首帧')
    if (firstFrame !== null) {
      // 0.2.0 起片头默认带声音：这一条是"加了声音"的验收，不是附加项。
      check(firstFrame.muted === false, '有声播放（不是静音）', JSON.stringify(firstFrame))
      check(firstFrame.volume > 0, '音量大于 0', String(firstFrame.volume))
      if (firstFrame.policy !== 'n/a') {
        check(firstFrame.policy === 'allowed', '自动播放策略允许出声', String(firstFrame.policy))
      }
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(OUT, { recursive: true })
    const shotPath = join(OUT, 'smoke-playing.png')
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    console.log(`       截图：${shotPath}`)
  }

  const exitCode = await new Promise((ok) => {
    const timer = setTimeout(() => ok('timeout'), 30000)
    injector.on('exit', (code) => {
      clearTimeout(timer)
      ok(code)
    })
  })
  check(exitCode === 0, '注入器正常退出', `exit=${String(exitCode)}`)

  const cleaned = await waitFor(async () => {
    const result = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `document.getElementById('dba-root') === null && document.getElementById('doubao-boot-animation-style') === null`,
    })
    return result.result?.value === true
  }, 5000)
  check(cleaned, '浮层与样式已清理')
  console.log(`\n  片头总耗时：${Math.round((Date.now() - started) / 100) / 10}s`)
} catch (error) {
  check(false, '自检过程中抛错', String(error?.message ?? error))
} finally {
  cdp?.close()
  if (!KEEP_OPEN) {
    await new Promise((ok) =>
      execFile('taskkill', ['/IM', 'Doubao.exe', '/F'], { windowsHide: true }, () => ok()),
    )
    console.log('  已关闭自检启动的豆包实例')
  } else {
    console.log('  --keep-open：豆包保持打开')
  }
}

console.log('')
if (failures === 0) {
  console.log('自检通过')
  process.exit(0)
}
console.log(`${failures} 项失败`)
process.exit(1)
