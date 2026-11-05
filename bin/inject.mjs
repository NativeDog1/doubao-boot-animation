#!/usr/bin/env node
/**
 * 豆包开机动画 —— 注入器
 *
 * 豆包桌面端是**自绘 Chromium 壳**（Doubao.exe + Doubao.dll，Chromium 147），
 * 页面是 `chrome://doubao-chat/chat`（React，`#root`），没有 app.asar、没有插件系统。
 * 所以这里不是"往豆包里装插件"，而是：
 *
 *   1. 用 `--remote-debugging-port` 正常启动豆包（只在 127.0.0.1 上监听）；
 *   2. 从 DevTools 协议拿到主窗口的页面目标；
 *   3. 在页面里挂一个全窗口浮层播放片头，播完"虚化淡出"，让应用从模糊里浮出来；
 *   4. 拆掉浮层、关掉本地视频服务、退出 —— 豆包保持运行，动画之外什么都不碰。
 *
 * 设计上的硬约束（每一条都对应一个真实的坑，见 docs/ARCHITECTURE.md）：
 *
 * - **绝不阻塞豆包启动**：先让豆包起来，动画是"附加效果"。任何一步失败只记日志，
 *   不杀进程、不改文件、不拖住用户。
 * - **绝不改豆包的安装目录**：不写 app.asar、不碰签名、不注册 shell 扩展。
 * - **视频只从 127.0.0.1 的一次性端口提供**，动画结束立即关闭；不联网、不上传。
 * - **单实例**：豆包已在运行时加调试端口不会生效（Chromium 单实例会转交给已有进程），
 *   所以先检测，宁可明确提示也不要"启动了但没动画"。
 */
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_NAME = '豆包开机动画'
const LOG_DIR = join(process.env.LOCALAPPDATA ?? homedir(), 'DoubaoBootAnimation', 'logs')
const LOG_FILE = join(LOG_DIR, 'latest.log')

/** 默认配置；`config.json` 里的同名字段覆盖这里。 */
const DEFAULTS = {
  /** 片头视频，相对项目根目录（也可以用绝对路径）。 */
  video: 'assets/boot.mp4',
  /** `cover` 铺满裁切；`contain` 完整显示、留黑边。 */
  fit: 'cover',
  /** 静音播放。0.2.0 起**默认带声音**；想安静就把这里改成 true。 */
  muted: false,
  /** 音量，0~1。 */
  volume: 1,
  /**
   * 让豆包以「不需要用户手势也能出声」的策略启动。
   *
   * 刚启动的浏览器没有任何用户手势，Chromium 的自动播放策略本来会拦掉带声音的
   * 播放；这个启动标志把它关掉。不想改启动参数就设为 false（片头会退回静音）。
   */
  autoplayWithSound: true,
  /** 右下角「跳过」按钮。豆包的窗口按钮画在页面右上角，所以这里必须避开右上。 */
  skipButton: true,
  /** 点击画面任意处跳过。 */
  skipOnClick: true,
  /** Esc 跳过。 */
  skipOnEscape: true,
  /** 退场过渡时长（毫秒），比 CSS 的 460ms 略长，避免把过渡切断。 */
  handoffMs: 520,
  /** 等窗口可见的上限；超时就不播（比在最小化窗口里空放一遍好）。 */
  waitForWindowMs: 15000,
  /** 片头开始后，等待首帧的上限；超时就当作失败、直接交接。 */
  firstFrameMs: 8000,
  /** 内联视频的上限。超过就拒绝并提示压缩——开机动画不该有几十 MB。 */
  maxVideoMB: 30,
  /** 指定豆包主程序；留空则自动找。 */
  doubaoPath: '',
}

const args = new Set(process.argv.slice(2))
const NO_LAUNCH = args.has('--no-launch')
/** 自动化/自检用：失败时不弹系统消息框，只写日志。 */
const QUIET = args.has('--quiet')
const CONFIG_ARG = process.argv.indexOf('--config')
const PORT_ARG = process.argv.indexOf('--port')

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  console.log(line)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG_FILE, stamped + '\n', 'utf8')
  } catch {
    /* 日志写不了不是失败条件 */
  }
}

