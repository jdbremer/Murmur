/**
 * OS-level computer-use primitives (Windows-first).
 *
 * Layer B of the agent stack (WINDOWS-HANDOFF):
 *   A) Playwright/CDP — in-app selectors, DOM, injectPcm (preferred when possible)
 *   B) nut.js / Win32  — full-screen capture, absolute mouse, real key chords
 *
 * Prefer @nut-tree-fork/nut-js (free npm prebuilds). Fall back to PowerShell
 * user32 SendInput/SetCursorPos when the native module fails to load.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** @type {null | typeof import('@nut-tree-fork/nut-js')} */
let nut = null
let nutError = null

try {
  nut = require('@nut-tree-fork/nut-js')
} catch (error) {
  nutError = error instanceof Error ? error.message : String(error)
}

export function osBackend() {
  return nut ? { backend: 'nut-js', error: null } : { backend: 'powershell-win32', error: nutError }
}

function ps(script) {
  if (process.platform !== 'win32') {
    throw new Error(`PowerShell OS control is Windows-only (running on ${process.platform})`)
  }
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    throw new Error(
      `PowerShell failed (${result.status}): ${result.stderr || result.stdout || 'unknown'}`,
    )
  }
  return (result.stdout || '').trim()
}

/**
 * Capture the full virtual desktop (all monitors) to a PNG path.
 * PowerShell GDI+ is the reliable path on Windows multi-monitor setups
 * (virtual-screen origin can be negative). nut.js is used for input only.
 * Returns { path, width, height, backend }.
 */
export async function captureScreen(outPath) {
  mkdirSync(dirname(outPath), { recursive: true })

  const escaped = outPath.replace(/'/g, "''")
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$($bounds.X),$($bounds.Y),$($bounds.Width),$($bounds.Height)"
`
  const meta = ps(script)
  const [originX, originY, w, h] = meta.split(',').map(Number)
  return {
    path: outPath,
    width: w,
    height: h,
    originX,
    originY,
    backend: 'powershell-win32',
  }
}

/** Absolute desktop click. Multi-monitor: coordinates are virtual-screen space. */
export async function clickAt(x, y, button = 'left') {
  const xi = Math.round(Number(x))
  const yi = Math.round(Number(y))
  if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
    throw new Error('clickAt requires numeric x, y')
  }

  if (nut) {
    const { mouse, Button, Point } = nut
    await mouse.setPosition(new Point(xi, yi))
    const map = { left: Button.LEFT, right: Button.RIGHT, middle: Button.MIDDLE }
    await mouse.click(map[button] ?? Button.LEFT)
    return { ok: true, x: xi, y: yi, button, backend: 'nut-js' }
  }

  const down = button === 'right' ? '0x0008' : button === 'middle' ? '0x0020' : '0x0002'
  const up = button === 'right' ? '0x0010' : button === 'middle' ? '0x0040' : '0x0004'
  ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MurmurInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e);
}
"@
[MurmurInput]::SetCursorPos(${xi}, ${yi})
Start-Sleep -Milliseconds 30
[MurmurInput]::mouse_event(${down}, 0, 0, 0, 0)
Start-Sleep -Milliseconds 20
[MurmurInput]::mouse_event(${up}, 0, 0, 0, 0)
`)
  return { ok: true, x: xi, y: yi, button, backend: 'powershell-win32' }
}

/** Type plain text (no special keys). */
export async function typeText(text) {
  const s = String(text ?? '')
  if (nut) {
    const { keyboard } = nut
    await keyboard.type(s)
    return { ok: true, length: s.length, backend: 'nut-js' }
  }
  // SendKeys: escape special chars + { } ~ % ^
  const escaped = s
    .replace(/\{/g, '{{}')
    .replace(/\}/g, '{}}')
    .replace(/\+/g, '{+}')
    .replace(/\^/g, '{^}')
    .replace(/%/g, '{%}')
    .replace(/~/g, '{~}')
    .replace(/'/g, "''")
  ps(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped}')
`)
  return { ok: true, length: s.length, backend: 'powershell-win32' }
}

/**
 * Press a chord or key sequence.
 * Accepts:
 *   - "Ctrl+Shift+P"
 *   - ["Control", "Shift", "P"]
 *   - { keys: [...], holdMs?: number }
 */
export async function pressKeys(input) {
  let keys
  let holdMs = 0
  if (typeof input === 'string') {
    keys = input
      .split('+')
      .map((k) => k.trim())
      .filter(Boolean)
  } else if (Array.isArray(input)) {
    keys = input
  } else if (input && typeof input === 'object') {
    keys =
      input.keys ||
      String(input.chord || '')
        .split('+')
        .map((k) => k.trim())
        .filter(Boolean)
    holdMs = Number(input.holdMs || 0)
  } else {
    throw new Error('pressKeys expects a chord string or keys array')
  }

  if (nut) {
    const { keyboard, Key } = nut
    const mapped = keys.map((k) => mapNutKey(k, Key))
    if (mapped.some((k) => k == null)) {
      throw new Error(`unknown key in ${JSON.stringify(keys)}`)
    }
    await keyboard.pressKey(...mapped)
    if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs))
    await keyboard.releaseKey(...mapped)
    return { ok: true, keys, backend: 'nut-js' }
  }

  // PowerShell SendKeys chord: ^ = Ctrl, + = Shift, % = Alt
  const send = toSendKeysChord(keys)
  const escaped = send.replace(/'/g, "''")
  ps(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${escaped}')
`)
  return { ok: true, keys, sendKeys: send, backend: 'powershell-win32' }
}

