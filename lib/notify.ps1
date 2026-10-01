# dsh-notify-cues — Windows notification runner.
#
# Plays a scene-specific chime, shows a native WinRT toast, and optionally
# flashes the DSH taskbar button. Deliberately PowerShell-only: no .NET 10
# desktop runtime, no helper executable, no external audio assets.
#
# Every tone is synthesized into a temporary 16-bit PCM WAV, so the six scenes
# are distinguishable by ear without shipping media files.

param(
  [Parameter(Mandatory = $true)][string]$Scene,
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $false)][string]$Body = '',
  [Parameter(Mandatory = $false)][string]$Sound = '',
  [Parameter(Mandatory = $false)][string]$Launch = '',
  [Parameter(Mandatory = $false)][double]$Volume = 1.0,
  [Parameter(Mandatory = $false)][int]$FlashCount = 3,
  [Parameter(Mandatory = $false)][int]$FlashTimeout = 500,
  [Parameter(Mandatory = $false)][string]$FlashAfter = 'holdUntilFocused',
  [switch]$NoToast,
  [switch]$NoFlash,
  [switch]$ListSounds
)

$ErrorActionPreference = 'Continue'
$Volume = [Math]::Max(0.05, [Math]::Min(1.0, $Volume))
$FlashCount = [Math]::Max(0, $FlashCount)
$FlashTimeout = [Math]::Max(0, $FlashTimeout)
if ($FlashAfter -notin @('stop', 'holdUntilFocused', 'keepFlashing')) { $FlashAfter = 'holdUntilFocused' }

$SAMPLE_RATE = 22050

# ---------------------------------------------------------------------------
# Tone table. Each entry is an array of notes: frequency in Hz (0 = rest),
# duration in ms. The shapes are chosen to be unmistakable at a glance:
# rising = good, falling = interrupted, dissonant = bad, repeated = stuck.
# ---------------------------------------------------------------------------
$TONES = @{
  completed   = @(@(587.33, 110), @(880.00, 190))                              # D5 -> A5, gentle rise
  interrupted = @(@(880.00, 90),  @(440.00, 170))                              # A5 -> A4, cut short
  error       = @(@(277.18, 130), @(0, 40), @(207.65, 240))                    # low, dissonant, falling
  maxTokens   = @(@(1046.50, 65), @(0, 45), @(1046.50, 65), @(0, 45), @(1046.50, 65))  # three sharp pips
  blocked     = @(@(392.00, 150), @(392.00, 150))                              # flat double knock
  attention   = @(@(659.25, 95),  @(783.99, 95),  @(987.77, 200))              # E5-G5-B5 arpeggio
  ding        = @(@(1046.50, 80), @(1318.51, 260))                             # bright attention getter
}