/** 用系统消息框告知用户——从 .vbs 启动时没有控制台，只有这个能看见。 */
function messageBox(text, title = APP_NAME) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${quote(text)}, ${quote(title)}) | Out-Null`
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore',
    }).unref()
  } catch {
    /* 没有 powershell 就只剩日志 */
  }
}

function die(message, code = 1, hint = '') {
  log(`✗ ${message}`)
  if (hint !== '') log(`  ${hint}`)
  if (!QUIET) messageBox(hint === '' ? message : `${message}\n\n${hint}`)
  process.exit(code)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadConfig() {
  const file = CONFIG_ARG >= 0 ? resolve(process.argv[CONFIG_ARG + 1] ?? '') : join(ROOT, 'config.json')
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      die(`配置文件读不了：${file}`, 2, String(error))
    }
  }
  const config = { ...DEFAULTS, ...fromFile }
  config.videoPath = resolve(ROOT, config.video)
  if (!existsSync(config.videoPath)) {
    die(`找不到片头视频：${config.videoPath}`, 2, '把 mp4 放到 assets/boot.mp4，或在 config.json 里改 video。')
  }
  if (statSync(config.videoPath).size === 0) die(`片头视频是空文件：${config.videoPath}`, 2)

  // 视频是**内联**进页面的（见 overlayScript），所以体积直接决定注入耗时与内存。
  // 这不是技术上限，是体验上限：开机动画应该是"秒开"，不是"等两秒才动"。
  const bytes = statSync(config.videoPath).size
  const limitMB = Math.max(1, Number(config.maxVideoMB) || 30)
  if (bytes > limitMB * 1024 * 1024) {
    die(
      `片头视频太大：${(bytes / 1024 / 1024).toFixed(1)} MB，上限 ${String(limitMB)} MB。`,
      2,
      '开机动画建议压到 10MB 以内；一行命令：\n' +
        `ffmpeg -i "输入.mp4" -c:v libx264 -crf 22 -preset medium -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 96k "assets/boot.mp4"`,
    )
  }
  if (config.fit !== 'cover' && config.fit !== 'contain') config.fit = 'cover'
  return config
}

/** 豆包主程序：先用户指定，再常见安装位置，最后 PATH。 */
function findDoubao(config) {
  if (typeof config.doubaoPath === 'string' && config.doubaoPath !== '' && existsSync(config.doubaoPath)) {
    return config.doubaoPath
  }
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Doubao', 'Application', 'Doubao.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Doubao', 'Application', 'app', 'launcher', 'Doubao.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Doubao', 'Doubao.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Doubao', 'Doubao.exe'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** 豆包在跑吗？——单实例会让调试端口失效，必须提前判断。 */
function doubaoRunning() {
  return new Promise((resolvePromise) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Doubao.exe', '/NH'], { windowsHide: true }, (error, stdout) => {
      if (error) return resolvePromise(false)
      resolvePromise(/Doubao\.exe/i.test(String(stdout)))
    })
  })
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(port))
    })
  })
}

async function fetchJson(port, path, timeoutMs = 1500) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** 等豆包的调试端点起来（进程启动到 Chromium 绑定端口通常 1~3 秒）。 */
async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      return await fetchJson(port, '/json/version')
    } catch (error) {
      last = error
    }
    await sleep(120)
  }
  throw new Error(`调试端口 ${port} 未就绪：${last}`)
}

/** 主窗口是 `chrome://doubao-chat/chat`；背景页和子页面要排除掉。 */
async function waitForChatPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(port, '/json/list')
      const pages = targets.filter((target) => target.type === 'page')
      const chat =
        pages.find((target) => /doubao-chat/i.test(target.url)) ??
        pages.find((target) => /doubao/i.test(target.url)) ??
        pages.find((target) => target.title && /豆包/.test(target.title))
      if (chat !== undefined) return chat
    } catch {
      /* 端点刚起来时会短暂 404 */
    }
    await sleep(150)
  }
  throw new Error('没有等到豆包主窗口的页面目标')
}

