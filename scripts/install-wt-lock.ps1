# scripts/install-wt-lock.ps1 — opt-in installer for the Worktree Mutex Lock +
# the dependency-sync warning hooks (Windows).
#
# Installs .githooks/pre-commit AND .githooks/post-merge + .githooks/post-checkout
# (the "node_modules out of sync after a pull" warning) into THIS CLONE's active
# hooks directory. This is a deliberate, MANUAL, per-clone step. It does NOT modify shared git config
# (it never runs `git config core.hooksPath ...`), so it cannot change behavior
# fleet-wide for other clones.
#
# The hooks dir is shared by all worktrees of this clone — exactly the
# contention domain the lock guards — so one install binds every worktree of
# this clone, for Claude, Codex, and humans alike.
#
# Usage:
#   pwsh scripts/install-wt-lock.ps1            # install (won't clobber a custom hook)
#   pwsh scripts/install-wt-lock.ps1 -Force     # overwrite an existing pre-commit
#   pwsh scripts/install-wt-lock.ps1 -Uninstall
param(
  [switch]$Force,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
$src  = Join-Path $root ".githooks/pre-commit"

# Resolve the active hooks dir without changing config.
$hooksDir = (git config --get core.hooksPath)
if ([string]::IsNullOrWhiteSpace($hooksDir)) {
  $common = (git rev-parse --git-common-dir).Trim()
  if (-not [System.IO.Path]::IsPathRooted($common)) { $common = Join-Path $root $common }
  $hooksDir = Join-Path $common "hooks"
} else {
  $hooksDir = $hooksDir.Trim()
}
$dest = Join-Path $hooksDir "pre-commit"

$marker = "Worktree Mutual-Exclusion Lock"

# Install the dependency-sync warning hooks (post-merge/post-checkout) alongside the lock.
# Idempotent; only manages hooks carrying our marker, never clobbers a foreign same-named hook.
function Install-DepHooks {
  foreach ($h in @("post-merge", "post-checkout")) {
    $hsrc = Join-Path $root ".githooks/$h"
    $hdest = Join-Path $hooksDir $h
    if (-not (Test-Path $hsrc)) { continue }
    if ((Test-Path $hdest) -and (-not (Select-String -Path $hdest -SimpleMatch "check-deps.mjs" -Quiet))) {
      Write-Warning "existing non-managed $h hook at $hdest left untouched."
      continue
    }
    Copy-Item -Force $hsrc $hdest
    Write-Output "[install-wt-lock] installed dep-sync hook -> $hdest"
  }
}

if ($Uninstall) {
  if ((Test-Path $dest) -and (Select-String -Path $dest -SimpleMatch $marker -Quiet)) {
    Remove-Item -Force $dest
    Write-Output "[install-wt-lock] removed $dest"
  } else {
    Write-Output "[install-wt-lock] no managed pre-commit hook at $dest (nothing to do)"
  }
  foreach ($h in @("post-merge", "post-checkout")) {
    $hd = Join-Path $hooksDir $h
    if ((Test-Path $hd) -and (Select-String -Path $hd -SimpleMatch "check-deps.mjs" -Quiet)) {
      Remove-Item -Force $hd; Write-Output "[install-wt-lock] removed $hd"
    }
  }
  return
}

if (-not (Test-Path $src)) {
  Write-Error "[install-wt-lock] missing $src"
  exit 1  # explicit (matches install-wt-lock.sh); Write-Error already terminates under ErrorActionPreference=Stop
}

New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

if ((Test-Path $dest) -and (-not $Force)) {
  if (Select-String -Path $dest -SimpleMatch $marker -Quiet) {
    Copy-Item -Force $src $dest
    Write-Output "[install-wt-lock] refreshed existing managed hook at $dest"
    Install-DepHooks
    return
  }
  Write-Warning "A different pre-commit hook already exists at:`n    $dest"
  Write-Output  "  Re-run with -Force to overwrite, or manually add this line to it:"
  Write-Output  "    node `"$root/scripts/wt-lock.mjs`" check || exit 1   # only blocks in strict mode"
  exit 1
}

Copy-Item -Force $src $dest
Write-Output "[install-wt-lock] installed worktree lock hook -> $dest"
Write-Output "[install-wt-lock] mode: advisory (warn only). For blocking: `$env:JANUS_WT_LOCK='strict'"

Install-DepHooks
