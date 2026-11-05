/**
 * 配置的读写，注入器与片库面板共用。
 *
 * 只有一个原则：**写配置是原子的**。片库面板保存时，注入器可能正在读同一个文件
 * （用户点「选用」的那一刻也可能正好在启动豆包），半截 JSON 会让两边都读崩。
 * 所以先写临时文件再 rename 覆盖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_CONFIG_PATH = join(ROOT, 'config.json')

export const DEFAULTS = {
  /** 片头目录。里面所有 mp4/webm 都会被片库列出；放进去就等于"加了一套动画"。 */
  clipsDir: 'clips',
  /** 当前选用的片头（文件名）。空 = 用目录里的第一个。 */
  selected: 'boot-full.mp4',
  /** 每次启动随机挑一条。 */
  random: false,
  /** 直接的视频路径，优先级最高（给"我就想用绝对路径"的人）。 */
  video: '',
  fit: 'cover',
  muted: false,
  volume: 1,
  autoplayWithSound: true,
  skipButton: true,
  skipOnClick: true,
  skipOnEscape: true,
  handoffMs: 520,
  waitForWindowMs: 15000,
  firstFrameMs: 8000,
  maxVideoMB: 30,
  doubaoPath: '',
}

export const LOG_DIR = join(process.env.LOCALAPPDATA ?? homedir(), 'DoubaoBootAnimation', 'logs')

/** 读配置：缺字段用默认值，不在这里做业务校验。 */
export function readConfig(file = DEFAULT_CONFIG_PATH) {
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`配置文件读不了（${file}）：${String(error?.message ?? error)}`)
    }
  }
  return { path: file, config: { ...DEFAULTS, ...fromFile } }
}

/** 合并写回：只覆盖传入的字段，其它键原样保留。 */
export function patchConfig(file, patch) {
  const { config } = readConfig(file)
  const next = { ...config, ...patch }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return next
}
