/**
 * 单实例闸门（锁文件）。
 *
 * 为什么需要：启动器从快捷方式进来，双击两下是常事；自检与手动也可能撞在一起。
 * 两个注入器同时跑不会"两个片头"，而是**互相拆台**——后一个会把前一个的浮层换掉，
 * 而前一个收尾时又会把自己那份清掉；更糟的是"关掉重开"分支里，两个进程会各杀一次豆包。
 *
 * 锁文件里放 `{ pid, at }`：
 * - PID 还活着、且不超过 5 分钟 → 认为真的有一个在跑；
 * - 否则当成残锁直接接管。
 *
 * 5 分钟的 TTL 同时兜住两种情况：进程崩溃留下的残锁，以及 **PID 被系统复用**
 * （复用出来的那个进程当然"活着"，但显然不是我们）。任何一次正常的注入都远短于 5 分钟。
 *
 * 锁本身坏掉（比如日志目录没有写权限）不该阻止用户看片头，所以失败时一律放行。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * @param {string} lockFile 锁文件路径
 * @param {{ ttlMs?: number }} [options]
 * @returns {{ ok: boolean, pid: number, holder?: number, release: () => void }}
 *   `ok === false` 表示已经有别的实例在跑，`holder` 是它的 PID。
 */
export function acquireLock(lockFile, { ttlMs = 5 * 60 * 1000 } = {}) {
  const noop = () => {}
  try {
    mkdirSync(dirname(lockFile), { recursive: true })

    if (existsSync(lockFile)) {
      let previous = null
      try {
        previous = JSON.parse(readFileSync(lockFile, 'utf8'))
      } catch {
        previous = null // 坏文件 = 残锁
      }
      const pid = Number(previous?.pid)
      const at = Number(previous?.at)
      const fresh = Number.isFinite(at) && Date.now() - at < ttlMs
      if (fresh && Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        let alive = false
        try {
          process.kill(pid, 0)
          alive = true
        } catch {
          alive = false
        }
        if (alive) return { ok: false, pid, holder: pid, release: noop }
      }
    }

    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
    const release = () => {
      try {
        const current = JSON.parse(readFileSync(lockFile, 'utf8'))
        if (Number(current?.pid) === process.pid) rmSync(lockFile, { force: true })
      } catch {
        /* 已经被别人接管或删掉了 */
      }
    }
    return { ok: true, pid: process.pid, release }
  } catch {
    // 锁坏了不该阻止片头：放行，并且不留下任何东西
    return { ok: true, pid: process.pid, release: noop }
  }
}
