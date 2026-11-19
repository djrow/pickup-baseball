<#
.SYNOPSIS
  Bump version, test, commit, tag, deploy to Cloudflare Pages (and optional Cron Worker), and push to GitHub.

.DESCRIPTION
  Editable release workflow script for both interactive human releases and non-interactive agent releases.
  Default flow:
    1. Verify current git branch matches $DefaultBranch (unless -AllowWrongBranch)
    2. Bump app & cache version (npm run bump) — auto-skipped if working tree is clean and current version is not yet tagged (e.g. after merging a pre-bumped branch), unless -ForceBump is passed
    3. Run the unified verification gate on the bumped files (npm run check)
    4. Show `git status --short`, confirm staging, prompt for commit summary if -Message wasn't passed, and commit
    5. Create git tag `v<version>` (even if -SkipCommit was used or changes were already committed)
    6. Deploy to Cloudflare Pages (`npm run deploy`) and optionally the Cron Worker (`npm run deploy:cron` via -DeployCron)
    7. Push branch and tag to GitHub (`origin/trunk`)
    8. Run live production security verification (`npm run security:scan:live`, unless -SkipDeploy)

  You do NOT need to edit this file for commit messages: pass `-Message "..."` when
  running it, or just run `.\scripts\ship.ps1` and type the message when prompted.
  Agents should pass `-Message "..." -Yes` for non-interactive execution.

.EXAMPLE
  .\scripts\ship.ps1
  .\scripts\ship.ps1 -Message "Change sportsmanship to goodwill"
  .\scripts\ship.ps1 -Message "Quick fix" -Yes
  .\scripts\ship.ps1 -DeployCron -Message "Update reminder worker" -Yes
  .\scripts\ship.ps1 -NoPush -SkipDeploy
  .\scripts\ship.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Message = '',
  [switch]$SkipBump,
  [switch]$ForceBump,
  [switch]$SkipTest,
  [switch]$SkipCommit,
  [switch]$SkipDeploy,
  [switch]$DeployCron,
  [switch]$StagedOnly,
  [switch]$NoPush,
  [switch]$NoTag,
  [switch]$AllowWrongBranch,
  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ==============================================================================
# Editable Defaults (customize these to change default behavior)
# ==============================================================================
$DefaultBranch  = 'trunk'
$RemoteName     = 'origin'
$PushByDefault  = $true   # Set $false to keep commits local unless pushed manually
$TagByDefault   = $true   # Set $false to skip creating `v<version>` git tags
$ConfirmStaging = $true   # Show `git status --short` and ask before `git add -A` (bypass with -Yes)

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Command
  )
  Write-Host "`n==> $Label" -ForegroundColor Cyan
  if ($DryRun) {
    Write-Host "    [DryRun] Skipped execution." -ForegroundColor DarkGray
    return
  }
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed with exit code ${LASTEXITCODE}: $Label"
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $RepoRoot