/** 最小 CDP 客户端：只订阅我们发的请求，忽略事件。 */
class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolvePromise, reject) => {
      socket.onopen = resolvePromise
      socket.onerror = () => reject(new Error('DevTools WebSocket 连接失败'))
    })
    return new Cdp(socket)
  }

  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
    }
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* 已经断开 */
    }
  }
}

/**
 * 视频怎么进页面：**内联成 blob，不走网络。**
 *
 * 第一版是在本机起一个 HTTP 服务、让 `<video>` 去拉。实测在**冷启动**下这条路很糟：
 * 豆包启动瞬间自己的资源请求把渲染进程的媒体加载压在后面，注入后要 **3.2 秒**
 * 请求才真正打到本机服务（首帧 4.0 秒）——用户看到的是 4 秒黑屏。
 *
 * 改成把字节直接用 base64 传进页面、`Blob` + `createObjectURL` 喂给 `<video>` 之后：
 * `atob` 4ms、解码 37ms、首帧约 100ms。差别不是优化，是"能不能看"。
 *
 * 代价是视频要小（base64 常驻内存），所以 `maxVideoMB` 卡在 30MB 并提示压缩命令。
 * 一个开机动画本来也不该有几十 MB。
 */

/**
 * 等页面真的可见。
 *
 * 这里**不能用** `Browser.getWindowForTarget`：豆包是自绘窗口的 Chromium 壳，
 * 没有把窗口注册进 Chromium 的浏览器窗口模型，那个接口对它永远返回
 * `Browser window not found`（实测）。页面自己的 `document.visibilityState`
 * 才是准的——它也正是决定视频会不会被渲染/节流的那个信号。
 *
 * 最小化时不播：在看不见的地方放完等于没放。
 */
async function waitForVisiblePage(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const result = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: 'document.visibilityState' })
      last = result.result?.value ?? null
      if (last === 'visible') return true
    } catch {
      /* 页面还没建好 */
    }
    await sleep(200)
  }
  log(`窗口在 ${timeoutMs}ms 内都不可见（最后状态：${String(last)}），跳过片头`)
  return false
}

/**
 * 浮层脚本。
 *
 * 和 DSH 那个插件是同一套手感：视频从 `opacity 0 / blur(14px) / scale(1.04)`
 * 显影；结束时视频虚化淡出、整层底色变透明、backdrop 模糊从 18px 衰减到 0，
 * 让豆包**从模糊里浮出来**。
 *
 * 豆包专属的两处改动：
 *   - 「跳过」放**右下角**：豆包把窗口按钮画在页面右上角，放右上会盖住关闭键；
 *   - 覆盖层是页面内 `position:fixed`，因此天然盖住豆包自绘的标题栏与侧栏。
 */
