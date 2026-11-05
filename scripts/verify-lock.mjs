/**
 * 单实例闸门的四条断言。直接测 `bin/lock.mjs`，不去跑整个注入器——
 * 否则"残锁要能被接管"这条就要等 20 秒的端口超时，测试慢到没人会跑。
 *
 * 关键的一条是「有活锁时必须让路」：两个注入器同时跑不会变成两个片头，
 * 而是互相拆台（后一个换掉前一个的浮层，前一个收尾又清掉后一个的），
 * "关掉重开"分支里还会各杀一次豆包。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { acquireLock } from '../bin/lock.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

const dir = mkdtempSync(join(tmpdir(), 'dba-lock-'))
const lockFile = join(dir, 'injector.lock')

// 1) 没有锁 → 拿到，并且落盘了自己的 PID
const first = acquireLock(lockFile)
check(first.ok === true, '没有锁时能拿到', JSON.stringify({ ok: first.ok }))
check(readFileSync(lockFile, 'utf8').includes(String(process.pid)), '锁文件里写的是自己的 PID')

// 2) 自己再拿一次 → 不算冲突（同一个进程重入不该把自己挡住）
const again = acquireLock(lockFile)
check(again.ok === true, '同一个进程重复获取不算冲突')

// 3) 释放后文件消失
first.release()
check(!existsSync(lockFile), '释放后锁文件被删掉')

// 4) 有活着的别的进程持锁 → 必须让路
const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
await sleep(600)
let holderAlive = true
try {
  process.kill(holder.pid, 0)
} catch {
  holderAlive = false
}
check(holderAlive, '测试用的持锁进程确实活着', String(holder.pid))

writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, at: Date.now() }), 'utf8')
const blocked = acquireLock(lockFile)
check(blocked.ok === false, '有活锁时让路', JSON.stringify({ ok: blocked.ok }))
check(blocked.holder === holder.pid, '让路时报告持锁者 PID', String(blocked.holder))
check(readFileSync(lockFile, 'utf8').includes(String(holder.pid)), '让路时不去踩别人的锁文件')

// 5) 持锁进程死了 → 残锁要被接管，不能永久卡死
holder.kill('SIGKILL')
await sleep(400)
const takeover = acquireLock(lockFile)
check(takeover.ok === true, '持锁进程死掉后能接管', JSON.stringify({ ok: takeover.ok }))
takeover.release()

// 6) 时间戳很老（PID 可能已被系统复用）→ 也按残锁处理
writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, at: Date.now() - 10 * 60 * 1000 }), 'utf8')
const stale = acquireLock(lockFile)
check(stale.ok === true, '超过 TTL 的锁按残锁接管', JSON.stringify({ ok: stale.ok }))
stale.release()

// 7) 坏文件 → 按残锁处理
writeFileSync(lockFile, 'not-json', 'utf8')
const corrupt = acquireLock(lockFile)
check(corrupt.ok === true, '坏掉的锁文件按残锁处理', JSON.stringify({ ok: corrupt.ok }))
corrupt.release()

// 8) release 只删自己的锁：别的进程已经接管时不能把它的删掉
acquireLock(lockFile)
writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: Date.now() }), 'utf8')
const mine = acquireLock(lockFile) // 接管，锁现在是我们的
writeFileSync(lockFile, JSON.stringify({ pid: 888888, at: Date.now() }), 'utf8') // 模拟被别人接管
mine.release()
check(existsSync(lockFile), 'release 不会删掉别人的锁')

rmSync(dir, { recursive: true, force: true })

console.log('')
if (failures.length === 0) {
  console.log('all lock checks passed')
  process.exit(0)
}
console.log(`${failures.length} lock check(s) failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
