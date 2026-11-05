#!/usr/bin/env node
/**
 * 在桌面创建「豆包（开机动画）」快捷方式。
 *
 * 为什么需要它：片头只在**通过启动器启动**豆包时才会播放。用户点原来的豆包图标，
 * 豆包就按普通方式启动，注入器根本没有机会介入（日志里连一条记录都不会有）。
 * 与其让人记住"要用 launch.vbs"，不如给他一个和豆包一模一样的入口。
 *
 * 图标取自豆包自己的 exe；名字带"（开机动画）"，不会覆盖你原有的豆包快捷方式。
 * 用 PowerShell 的 WScript.Shell 创建（能拿到真实的桌面路径，含 OneDrive 重定向的情况），
 * 中文名通过命令行参数传过去，避开 .vbs/.ps1 的文件编码坑。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG_PATH, ROOT, readConfig } from './config.mjs'
import { findDoubao } from './doubao.mjs'

const APP_NAME = '豆包开机动画'
const SHORTCUT_NAME = '豆包（开机动画）'
/** 自动化用：不弹任何对话框，只打印结果。 */
const QUIET = process.argv.includes('--quiet')

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function messageBox(text, title = APP_NAME) {
  if (QUIET) {
    console.log(text)
    return
  }
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${psQuote(text)}, ${psQuote(title)}) | Out-Null`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true,
    })
  } catch {
    console.log(text)
  }
}

/**
 * 豆包在哪儿：与注入器用同一套查找（含 `config.json` 里的 `doubaoPath`）。
 * 读配置失败也不影响建快捷方式——只是图标可能拿不到豆包自己的那个。
 */
function readConfigQuietly() {
  try {
    return readConfig(DEFAULT_CONFIG_PATH).config
  } catch {
    return {}
  }
}

const launcher = join(ROOT, 'launch.vbs')
if (!existsSync(launcher)) {
  messageBox(`找不到启动器：\n${launcher}\n\n请确认整个文件夹是完整解压出来的。`)
  process.exit(2)
}

const doubaoExe = findDoubao(readConfigQuietly())
const iconLine =
  doubaoExe === null ? '' : `\n$lnk.IconLocation = ${psQuote(`${doubaoExe},0`)}`

const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ws = New-Object -ComObject WScript.Shell
$desk = $ws.SpecialFolders('Desktop')
if ([string]::IsNullOrWhiteSpace($desk)) { throw '拿不到桌面路径' }
$path = Join-Path $desk ${psQuote(SHORTCUT_NAME + '.lnk')}
$lnk = $ws.CreateShortcut($path)
$lnk.TargetPath = ${psQuote(launcher)}
$lnk.WorkingDirectory = ${psQuote(ROOT)}
$lnk.Description = ${psQuote('豆包（带开机动画）')}${iconLine}
$lnk.Save()
Write-Output $path
`

let created = null
try {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
  })
  created = String(output).trim().split(/\r?\n/).pop() ?? null
} catch (error) {
  messageBox(`创建快捷方式失败：\n${String(error?.message ?? error)}`)
  process.exit(1)
}

// 不轻信 PowerShell 的输出：它可能打了一行警告也照样返回 0。
// 真正重要的是"那个 .lnk 在不在"，所以以文件是否存在为准。
if (created === null || !existsSync(created)) {
  messageBox(
    `快捷方式好像没建成。\n\n请手动右键拖动 ${join(ROOT, 'launch.vbs')}\n到桌面，选择「创建快捷方式」。`,
  )
  process.exit(1)
}

messageBox(
  `已在桌面创建：\n${SHORTCUT_NAME}\n\n以后用它打开豆包就能看到片头。\n` +
    `想换成自己的片头、调音量：双击「设置.vbs」。\n\n` +
    `如果以后移动了这个文件夹，快捷方式会失效——重新双击「安装快捷方式.vbs」即可。`,
)
console.log(`快捷方式：${created}`)