function overlayScript({ videoBase64, config }) {
  const cfg = {
    videoBase64,
    fit: config.fit,
    muted: config.muted,
    volume: config.volume,
    skipButton: config.skipButton,
    skipOnClick: config.skipOnClick,
    skipOnEscape: config.skipOnEscape,
    handoffMs: config.handoffMs,
    firstFrameMs: config.firstFrameMs,
  }
  return `(() => {
  const CFG = ${JSON.stringify(cfg)}
  const previous = window.__doubaoBootAnimation
  if (previous && typeof previous.finish === 'function') { try { previous.finish('replaced') } catch (e) {} }

  const STYLE_ID = 'doubao-boot-animation-style'
  document.getElementById(STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = [
    '@keyframes dba-in{from{opacity:0;filter:blur(14px);transform:scale(1.04)}to{opacity:1;filter:blur(0);transform:scale(1)}}',
    '@keyframes dba-out{from{backdrop-filter:blur(18px) saturate(1.06);-webkit-backdrop-filter:blur(18px) saturate(1.06)}to{backdrop-filter:blur(0px) saturate(1);-webkit-backdrop-filter:blur(0px) saturate(1)}}',
    '#dba-root{transition:background-color .46s ease}',
    '#dba-root.dba-leaving{background-color:transparent !important;pointer-events:none;animation:dba-out .46s ease forwards}',
    '#dba-root.dba-leaving #dba-video{opacity:0 !important;filter:blur(16px) !important;transform:scale(1.02) !important}',
    '#dba-root.dba-leaving #dba-skip,#dba-root.dba-leaving #dba-hint{opacity:0;animation:none}',
    '#dba-skip:hover{background:rgba(0,0,0,.72) !important}',
    '@media (prefers-reduced-motion: reduce){#dba-video{animation:none !important}#dba-root.dba-leaving{animation:none !important}}',
  ].join('\\n')
  document.documentElement.appendChild(style)

  const root = document.createElement('div')
  root.id = 'dba-root'
  root.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'background:#000',
    'display:flex', 'align-items:center', 'justify-content:center',
    'overflow:hidden', 'pointer-events:auto', 'cursor:pointer',
  ].join(';')

  const video = document.createElement('video')
  video.id = 'dba-video'
  // 内联 blob，不发任何网络请求：冷启动时渲染进程的媒体请求会被应用自己的
  // 资源加载挤到 3 秒之后（实测），那就成了"先黑 4 秒再出画面"。
  const bin = atob(CFG.videoBase64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
  video.src = objectUrl
  video.muted = CFG.muted === true
  video.volume = typeof CFG.volume === 'number' ? Math.min(1, Math.max(0, CFG.volume)) : 1
  video.autoplay = true
  video.playsInline = true
  video.preload = 'auto'
  video.style.cssText = [
    'width:100%', 'height:100%',
    'object-fit:' + (CFG.fit === 'contain' ? 'contain' : 'cover'),
    'background:#000', 'display:block',
    'animation:dba-in .34s ease',
    'transition:opacity .46s ease,filter .46s ease,transform .46s ease',
  ].join(';')

  let skipButton = null
  if (CFG.skipButton) {
    skipButton = document.createElement('button')
    skipButton.id = 'dba-skip'
    skipButton.type = 'button'
    skipButton.textContent = '跳过'
    skipButton.title = '跳过片头（Esc）'
    // 右下角：豆包的窗口按钮在页面右上角，放右上会压住关闭键。
    skipButton.style.cssText = [
      'position:absolute', 'right:24px', 'bottom:24px', 'z-index:2',
      'border:1px solid rgba(255,255,255,.42)', 'background:rgba(0,0,0,.42)',
      'color:#fff', 'border-radius:999px', 'padding:6px 16px',
      'font:13px/1.4 inherit', 'cursor:pointer', 'opacity:.92',
      'transition:opacity .15s ease,background-color .15s ease',
    ].join(';')
    skipButton.addEventListener('click', (event) => { event.stopPropagation(); finish('skip-button') })
  }

  const hint = document.createElement('div')
  hint.id = 'dba-hint'
  hint.style.cssText = [
    'position:absolute', 'left:50%', 'bottom:30px', 'transform:translateX(-50%)',
    'z-index:2', 'color:rgba(255,255,255,.62)', 'font:12px/1.4 inherit',
    'letter-spacing:.08em', 'text-shadow:0 1px 8px rgba(0,0,0,.9)',
    'pointer-events:none', 'transition:opacity .4s ease', 'opacity:0',
  ].join(';')

  root.append(video, hint)
  if (skipButton) root.append(skipButton)
  document.documentElement.appendChild(root)

  const startedAt = performance.now()
  let done = false
  let resolveFinish
  const finished = new Promise((resolve) => { resolveFinish = resolve })
  // 时间线：排查"黑屏/播慢了/没声音"时，这些时刻比"感觉"可靠。
  const marks = { meta: null, playing: null, ended: null }
  const baseVolume = video.volume
  let soundBlocked = false
  let hintTimer = null
  let fadeTimer = null

  const showHint = (text, ms) => {
    hint.textContent = text
    hint.style.opacity = '0.9'
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => { hint.style.opacity = '0' }, ms)
  }

  const cleanup = () => {
    clearTimeout(hintTimer)
    if (fadeTimer !== null) { clearInterval(fadeTimer); fadeTimer = null }
    try { video.pause() } catch (e) {}
    try { video.removeAttribute('src'); video.load() } catch (e) {}
    try { URL.revokeObjectURL(objectUrl) } catch (e) {}
    root.remove()
    style.remove()
    if (window.__doubaoBootAnimation && window.__doubaoBootAnimation.root === root) delete window.__doubaoBootAnimation
  }

  /** 退场时把音量线性收到 0：声音被"掐断"比画面硬切更刺耳。 */
  const fadeOutAudio = () => {
    if (video.muted || video.paused) return
    const from = video.volume
    const steps = 12
    let step = 0
    fadeTimer = setInterval(() => {
      step += 1
      video.volume = Math.max(0, from * (1 - step / steps))
      if (step >= steps) { clearInterval(fadeTimer); fadeTimer = null }
    }, Math.max(16, Math.floor(CFG.handoffMs / steps)))
  }

  const finish = (reason) => {
    if (done) return
    done = true
    window.removeEventListener('keydown', onKey, true)
    fadeOutAudio()
    root.classList.add('dba-leaving')
    const wait = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 60 : CFG.handoffMs
    setTimeout(() => {
      const summary = {
        ok: true,
        reason,
        ms: Math.round(performance.now() - startedAt),
        meta: marks.meta === null ? null : Math.round(marks.meta - startedAt),
        playing: marks.playing === null ? null : Math.round(marks.playing - startedAt),
        ended: marks.ended === null ? null : Math.round(marks.ended - startedAt),
        size: [video.videoWidth, video.videoHeight],
        duration: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
        played: Math.round(video.currentTime * 1000),
        muted: video.muted,
        volume: Math.round(video.volume * 100) / 100,
        soundBlocked,
      }
      cleanup()
      resolveFinish(summary)
    }, wait)
  }

  /** 被拦时的一次"补救"：用户点一下就有声音，不打断片头。 */
  const unmute = () => {
    if (!soundBlocked) return
    soundBlocked = false
    video.muted = false
    video.volume = baseVolume
    if (video.paused) { video.play().catch(() => {}) }
    showHint('点击任意处跳过', 2600)
  }

  const onKey = (event) => {
    if (!CFG.skipOnEscape) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish('escape') }
  }
  window.addEventListener('keydown', onKey, true)

  root.addEventListener('click', () => {
    // 声音被浏览器拦掉时，第一次点击先开声音；再点才跳过（提示里写明了）。
    if (soundBlocked) { unmute(); return }
    if (CFG.skipOnClick) finish('click')
  })

  // 首帧看门狗：播不出来（解码失败/资源被拦）也要把界面还回去。
  const frameTimer = setTimeout(() => { if (video.readyState < 2) finish('no-first-frame') }, CFG.firstFrameMs)
  video.addEventListener('loadedmetadata', () => { marks.meta = performance.now() }, { once: true })
  video.addEventListener('playing', () => { marks.playing = performance.now(); clearTimeout(frameTimer) }, { once: true })
  video.addEventListener('error', () => { clearTimeout(frameTimer); finish('video-error') }, { once: true })
  video.addEventListener('ended', () => { marks.ended = performance.now(); finish('ended') }, { once: true })

  /**
   * 声音：默认**开**（0.2.0）。
   *
   * 启动器已经加了 「--autoplay-policy=no-user-gesture-required」，正常情况直接出声。
   * 万一仍被拦（系统/企业策略覆盖、标志没生效），退回静音播放而不是放弃整个片头，
   * 并把"点一下开声音"交给用户：提示里写明"再点跳过"，避免误触。
   */
  if (CFG.muted) {
    video.play().catch(() => { finish('autoplay-blocked') })
  } else {
    const attempt = video.play()
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {
        soundBlocked = true
        video.muted = true
        video.play().catch(() => { finish('autoplay-blocked') })
        showHint('点击开启声音 · 再点任意处跳过', 7000)
      })
    }
  }

  setTimeout(() => { if (!soundBlocked) showHint('点击任意处跳过', 2600) }, 900)

  window.__doubaoBootAnimation = { root, video, finish }
  return new Promise((resolve) => { finished.then((summary) => resolve(summary)) })
})()`
}

