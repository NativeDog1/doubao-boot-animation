/**
 * 片库：扫目录、读展示名、按配置选一条。
 *
 * 设计上刻意"没有数据库"：`clips/` 里放一个视频就等于加了一套动画，删掉就等于移除。
 * `clips/clips.json` 只是可选的展示名/备注映射，不参与"有哪些片"的判定——
 * 否则用户新丢进去的文件会因为没登记而"看不见"，那正是要避免的坑。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v'])

/** `clips/clips.json` 里的展示名；缺失或坏了都不影响列出文件。 */
function readMeta(clipsDir) {
  const file = join(clipsDir, 'clips.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 列出片库里的所有片头。
 *
 * @returns {{ file: string, path: string, name: string, note: string, bytes: number, mtime: number }[]}
 */
export function listClips(clipsDir) {
  if (!existsSync(clipsDir)) return []
  const meta = readMeta(clipsDir)
  return readdirSync(clipsDir)
    .filter((entry) => VIDEO_EXTENSIONS.has(extname(entry).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((file) => {
      const path = join(clipsDir, file)
      let bytes = 0
      let mtime = 0
      try {
        const info = statSync(path)
        bytes = info.size
        mtime = info.mtimeMs
      } catch {
        /* 列目录与读文件之间被删掉了：留 0，下面按"不可用"处理 */
      }
      const entry = meta[file]
      return {
        file,
        path,
        name: typeof entry?.name === 'string' && entry.name !== '' ? entry.name : file.replace(/\.[^.]+$/, ''),
        note: typeof entry?.note === 'string' ? entry.note : '',
        bytes,
        mtime,
      }
    })
    .filter((clip) => clip.bytes > 0)
}

/**
 * 按配置决定这次播哪一条。
 *
 * 优先级：`video`（显式路径）> `random`（随机挑一条）> `selected`（选中的那条）> 第一条。
 * 找不到就返回 null，由调用方给用户一句人话，而不是抛栈。
 */
export function resolveClip(config, root) {
  const explicit = typeof config.video === 'string' && config.video.trim() !== ''
  if (explicit) {
    const path = resolve(root, config.video)
    if (!existsSync(path)) return { error: `config.json 里 video 指向的文件不存在：${path}` }
    return { file: basename(path), path, name: basename(path), note: '显式指定', bytes: statSync(path).size, mtime: 0 }
  }

  const clipsDir = resolve(root, config.clipsDir || 'clips')
  const clips = listClips(clipsDir)
  if (clips.length === 0) {
    return { error: `片头目录是空的：${clipsDir}\n把 mp4 放进去就行（会自动出现在片库里）。` }
  }

  if (config.random === true) {
    const picked = clips[Math.floor(Math.random() * clips.length)]
    return { ...picked, reason: 'random' }
  }

  const selected = clips.find((clip) => clip.file === config.selected)
  if (selected !== undefined) return { ...selected, reason: 'selected' }

  return { ...clips[0], reason: 'first' }
}