function New-ToneWav {
  <#
    .SYNOPSIS
      Synthesize a sequence of sine notes into a 16-bit mono PCM WAV file.
    .DESCRIPTION
      Each note gets a short attack ramp and an exponential decay so the joins
      never click; consecutive notes of the same pitch are still separated by
      their own envelope, which is what makes a repeated pip read as repeated.
  #>
  param(
    [Parameter(Mandatory = $true)][array]$Notes,
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $false)][double]$Volume = 1.0
  )

  $amplitude = 0.34 * $Volume
  $samples = New-Object System.Collections.Generic.List[double]
  foreach ($note in $Notes) {
    $freq = [double]$note[0]
    $ms = [int]$note[1]
    $count = [int]($SAMPLE_RATE * $ms / 1000)
    if ($count -le 0) { continue }
    $attack = [Math]::Max(1, [int]($SAMPLE_RATE * 0.006))
    for ($i = 0; $i -lt $count; $i++) {
      if ($freq -le 0) { $samples.Add(0.0); continue }
      $t = $i / $SAMPLE_RATE
      $env = if ($i -lt $attack) { $i / $attack } else { [Math]::Exp(-3.2 * ($i - $attack) / $count) }
      $samples.Add([Math]::Sin(2 * [Math]::PI * $freq * $t) * $env * $amplitude)
    }
  }

  $dataBytes = $samples.Count * 2
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($stream)
  try {
    # RIFF / WAVE / fmt (PCM, 1 channel, 16 bit) / data
    $writer.Write([char[]]'RIFF')
    $writer.Write([int](36 + $dataBytes))
    $writer.Write([char[]]'WAVE')
    $writer.Write([char[]]'fmt ')
    $writer.Write([int]16)
    $writer.Write([int16]1)                       # PCM
    $writer.Write([int16]1)                       # mono
    $writer.Write([int]$SAMPLE_RATE)
    $writer.Write([int]($SAMPLE_RATE * 2))        # byte rate
    $writer.Write([int16]2)                       # block align
    $writer.Write([int16]16)                      # bits per sample
    $writer.Write([char[]]'data')
    $writer.Write([int]$dataBytes)
    foreach ($sample in $samples) {
      $clamped = [Math]::Max(-1.0, [Math]::Min(1.0, $sample))
      $writer.Write([int16]($clamped * 32767))
    }
    $writer.Flush()
    [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

function Play-SceneSound {
  param([string]$Name, [string]$TempDir, [double]$Volume = 1.0)

  if ($Name -eq 'none' -or $Name -eq '') { return 'muted' }

  # A custom .wav path wins over the built-in table.
  if (Test-Path -LiteralPath $Name -PathType Leaf) {
    try {
      $player = New-Object System.Media.SoundPlayer $Name
      if ($Volume -lt 0.99) {
        # SoundPlayer has no volume control, so attenuate a copy of the file.
        $raw = [System.IO.File]::ReadAllBytes($Name)
        for ($i = 44; $i + 1 -lt $raw.Length; $i += 2) {
          $sample = [BitConverter]::ToInt16($raw, $i)
          $scaled = [int16][Math]::Max(-32768, [Math]::Min(32767, [int]($sample * $Volume)))
          $raw[$i] = [byte]($scaled -band 0xFF)
          $raw[$i + 1] = [byte](($scaled -shr 8) -band 0xFF)
        }
        $tmpWav = Join-Path $TempDir ("dsh-notify-cues-custom-" + [guid]::NewGuid().ToString('N') + '.wav')
        [System.IO.File]::WriteAllBytes($tmpWav, $raw)
        $player = New-Object System.Media.SoundPlayer $tmpWav
      }
      $player.PlaySync()
      $player.Dispose()
      return 'custom'
    } catch {
      return 'custom-failed'
    }
  }

  $notes = $TONES[$Name]
  if ($null -eq $notes) { $notes = $TONES['ding'] }
  $wav = Join-Path $TempDir ("dsh-notify-cues-" + [guid]::NewGuid().ToString('N') + '.wav')
  try {
    New-ToneWav -Notes $notes -Path $wav -Volume $Volume
    $player = New-Object System.Media.SoundPlayer $wav
    $player.PlaySync()
    $player.Dispose()
    return 'tone'
  } catch {
    # Last resort: the system exclamation sound.
    try { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 400 } catch {}
    return 'fallback'
  } finally {
    Remove-Item -LiteralPath $wav -Force -ErrorAction SilentlyContinue
  }
}

$tempDir = [System.IO.Path]::GetTempPath()

if ($ListSounds) {
  $results = @()
  foreach ($name in ($TONES.Keys | Sort-Object)) {
    $results += ('{0}:{1}' -f $name, (Play-SceneSound -Name $name -TempDir $tempDir -Volume $Volume))
    Start-Sleep -Milliseconds 250
  }
  Write-Output ('list:' + ($results -join ','))
  exit 0
}

# ---------------------------------------------------------------------------
# 1. Sound
# ---------------------------------------------------------------------------
$soundResult = Play-SceneSound -Name $Sound -TempDir $tempDir -Volume $Volume

# ---------------------------------------------------------------------------
# 2. Toast identity (one-time, idempotent).
#    An unpackaged app's toast header comes from the Start Menu shortcut that
#    carries the AppUserModelID; the HKCU\...\AppUserModelID key supplies the
#    display name and icon. Failure here is non-fatal: the toast then falls
#    back to the PowerShell identity below.
# ---------------------------------------------------------------------------
$AUMID = 'DshNotifyCues.Notifier'
$regPath = "HKCU:\Software\Classes\AppUserModelID\$AUMID"
$iconPath = Join-Path $PSScriptRoot 'dsh-logo.ico'
$hasIcon = Test-Path $iconPath -ErrorAction SilentlyContinue
try {
  # -ErrorAction Stop matters: under the script's 'Continue' preference a plain
  # New-Item failure is a NON-terminating error that try/catch never sees, and
  # it leaks a red error record into the caller's stderr on every notification.
  if (-not (Test-Path $regPath -ErrorAction SilentlyContinue)) {
    New-Item -Path $regPath -Force -ErrorAction Stop | Out-Null
  }
  # The AUMID key itself is what gives an unpackaged process a toast identity
  # (CreateToastNotifier otherwise fails with 0x80073D54 "no package
  # identity"). DisplayName is therefore unconditional and must never be gated
  # behind the optional icon file.
  Set-ItemProperty -Path $regPath -Name 'DisplayName' -Value 'DeepSeek Harness' -ErrorAction Stop
  if ($hasIcon) {
    Set-ItemProperty -Path $regPath -Name 'IconUri' -Value $iconPath -ErrorAction Stop
  }

  $lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness Notifications.lnk'
  if (-not (Test-Path $lnkPath -ErrorAction SilentlyContinue)) {
    # A DEDICATED shortcut name: the desktop installer also owns
    # "DeepSeek Harness.lnk" and overwriting it would hijack the app entry.
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnkPath)
    $sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sc.Arguments = '-NoProfile -WindowStyle Hidden -Command "exit"'
    if ($hasIcon) { $sc.IconLocation = "$iconPath,0" }
    $sc.Description = 'DeepSeek Harness notifications'
    $sc.WindowStyle = 7
    $sc.Save()
  }
} catch {
  # Best effort: an unwritable registry leaves the toast on the fallback
  # identity, which still displays. Never let identity setup break a notice.
}

# ---------------------------------------------------------------------------
# 3. Toast (WinRT), with a classic balloon as fallback.
# ---------------------------------------------------------------------------
$toastShown = $false
$toastAumid = ''
if (-not $NoToast) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $xmlEscape = { param($s) ([string]$s) -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' -replace '"', '&quot;' }
    $activator = ''
    if ($Launch -ne '') {
      # Protocol activation: Win11 drops foreground activation for unpackaged
      # apps, and a plain URL launch is the behaviour users expect anyway.
      $activator = ' activationType="protocol" launch="' + (& $xmlEscape $Launch) + '"'
    }
    $xml = '<toast' + $activator + '><visual><binding template="ToastGeneric">' +
      '<text>' + (& $xmlEscape $Title) + '</text>' +
      '<text>' + (& $xmlEscape $Body) + '</text>' +
      '</binding></visual></toast>'

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    # A fresh tag per notification keeps bursty scenes from replacing each other.
    $toast.Tag = 'dsh-notify-cues-' + [guid]::NewGuid().ToString('N').Substring(0, 12)

    $candidates = @(
      $AUMID,
      # Registered by other DSH notification plugins in this ecosystem; if one
      # of them already set it up, the toast displays under that identity.
      'DeepSeekHarness',
      '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    )
    foreach ($candidate in $candidates) {
      try {
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($candidate)
        $notifier.Show($toast)
        $toastShown = $true
        $toastAumid = $candidate
        break
      } catch {
        $toastShown = $false
      }
    }
  } catch {
    $toastShown = $false
  }

  if (-not $toastShown) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $ni = New-Object System.Windows.Forms.NotifyIcon
      $ni.Icon = [System.Drawing.SystemIcons]::Information
      $ni.Visible = $true
      $ni.BalloonTipTitle = $Title
      $ni.BalloonTipText = $Body
      $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Information
      $ni.ShowBalloonTip(8000)
      # The icon must outlive the balloon or Windows drops it immediately.
      Start-Sleep -Milliseconds 8200
      $ni.Dispose()
      $toastShown = $true
      $toastAumid = 'balloon'
    } catch {
      $toastShown = $false
    }
  }
}