async function main() {
  if (typeof WebSocket !== 'function') {
    die('这个版本的 Node 不支持内置 WebSocket。', 2, '请安装 Node.js 22 或更新版本：https://nodejs.org/')
  }

  const config = loadConfig()
  log(`${APP_NAME} 启动`)
  log(`片头：${config.videoPath}`)

  const exe = findDoubao(config)
  if (exe === null) {
    die('没有找到豆包客户端。', 2, '请确认已安装豆包桌面端，或在 config.json 的 doubaoPath 里写上 Doubao.exe 的完整路径。')
  }

  if (!NO_LAUNCH && (await doubaoRunning())) {
    die(
      '豆包已经在运行了，这次不会播片头。',
      3,
      '豆包是单实例的：已经在运行时，新加的调试端口不会生效。\n请先从托盘退出豆包，再用本启动器打开。',
    )
  }

  const explicitPort = PORT_ARG >= 0 ? Number(process.argv[PORT_ARG + 1]) : null
  const port = NO_LAUNCH && explicitPort !== null && Number.isFinite(explicitPort) ? explicitPort : await freePort()
  log(`调试端口：127.0.0.1:${port}`)

  let child = null
  if (!NO_LAUNCH) {
    const launchArgs = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1']
    // 片头默认带声音，而"刚启动、没有任何用户手势"正是自动播放策略会拦的场景。
    // 这个开关是 Chromium 自带的，把"需要手势才能出声"这一条关掉。
    if (config.autoplayWithSound !== false) launchArgs.push('--autoplay-policy=no-user-gesture-required')
    child = spawn(exe, launchArgs, {
      cwd: dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    log(`已启动豆包：${exe}`)
  } else {
    log('--no-launch：只注入，不负责启动豆包')
  }

  try {
    await waitForDevtools(port, 20000)
    const page = await waitForChatPage(port, 15000)
    log(`主窗口：${page.url}`)

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    try {
      await cdp.send('Runtime.enable')
      try {
        await cdp.send('Page.enable')
      } catch {
        /* Page 域不是必需的 */
      }

      const visible = await waitForVisiblePage(cdp, config.waitForWindowMs)
      if (!visible) return

      // 内联给页面：不走网络（见 overlayScript 上方的说明）。
      const videoBase64 = readFileSync(config.videoPath).toString('base64')
      log(`视频已内联：${(videoBase64.length / 1024 / 1024).toFixed(2)} MB (base64)`)

      const expression = overlayScript({ videoBase64, config })
      const hardTimeoutMs = 8.1 * 1000 + config.handoffMs + 15000
      const outcome = await Promise.race([
        cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((r) => r.result?.value ?? null),
        sleep(hardTimeoutMs).then(() => ({ ok: false, reason: 'hard-timeout' })),
      ])
      log(`片头结束：${JSON.stringify(outcome)}`)
      if (outcome === null || outcome.ok === false) {
        // 页面可能在播放期间被重载：尽力清掉残留浮层，不让用户被卡住。
        await cdp
          .send('Runtime.evaluate', {
            expression: `document.getElementById('dba-root')?.remove();document.getElementById('doubao-boot-animation-style')?.remove();true`,
          })
          .catch(() => {})
      }
    } finally {
      cdp.close()
    }
  } catch (error) {
    // 动画失败不影响豆包本身：豆包已经在跑，用户只是没看到片头。
    log(`✗ 注入失败：${String(error?.message ?? error)}`)
    process.exitCode = 4
  }
}

await main()
