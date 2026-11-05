#!/usr/bin/env node
/**
 * 设置面板。
 *
 * 为什么是"本地一次性服务 + 浏览器"而不是在豆包窗口里画一个面板：
 * 选片头、调音量是**启动之前**的事。为了它去起豆包、加调试端口、注入浮层，成本和风险
 * 都不划算；而且豆包正开着（正常方式启动）时根本连不上。一个临时本地服务用完就关，
 * 最省事也最可控。片头动画本身因此只有一个「跳过」按钮，不塞任何设置入口。
 *
 * 安全口径：
 * - 只绑 127.0.0.1，端口随机；
 * - 所有请求都要带一次性 token（`?t=`），token 只出现在它自己打印的 URL 里；
 * - 只列 `clips/` 里的视频、只写 `config.json` 的已知字段、只服务这些视频文件；
 * - 关掉面板（或 10 分钟无操作）服务就退出。
 */
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { listClips } from './clip-library.mjs'
import { DEFAULT_CONFIG_PATH, ROOT, patchConfig, readConfig } from './config.mjs'

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const opt = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const configPath = resolve(opt('--config') ?? DEFAULT_CONFIG_PATH)
const shouldOpen = !has('--no-open')
const portArg = opt('--port')
const token = randomUUID()
const UI_FILE = join(ROOT, 'ui', 'settings.html')

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
}

/** 每次现读配置：面板与注入器各读各的，绝不各说各话。 */
function snapshot() {
  const { config } = readConfig(configPath)
  const clipsDir = resolve(ROOT, config.clipsDir || 'clips')
  const clips = listClips(clipsDir)
  const selected = clips.some((clip) => clip.file === config.selected)
    ? config.selected
    : clips[0]?.file ?? ''
  return {
    clips,
    selected,
    random: config.random === true,
    volume: Number.isFinite(Number(config.volume)) ? Number(config.volume) : 1,
    muted: config.muted === true,
    fit: config.fit === 'contain' ? 'contain' : 'cover',
    skipButton: config.skipButton !== false,
    skipOnClick: config.skipOnClick !== false,
    skipOnEscape: config.skipOnEscape !== false,
    handoffMs: Number.isFinite(Number(config.handoffMs)) ? Number(config.handoffMs) : 520,
    maxVideoMB: Number.isFinite(Number(config.maxVideoMB)) ? Number(config.maxVideoMB) : 30,
    clipsDir,
  }
}

function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((ok, bad) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        bad(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        ok(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        bad(error)
      }
    })
    request.on('error', bad)
  })
}

function serveMedia(response, clipsDir, file, rangeHeader) {
  const clip = listClips(clipsDir).find((entry) => entry.file === file)
  if (clip === undefined) {
    response.writeHead(404).end()
    return
  }
  const size = statSync(clip.path).size
  const type = MIME[extname(clip.path).toLowerCase()] ?? 'application/octet-stream'
  if (typeof rangeHeader === 'string') {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    const start = Number(match?.[1] || 0)
    const end = match?.[2] ? Number(match[2]) : size - 1
    response.writeHead(206, {
      'content-type': type,
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
      'cache-control': 'no-store',
    })
    createReadStream(clip.path, { start, end }).pipe(response)
    return
  }
  response.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'cache-control': 'no-store' })
  createReadStream(clip.path).pipe(response)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = decodeURIComponent(url.pathname)
  const authorized = url.searchParams.get('t') === token

  if (!authorized) {
    response.writeHead(403).end('forbidden')
    return
  }

  try {
    if (request.method === 'GET' && path === '/') {
      const html = readFileSync(UI_FILE, 'utf8').replace('/*__BOOT_STATE__*/', JSON.stringify({ token, state: snapshot() }))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }

    if (request.method === 'GET' && path.startsWith('/media/')) {
      const file = path.slice('/media/'.length)
      serveMedia(response, snapshot().clipsDir, file, request.headers.range)
      return
    }

    if (request.method === 'GET' && path === '/api/state') {
      sendJson(response, { ok: true, state: snapshot() })
      return
    }

    if (request.method === 'POST' && path === '/api/select') {
      const body = await readBody(request)
      const before = snapshot()
      const clip = before.clips.find((entry) => entry.file === body.file)
      if (clip === undefined) {
        sendJson(response, { ok: false, error: '这个片头不在目录里（可能被删了）' }, 400)
        return
      }
      // 明确选用一条，就该关掉随机——否则"选了没反应"。
      const turnedOffRandom = before.random === true
      patchConfig(configPath, { selected: clip.file, random: false })
      sendJson(response, { ok: true, state: snapshot(), turnedOffRandom })
      return
    }

    if (request.method === 'POST' && path === '/api/settings') {
      const body = await readBody(request)
      const patch = {}
      if (typeof body.random === 'boolean') patch.random = body.random
      if (typeof body.muted === 'boolean') patch.muted = body.muted
      if (typeof body.skipButton === 'boolean') patch.skipButton = body.skipButton
      if (typeof body.skipOnClick === 'boolean') patch.skipOnClick = body.skipOnClick
      if (typeof body.skipOnEscape === 'boolean') patch.skipOnEscape = body.skipOnEscape
      if (Number.isFinite(Number(body.volume))) patch.volume = Math.min(1, Math.max(0, Number(body.volume)))
      if (body.fit === 'cover' || body.fit === 'contain') patch.fit = body.fit
      if (Object.keys(patch).length === 0) {
        sendJson(response, { ok: false, error: '没有可保存的字段' }, 400)
        return
      }
      patchConfig(configPath, patch)
      sendJson(response, { ok: true, state: snapshot() })
      return
    }

    if (request.method === 'POST' && path === '/api/open-folder') {
      execFile('explorer.exe', [snapshot().clipsDir], { windowsHide: false }, () => {})
      sendJson(response, { ok: true })
      return
    }

    if (request.method === 'POST' && path === '/api/quit') {
      sendJson(response, { ok: true })
      setTimeout(() => shutdown(0), 60)
      return
    }

    response.writeHead(404).end()
  } catch (error) {
    sendJson(response, { ok: false, error: String(error?.message ?? error) }, 500)
  }
})

let idleTimer = null
function armIdle() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => shutdown(0), 10 * 60 * 1000)
}

function shutdown(code) {
  clearTimeout(idleTimer)
  try {
    server.close(() => process.exit(code))
  } catch {
    process.exit(code)
  }
  setTimeout(() => process.exit(code), 800).unref()
}

server.on('request', () => armIdle())
server.on('error', (error) => {
  console.error(`[设置] 启动失败：${String(error?.message ?? error)}`)
  process.exit(1)
})

// 注意：`--port` 是字符串，Number.isFinite('18777') 是 false——直接用它判断会静默
// 退化成随机端口，测试与脚本就会连到"以为的端口"上。
const requestedPort = portArg === undefined ? 0 : Number(portArg)

server.listen(Number.isFinite(requestedPort) ? requestedPort : 0, '127.0.0.1', () => {
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}/?t=${token}`
  console.log(`SETTINGS_URL=${url}`)
  console.log(`设置面板：${url}`)
  console.log('（只在本机可用；关掉面板或 10 分钟无操作后自动退出）')
  if (shouldOpen) {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }
  armIdle()
})