function mapNutKey(name, Key) {
  const n = String(name).toLowerCase()
  const table = {
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    controlleft: Key.LeftControl,
    controlright: Key.RightControl,
    rightctrl: Key.RightControl,
    alt: Key.LeftAlt,
    option: Key.LeftAlt,
    altleft: Key.LeftAlt,
    altright: Key.RightAlt,
    shift: Key.LeftShift,
    shiftleft: Key.LeftShift,
    shiftright: Key.RightShift,
    win: Key.LeftSuper,
    meta: Key.LeftSuper,
    super: Key.LeftSuper,
    cmd: Key.LeftSuper,
    enter: Key.Enter,
    return: Key.Enter,
    tab: Key.Tab,
    escape: Key.Escape,
    esc: Key.Escape,
    space: Key.Space,
    backspace: Key.Backspace,
    delete: Key.Delete,
    up: Key.Up,
    down: Key.Down,
    left: Key.Left,
    right: Key.Right,
    f1: Key.F1,
    f2: Key.F2,
    f3: Key.F3,
    f4: Key.F4,
    f5: Key.F5,
    f6: Key.F6,
    f7: Key.F7,
    f8: Key.F8,
    f9: Key.F9,
    f10: Key.F10,
    f11: Key.F11,
    f12: Key.F12,
  }
  if (table[n]) return table[n]
  if (n.length === 1) {
    const upper = n.toUpperCase()
    if (Key[upper] != null) return Key[upper]
  }
  if (Key[name] != null) return Key[name]
  if (Key[String(name).toUpperCase()] != null) return Key[String(name).toUpperCase()]
  return null
}

function toSendKeysChord(keys) {
  const mods = []
  let main = null
  for (const k of keys) {
    const n = String(k).toLowerCase()
    if (n === 'ctrl' || n === 'control') mods.push('^')
    else if (n === 'shift') mods.push('+')
    else if (n === 'alt' || n === 'option') mods.push('%')
    else if (n === 'win' || n === 'meta' || n === 'super') {
      // SendKeys has no Win key; use leftover as literal {WIN} won't work — skip
      throw new Error('Win key chords require nut-js backend on this machine')
    } else main = k
  }
  if (!main) throw new Error('chord missing main key')
  const special = {
    enter: '{ENTER}',
    return: '{ENTER}',
    tab: '{TAB}',
    escape: '{ESC}',
    esc: '{ESC}',
    space: ' ',
    backspace: '{BACKSPACE}',
    delete: '{DELETE}',
    up: '{UP}',
    down: '{DOWN}',
    left: '{LEFT}',
    right: '{RIGHT}',
  }
  const body =
    special[String(main).toLowerCase()] || (main.length === 1 ? main : `{${main.toUpperCase()}}`)
  return mods.join('') + body
}

/**
 * Bring a top-level window to the foreground by title substring.
 * Prefers the *shortest* matching title so we do not focus Windows Terminal
 * whose title often contains the command string ("… Notepad …").
 */
export async function focusWindow(titleSubstring) {
  // This value reaches a PowerShell script that carries inline C#. Doubling
  // `'` is the correct escape for a single-quoted PowerShell string and is
  // sufficient on its own, but the input arrives over HTTP, so bound it too:
  // strip control characters (a newline would end the statement) and cap the
  // length. Belt and braces on the one string that crosses into a shell.
  const needle = String(titleSubstring || 'Murmur')
    // eslint-disable-next-line no-control-regex
    .replace(/[ -]/g, '')
    .slice(0, 200)
    .replace(/'/g, "''")
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public class MurmurWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lp, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static string Focus(string needle) {
    IntPtr best = IntPtr.Zero;
    int bestLen = int.MaxValue;
    string bestTitle = "";
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string title = sb.ToString();
      if (string.IsNullOrEmpty(title)) return true;
      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      // Skip terminals / agent shells whose titles embed the search string.
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      try {
        string pname = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
        if (pname.Contains("terminal") || pname.Contains("cmd") || pname.Contains("powershell")
            || pname.Contains("WindowsTerminal".ToLower()) || pname == "windowsterminal")
          return true;
      } catch { }
      if (title.Length < bestLen) {
        bestLen = title.Length;
        best = h;
        bestTitle = title;
      }
      return true;
    }, IntPtr.Zero);
    if (best == IntPtr.Zero) return "not-found";
    ShowWindow(best, 9); // SW_RESTORE
    // Alt key trick: helps SetForegroundWindow succeed when another app owns focus.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    BringWindowToTop(best);
    SetForegroundWindow(best);
    return "ok|" + bestTitle;
  }
}
"@
[MurmurWin]::Focus('${needle}')
`
  const result = ps(script)
  if (!result.startsWith('ok')) {
    throw new Error(`focusWindow: no visible window matching "${titleSubstring}"`)
  }
  const title = result.includes('|') ? result.slice(result.indexOf('|') + 1) : titleSubstring
  return { ok: true, title }
}

/** Virtual-screen bounds (multi-monitor origin can be negative). */
export function virtualScreenBounds() {
  const out = ps(`
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
Write-Output "$($b.X),$($b.Y),$($b.Width),$($b.Height)"
`)
  const [x, y, width, height] = out.split(',').map(Number)
  return { x, y, width, height }
}
