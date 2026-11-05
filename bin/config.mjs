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

/**
 * 把"能被手改坏"的字段收进能用的范围。
 *
 * README 明确说了可以直接编辑 `config.json`，那就必须假设里面会出现
 * `"volume": "0.6"`（字符串）、`"handoffMs": null`、写到一半没开引号的数字。
 * 这些东西会一路走进页面：`video.volume = NaN` 在 Chromium 里会被夹掉或抛错，
 * `setInterval(fn, NaN)` 退化成 0ms 的紧循环——都是"没声音 / 退场卡一下"这种
 * 最难查的症状。所以**在进入业务逻辑之前**统一夹一次。
 */
export function normalizeConfig(input = {}) {
  const numeric = (value, fallback, min, max) => {
    // 只接受"数字"或"非空数字字符串"。这一条必须显式写出来，不能用 !Number.isFinite 判断：
    // `Number(null)` 是 0、`Number([])` 也是 0、`Number(true)` 是 1，全都"有限"——
    // 于是 `"volume": null` 会被静默变成静音，`"handoffMs": null` 会变成瞬间交接。
    if (typeof value !== 'number' && typeof value !== 'string') return fallback
    if (typeof value === 'string' && value.trim() === '') return fallback
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, number))
  }
  const text = (value, fallback) => (typeof value === 'string' ? value : fallback)

  return {
    ...input,
    clipsDir: text(input.clipsDir, DEFAULTS.clipsDir) || DEFAULTS.clipsDir,
    selected: text(input.selected, DEFAULTS.selected),
    video: text(input.video, DEFAULTS.video),
    doubaoPath: text(input.doubaoPath, DEFAULTS.doubaoPath),
    random: input.random === true,
    muted: input.muted === true,
    autoplayWithSound: input.autoplayWithSound !== false,
    skipButton: input.skipButton !== false,
    skipOnClick: input.skipOnClick !== false,
    skipOnEscape: input.skipOnEscape !== false,
    fit: input.fit === 'contain' ? 'contain' : 'cover',
    volume: numeric(input.volume, DEFAULTS.volume, 0, 1),
    handoffMs: Math.round(numeric(input.handoffMs, DEFAULTS.handoffMs, 0, 5000)),
    firstFrameMs: Math.round(numeric(input.firstFrameMs, DEFAULTS.firstFrameMs, 500, 60000)),
    waitForWindowMs: Math.round(numeric(input.waitForWindowMs, DEFAULTS.waitForWindowMs, 1000, 120000)),
    maxVideoMB: numeric(input.maxVideoMB, DEFAULTS.maxVideoMB, 1, 500),
  }
}

/** 读配置：缺字段用默认值，并顺手把字段收敛到可用范围。 */
export function readConfig(file = DEFAULT_CONFIG_PATH) {
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`配置文件读不了（${file}）：${String(error?.message ?? error)}`)
    }
  }
  return { path: file, config: normalizeConfig({ ...DEFAULTS, ...fromFile }) }
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
