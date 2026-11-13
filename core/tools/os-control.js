/**
 * illuci — OS Control Layer
 *
 * Full computer-use agent capabilities via PowerShell and Windows APIs.
 * Mouse, keyboard, screen, audio, windows, processes, hardware.
 *
 * No npm dependencies — pure PowerShell interop for maximum reliability.
 * PowerShell calls Add-Type to access .NET/Win32 APIs directly.
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(tmpdir(), "illuci-screenshots");

function ps(command, timeout = 10000) {
  return execSync(
    `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`,
    { encoding: "utf-8", timeout, windowsHide: true }
  ).trim();
}

function psScript(script, timeout = 10000) {
  const tmpFile = resolve(tmpdir(), `illuci-ps-${Date.now()}.ps1`);
  writeFileSync(tmpFile, script, "utf-8");
  try {
    return execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: "utf-8", timeout, windowsHide: true }
    ).trim();
  } finally {
    try { execSync(`del "${tmpFile}"`, { windowsHide: true }); } catch {}
  }
}

// ─── MOUSE ───

export function mouseMove(x, y) {
  psScript(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IlluciMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
"@
[IlluciMouse]::SetCursorPos(${x}, ${y})
Write-Output "moved to ${x},${y}"
  `);
  return { x, y };
}

export function mouseClick(x, y, button = "left") {
  const flags = button === "right" ? "0x0008,0x0010" : "0x0002,0x0004";
  psScript(`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IlluciMouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
}
"@
[IlluciMouse]::SetCursorPos(${x}, ${y})
Start-Sleep -Milliseconds 50
[IlluciMouse]::mouse_event(${flags.split(",")[0]}, 0, 0, 0, 0)
[IlluciMouse]::mouse_event(${flags.split(",")[1]}, 0, 0, 0, 0)
Write-Output "clicked ${button} at ${x},${y}"
  `);
  return { x, y, button };
}

export function mousePosition() {
  const result = psScript(`
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
Write-Output "$($p.X),$($p.Y)"
  `);
  const [x, y] = result.split(",").map(Number);
  return { x, y };
}

// ─── KEYBOARD ───

export function keyType(text) {
  // SendKeys requires special escaping
  const escaped = text.replace(/[+^%~(){}[\]]/g, "{$&}");
  psScript(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${escaped.replace(/"/g, '""')}")
  `);
  return { typed: text };
}

export function keyPress(key) {
  // Map common key names to SendKeys format
  const keyMap = {
    enter: "{ENTER}", tab: "{TAB}", escape: "{ESC}", backspace: "{BS}",
    delete: "{DEL}", home: "{HOME}", end: "{END}", up: "{UP}", down: "{DOWN}",
    left: "{LEFT}", right: "{RIGHT}", pageup: "{PGUP}", pagedown: "{PGDN}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}",
    f6: "{F6}", f7: "{F7}", f8: "{F8}", f9: "{F9}", f10: "{F10}",
    f11: "{F11}", f12: "{F12}", space: " ", win: "^{ESC}",
  };
  const sendKey = keyMap[key.toLowerCase()] || key;
  psScript(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${sendKey}")
  `);
  return { pressed: key };
}

export function keyCombo(modifiers, key) {
  // modifiers: "ctrl", "alt", "shift", "ctrl+shift", etc.
  let prefix = "";
  if (modifiers.includes("ctrl")) prefix += "^";
  if (modifiers.includes("alt")) prefix += "%";
  if (modifiers.includes("shift")) prefix += "+";
  const k = key.length === 1 ? key : `{${key.toUpperCase()}}`;
  psScript(`
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("${prefix}${k}")
  `);
  return { combo: `${modifiers}+${key}` };
}

// ─── SCREEN ───

export function screenshot(region) {
  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const path = resolve(SCREENSHOT_DIR, `illuci-${Date.now()}.png`);

  if (region) {
    psScript(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${region.width}, ${region.height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${region.x}, ${region.y}, 0, 0, $bmp.Size)
$bmp.Save("${path.replace(/\\/g, "\\\\")}")
$g.Dispose(); $bmp.Dispose()
    `);
  } else {
    psScript(`
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save("${path.replace(/\\/g, "\\\\")}")
$g.Dispose(); $bmp.Dispose()
    `);
  }

  return { path, region: region || "fullscreen" };
}

export function screenInfo() {
  const result = psScript(`
Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen
Write-Output "$($s.Bounds.Width)x$($s.Bounds.Height) $($s.BitsPerPixel)bpp"
$all = [System.Windows.Forms.Screen]::AllScreens
Write-Output "displays: $($all.Count)"
  `);
  return { info: result };
}

// ─── AUDIO / VOLUME ───

export function volumeSet(level) {
  // level: 0-100
  const normalized = Math.max(0, Math.min(100, Math.round(level))) / 100;
  psScript(`
$obj = New-Object -ComObject WScript.Shell
# Set volume via SendKeys (nircmd-free approach)
# First mute then set
1..50 | ForEach-Object { $obj.SendKeys([char]174) }
$steps = [math]::Round(${normalized} * 50)
1..$steps | ForEach-Object { $obj.SendKeys([char]175) }
  `);
  return { volume: level };
}

export function volumeGet() {
  // Use PowerShell AudioDeviceCmdlets or WMI fallback
  const result = psScript(`
try {
  # Try Get-AudioDevice if available
  $vol = (Get-AudioDevice -PlaybackVolume) 2>$null
  if ($vol) { Write-Output $vol; return }
} catch {}
# Fallback: report unknown (no reliable PS5 method without modules)
Write-Output "unknown"
  `);
  return { volume: result === "unknown" ? -1 : parseInt(result) || 0 };
}

export function volumeMute(mute = true) {
  psScript(`
$obj = New-Object -ComObject WScript.Shell
$obj.SendKeys([char]173)
  `);
  return { muted: mute };
}

// ─── WINDOW MANAGEMENT ───

export function windowList() {
  const result = psScript(`
Get-Process | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress
  `);
  try { return JSON.parse(result); } catch { return { raw: result }; }
}

export function windowFocus(titleOrPid) {
  if (typeof titleOrPid === "number") {
    psScript(`
$p = Get-Process -Id ${titleOrPid} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne 0) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class IlluciWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'
    [IlluciWin]::SetForegroundWindow($p.MainWindowHandle)
}
    `);
  } else {
    psScript(`
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${titleOrPid}*" } | Select-Object -First 1
if ($p -and $p.MainWindowHandle -ne 0) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class IlluciWin { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'
    [IlluciWin]::SetForegroundWindow($p.MainWindowHandle)
}
    `);
  }
  return { focused: titleOrPid };
}

export function windowMinimize(titleOrPid) {
  psScript(`
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*${titleOrPid}*" } | Select-Object -First 1
if ($p) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class IlluciWin { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }'
    [IlluciWin]::ShowWindow($p.MainWindowHandle, 6)
}
  `);
  return { minimized: titleOrPid };
}

// ─── PROCESS MANAGEMENT ───

export function processLaunch(command) {
  const result = ps(`Start-Process -PassThru ${command} | Select-Object Id | ConvertTo-Json -Compress`);
  try { return JSON.parse(result); } catch { return { launched: command }; }
}

export function processKill(pid) {
  ps(`Stop-Process -Id ${pid} -Force`);
  return { killed: pid };
}

export function processList(filter) {
  const cmd = filter
    ? `Get-Process | Where-Object { $_.ProcessName -like '*${filter}*' } | Select-Object Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json -Compress`
    : `Get-Process | Select-Object -First 50 Id, ProcessName, CPU, WorkingSet64 | ConvertTo-Json -Compress`;
  const result = ps(cmd, 15000);
  try { return JSON.parse(result); } catch { return { raw: result }; }
}

// ─── SYSTEM INFO ───

export function systemInfo() {
  const result = psScript(`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$mem = $os.TotalVisibleMemorySize
$free = $os.FreePhysicalMemory
Write-Output "os: $($os.Caption) $($os.Version)"
Write-Output "cpu: $($cpu.Name)"
Write-Output "ram: $([math]::Round($mem/1MB,1))GB total, $([math]::Round($free/1MB,1))GB free"
Write-Output "uptime: $((Get-Date) - $os.LastBootUpTime)"
  `);
  return { info: result };
}

// ─── CLIPBOARD ───

// ─── CLIPBOARD (with isolation + auto-clear) ───

let clipboardClearTimer = null;
const CLIPBOARD_CLEAR_DELAY = 30000; // 30 seconds

function scheduleClipboardClear() {
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = setTimeout(() => {
    try {
      psScript("Set-Clipboard -Value ''");
      console.log("[os-control] Clipboard auto-cleared (30s isolation)");
    } catch {}
    clipboardClearTimer = null;
  }, CLIPBOARD_CLEAR_DELAY);
}

export function clipboardGet() {
  const result = ps("Get-Clipboard");
  scheduleClipboardClear();
  return { content: result, autoClearIn: "30s" };
}

export function clipboardSet(text) {
  psScript(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`);
  scheduleClipboardClear();
  return { set: true, autoClearIn: "30s" };
}

export function clipboardClear() {
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = null;
  psScript("Set-Clipboard -Value ''");
  return { cleared: true };
}

export default {
  mouseMove, mouseClick, mousePosition,
  keyType, keyPress, keyCombo,
  screenshot, screenInfo,
  volumeSet, volumeGet, volumeMute,
  windowList, windowFocus, windowMinimize,
  processLaunch, processKill, processList,
  systemInfo, clipboardGet, clipboardSet,
};