try {
  # 1. Branch safety guard
  $CurrentBranch = ("$((git rev-parse --abbrev-ref HEAD) -join '')").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($CurrentBranch)) {
    throw "Failed to read current git branch."
  }
  if (-not $AllowWrongBranch -and $CurrentBranch -ne $DefaultBranch) {
    throw "Current branch is '$CurrentBranch', expected '$DefaultBranch'. Switch branches or pass -AllowWrongBranch to continue."
  }

  # 2. Bump version first so tests verify the exact files we will commit & deploy
  #    Auto-detect if working tree is clean and CURRENT_APP_VERSION is not yet tagged (e.g. merged a pre-bumped branch)
  $PreVersionSrc = Get-Content (Join-Path $RepoRoot 'src\app\version.js') -Raw
  $PreVersion = if ($PreVersionSrc -match "CURRENT_APP_VERSION\s*=\s*'(\d+)'") { $Matches[1] } else { 'unknown' }
  $PreTagExists = if ($PreVersion -ne 'unknown') { ((git tag -l "v$PreVersion") -join '').Trim() } else { '' }
  $InitialDirty = ((git status --porcelain) -join "`n").Trim()

  if (-not $SkipBump) {
    if (-not $ForceBump -and [string]::IsNullOrWhiteSpace($InitialDirty) -and [string]::IsNullOrWhiteSpace($PreTagExists) -and $PreVersion -ne 'unknown') {
      Write-Host "`n==> Working tree is clean and v$PreVersion is not yet tagged; skipping duplicate version bump (pass -ForceBump to override)." -ForegroundColor DarkGray
    } else {
      Invoke-Step -Label 'Bumping app & asset version (npm run bump)' -Command { npm run bump }
    }
  }

  # 3. Run unified verification gate (lint, typecheck, test, test:workerd, test:browser, security:scan)
  if (-not $SkipTest) {
    Invoke-Step -Label 'Running unified verification gate (npm run check)' -Command { npm run check }
  }

  $VersionSrc = Get-Content (Join-Path $RepoRoot 'src\app\version.js') -Raw
  if ($VersionSrc -match "CURRENT_APP_VERSION\s*=\s*'(\d+)'") {
    $AppVersion = $Matches[1]
  } else {
    $AppVersion = 'unknown'
  }

  # 4. Stage & commit
  $TagName = "v$AppVersion"
  $TagCreated = $false
  $ShouldTag = $TagByDefault -and (-not $NoTag) -and ($AppVersion -ne 'unknown')

  if (-not $SkipCommit) {
    if ($StagedOnly) {
      $StagedFiles = (git diff --cached --name-only) -join "`n"
      if ([string]::IsNullOrWhiteSpace($StagedFiles)) {
        Write-Host "`n==> No staged files to commit (-StagedOnly)." -ForegroundColor Yellow
      } else {
        Write-Host "`n==> Staged files to commit:" -ForegroundColor Cyan
        git diff --cached --stat
        if ([string]::IsNullOrWhiteSpace($Message)) {
          $Message = if ($DryRun) { 'release update' } else { Read-Host "Enter commit summary for v$AppVersion (leave blank for 'release update')" }
          if ([string]::IsNullOrWhiteSpace($Message)) { $Message = 'release update' }
        }
        $FullCommitMsg = "v${AppVersion}: $Message"
        Invoke-Step -Label "Committing staged files ($FullCommitMsg)" -Command { git commit -m $FullCommitMsg }
      }
    } else {
      $PendingStatus = (git status --porcelain) -join "`n"
      if ($LASTEXITCODE -ne 0) {
        throw "git status failed with exit code $LASTEXITCODE"
      }

      if ([string]::IsNullOrWhiteSpace($PendingStatus)) {
        Write-Host "`n==> No git changes to commit." -ForegroundColor Yellow
      } else {
        Write-Host "`n==> Pending working tree changes:" -ForegroundColor Cyan
        git status --short

        if ($ConfirmStaging -and (-not $Yes) -and (-not $DryRun)) {
          $Proceed = Read-Host "`nStage all changes above with 'git add -A' and commit? [Y/n]"
          if (-not [string]::IsNullOrWhiteSpace($Proceed) -and $Proceed -notmatch '^[yY](es)?$') {
            throw "Aborted before staging/committing."
          }
        }

        if ([string]::IsNullOrWhiteSpace($Message)) {
          if ($DryRun) {
            $Message = 'release update'
          } else {
            $Message = Read-Host "Enter commit summary for v$AppVersion (leave blank for 'release update')"
            if ([string]::IsNullOrWhiteSpace($Message)) {
              $Message = 'release update'
            }
          }
        }

        $FullCommitMsg = "v${AppVersion}: $Message"
        Invoke-Step -Label "Staging all changes (git add -A)" -Command { git add -A }
        Invoke-Step -Label "Committing ($FullCommitMsg)" -Command { git commit -m $FullCommitMsg }
      }
    }
  }

  # 5. Tag release if it doesn't already exist (works even when -SkipCommit is used on pre-committed merges)
  if ($ShouldTag) {
    $ExistingTag = ((git tag -l $TagName) -join '').Trim()
    if ([string]::IsNullOrWhiteSpace($ExistingTag)) {
      Invoke-Step -Label "Creating git tag ($TagName)" -Command { git tag $TagName }
      $TagCreated = $true
    } else {
      Write-Host "`n==> Tag $TagName already exists; skipping tag creation." -ForegroundColor DarkGray
    }
  }

  # 6. Deploy to Cloudflare Pages (and optional Cron Worker)
  if (-not $SkipDeploy) {
    # Load per-project Cloudflare credentials from untracked .env / .dev.vars if not already set
    foreach ($EnvFile in @('.env', '.dev.vars')) {
      $EnvPath = Join-Path $RepoRoot $EnvFile
      if (Test-Path $EnvPath) {
        foreach ($Line in Get-Content $EnvPath) {
          if ($Line -match '^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*(.+?)\s*$') {
            $Key = $Matches[1]
            $Val = $Matches[2].Trim('"').Trim("'")
            if (-not [string]::IsNullOrWhiteSpace($Val) -and [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Key, 'Process'))) {
              [Environment]::SetEnvironmentVariable($Key, $Val, 'Process')
              Write-Host "Loaded $Key from $EnvFile for Wrangler deploy." -ForegroundColor DarkGray
            }
          }
        }
      }
    }

    Invoke-Step -Label 'Deploying to Cloudflare Pages (npm run deploy)' -Command { npm run deploy }
    if ($DeployCron) {
      Invoke-Step -Label 'Deploying Standalone Cron Worker (npm run deploy:cron)' -Command { npm run deploy:cron }
    }
  }

  # 7. Push branch (and new release tag) to remote
  if ($PushByDefault -and (-not $NoPush)) {
    Invoke-Step -Label "Pushing $CurrentBranch to $RemoteName" -Command { git push $RemoteName $CurrentBranch }
    if ($TagCreated) {
      Invoke-Step -Label "Pushing tag $TagName to $RemoteName" -Command { git push $RemoteName $TagName }
    }
  }

  # 8. Post-deploy live security check (after push so network hiccups never block git push)
  if (-not $SkipDeploy) {
    Invoke-Step -Label 'Verifying live production security (npm run security:scan:live)' -Command { npm run security:scan:live }
  }

  Write-Host "`nDone! Released v$AppVersion." -ForegroundColor Green
}
finally {
  Pop-Location
}
