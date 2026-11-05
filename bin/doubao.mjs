/**
 * 豆包主程序：在哪儿、是不是开着、怎么关掉。
 *
 * 抽成单独一个文件，是因为注入器、快捷方式安装器、端到端自检都要回答同一组问题。
 * 之前三处各写一份，结果自检里把安装路径硬编码成了 `%LOCALAPPDATA%\Doubao\...`——
 * 装在 Program Files 的机器上自检直接找不到豆包，看起来像功能坏了，其实只是找错了地方。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const DOUBAO_PROCESS = 'Doubao.exe'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 找 `Doubao.exe`：先看用户在 `config.json` 里指定的，再看常见安装位置。
 * 找不到返回 `null`，由调用方给一句人话。
 */
export function findDoubao(config = {}) {
  const configured = config.doubaoPath
  if (typeof configured === 'string' && configured !== '' && existsSync(configured)) return configured

  const candidates = []
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData !== '') {
    candidates.push(join(localAppData, 'Doubao', 'Application', 'Doubao.exe'))
    candidates.push(join(localAppData, 'Doubao', 'Application', 'app', 'launcher', 'Doubao.exe'))
  }
  for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)']) {
    const root = process.env[key]
    if (typeof root === 'string' && root !== '') candidates.push(join(root, 'Doubao', 'Doubao.exe'))
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/**
 * 豆包在跑吗？
 *
 * 这件事必须问清楚：豆包是单实例的，已经在跑的时候再带 `--remote-debugging-port`
 * 启动，参数会被转交给已有进程——端口根本不会监听，片头就没有机会出现。
 *
 * 检查本身失败（tasklist 不可用）时返回 `false` 并记一行警告：宁可试一次再失败，
 * 也不要因为"查不到"就直接告诉用户"已经在运行了"。
 */
export function doubaoRunning({ onError } = {}) {
  return new Promise((resolvePromise) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${DOUBAO_PROCESS}`, '/NH'], { windowsHide: true }, (error, stdout) => {
      if (error) {
        if (typeof onError === 'function') onError(error)
        resolvePromise(false)
        return
      }
      resolvePromise(new RegExp(DOUBAO_PROCESS.replace('.', '\\.'), 'i').test(String(stdout)))
    })
  })
}

/**
 * 关掉豆包，并等它真的退干净。
 *
 * `taskkill` 返回成功只代表"信号发出去了"；豆包有一堆子进程与一个托盘图标，
 * 立刻启动新实例会被旧的单实例锁顶回来。所以按 `tasklist` 轮询到真的没了为止。
 */
export async function stopDoubao({ timeoutMs = 10000, stepMs = 200 } = {}) {
  await new Promise((done) =>
    execFile('taskkill', ['/IM', DOUBAO_PROCESS, '/F'], { windowsHide: true }, () => done()),
  )
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await doubaoRunning())) return true
    await sleep(stepMs)
  }
  return false
}