# ---------------------------------------------------------------------------
# 4. Taskbar flash — FLASHW_TRAY | FLASHW_TIMERNOFG, i.e. the taskbar button
#    only, repeating until the window is brought to the foreground. Windows
#    never flashes a foreground window, so this is a no-op when DSH is active.
# ---------------------------------------------------------------------------
$flashOk = $false
$flashTitle = ''
$flashHwnd = [IntPtr]::Zero
if (-not $NoFlash) {
  try {
    if (-not ('DshCuesFlash' -as [type])) {
      Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DshCuesFlash {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO info);
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
}
'@
    }
    $script:found = [IntPtr]::Zero
    $script:foundTitle = ''
    # The DSH page title is "<session title> — DeepSeek Harness" for the PWA and
    # the host origin for a plain browser tab; accept both, prefer the exact
    # suffix so an unrelated window mentioning the name cannot steal the flash.
    $hostPort = ''
    try { $hostPort = ([uri]$env:DSH_WEB_URL).Port } catch {}
    $callback = [DshCuesFlash+EnumProc]{
      param($h, $l)
      if ([DshCuesFlash]::IsWindowVisible($h)) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][DshCuesFlash]::GetWindowText($h, $sb, $sb.Capacity)
        $title = $sb.ToString()
        if ($title -match 'DeepSeek Harness\s*$') {
          $script:found = $h; $script:foundTitle = $title; return $false
        }
        if ($script:found -eq [IntPtr]::Zero -and $hostPort -ne '' -and $title -like "*:$hostPort*") {
          $script:found = $h; $script:foundTitle = $title
        }
      }
      return $true
    }
    [void][DshCuesFlash]::EnumWindows($callback, [IntPtr]::Zero)
    if ($script:found -ne [IntPtr]::Zero) {
      $flashHwnd = $script:found
      $flashTitle = $script:foundTitle
      $info = New-Object DshCuesFlash+FLASHWINFO
      $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DshCuesFlash+FLASHWINFO])
      $info.hwnd = $script:found
      $info.dwTimeout = [uint32]$FlashTimeout

      # FLASHW_TRAY(2) animates the taskbar button; FLASHW_TIMERNOFG(12) keeps
      # going until the window is focused.
      $TRAY = [uint32]2
      $TIMERNOFG = [uint32]12

      if ($FlashAfter -eq 'keepFlashing') {
        # Animate forever until the user comes back.
        $info.dwFlags = $TRAY -bor $TIMERNOFG
        $info.uCount = [uint32]0
        [void][DshCuesFlash]::FlashWindowEx([ref]$info)
        $flashOk = $true
      } else {
        # Opening burst: a finite number of animated pulses.
        if ($FlashCount -gt 0) {
          $info.dwFlags = $TRAY -bor $TIMERNOFG
          $info.uCount = [uint32]$FlashCount
          [void][DshCuesFlash]::FlashWindowEx([ref]$info)
          $flashOk = $true
          if ($FlashAfter -eq 'holdUntilFocused') {
            # Let the burst finish before switching modes, or a second call would
            # just restart the animation.
            Start-Sleep -Milliseconds ([int]($FlashTimeout * ($FlashCount + 1)))
          }
        }
        if ($FlashAfter -eq 'holdUntilFocused') {
          # The chat-app pattern: stop animating, but leave the window in the
          # "needs attention" state so the taskbar button stays lit until it is
          # focused. dwFlags = 12 without FLASHW_TRAY is the only non-animating
          # attention state the API offers. Windows 11 does not expose the old
          # WS_EX_FLASHING extended-style bit (verified: it never sets, even
          # mid-flash), so whether this reads as a persistent highlight is
          # something only the taskbar itself can show.
          $info.dwFlags = $TIMERNOFG
          $info.uCount = [uint32]0
          [void][DshCuesFlash]::FlashWindowEx([ref]$info)
          $flashOk = $true
        }
      }
    }
  } catch {
    $flashOk = $false
  }
}

# Machine-readable result line: the settings page's "test" button and the
# unit tests both parse this.
Write-Output ("notify:scene={0};sound={1};toast={2};aumid={3};flash={4};hwnd={5};title={6}" -f `
  $Scene, $soundResult, $toastShown, $toastAumid, $flashOk, $flashHwnd, $flashTitle)
