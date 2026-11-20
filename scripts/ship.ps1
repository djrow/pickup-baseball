<#
.SYNOPSIS
  Bump version, test, commit, tag, push to GitHub (triggering CI & Cloudflare Pages deploy), and verify live production.

.DESCRIPTION
  Editable release workflow script for both interactive human releases and non-interactive agent releases.
  Default flow (GitHub Actions CI & Security Audit deploy):
    1. Verify current git branch matches $DefaultBranch (unless -AllowWrongBranch)
    2. Bump app & cache version (npm run bump) — auto-skipped if working tree is clean and current version is not yet tagged (e.g. after merging a pre-bumped branch), unless -ForceBump is passed
    3. Run the unified verification gate on the bumped files (npm run check)
    4. Show `git status --short`, confirm staging, prompt for commit summary if -Message wasn't passed, and commit
    5. Create git tag `v<version>` (even if -SkipCommit was used or changes were already committed)
    6. Push branch and tag to GitHub (`origin/trunk`), triggering `.github/workflows/security.yml` (CI checks + Cloudflare Pages deploy)
    7. Wait for the GitHub Actions workflow (`security.yml`) to finish (via `gh` CLI, unless -NoWait, -NoPush, or -SkipDeploy)
    8. Optionally deploy locally (`-LocalDeploy`) and/or deploy the Cron Worker (`npm run deploy:cron` via `-DeployCron`)
    9. Run live production security verification (`npm run security:scan:live`, unless -SkipDeploy or -NoWait)

  You do NOT need to edit this file for commit messages: pass `-Message "..."` when
  running it, or just run `.\scripts\ship.ps1` and type the message when prompted.
  Agents should pass `-Message "..." -Yes` for non-interactive execution.

.EXAMPLE
  .\scripts\ship.ps1
  .\scripts\ship.ps1 -Message "Change sportsmanship to goodwill"
  .\scripts\ship.ps1 -Message "Quick fix" -Yes
  .\scripts\ship.ps1 -NoWait -Message "Push and let CI finish in background" -Yes
  .\scripts\ship.ps1 -LocalDeploy -DeployCron -Message "Update reminder worker" -Yes
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
  [switch]$LocalDeploy,
  [switch]$DeployCron,
  [switch]$NoWait,
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

  # 6. Push branch (and new release tag) to GitHub — triggers CI & Security Audit + Cloudflare Pages deploy
  $PushedToRemote = $false
  if ($PushByDefault -and (-not $NoPush)) {
    Invoke-Step -Label "Pushing $CurrentBranch to $RemoteName" -Command { git push $RemoteName $CurrentBranch }
    if ($TagCreated) {
      Invoke-Step -Label "Pushing tag $TagName to $RemoteName" -Command { git push $RemoteName $TagName }
    }
    $PushedToRemote = $true
  }

  # 7. Wait for GitHub Actions CI & Security Audit deploy workflow (unless -LocalDeploy, -SkipDeploy, -NoPush, or -NoWait)
  $CiCompleted = $false
  if ($PushedToRemote -and (-not $SkipDeploy) -and (-not $LocalDeploy) -and (-not $NoWait)) {
    $GhCmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($GhCmd) {
      $HeadSha = ("$((git rev-parse HEAD) -join '')").Trim()
      Invoke-Step -Label "Waiting for GitHub Actions CI & Deploy (security.yml @ $($HeadSha.Substring(0, [Math]::Min(7, $HeadSha.Length))))" -Command {
        $RunId = ''
        for ($i = 0; $i -lt 15; $i++) {
          $RunId = ("$((gh run list --workflow=security.yml --branch $CurrentBranch --commit $HeadSha --limit 1 --json databaseId --jq '.[0].databaseId' 2>$null) -join '')").Trim()
          if (-not [string]::IsNullOrWhiteSpace($RunId)) { break }
          Start-Sleep -Seconds 2
        }
        if ([string]::IsNullOrWhiteSpace($RunId)) {
          Write-Host "    Could not locate workflow run yet; check GitHub Actions tab." -ForegroundColor Yellow
          return
        }
        Write-Host "    Watching GitHub Actions run #$RunId..." -ForegroundColor DarkGray
        gh run watch $RunId --exit-status
      }
      $CiCompleted = $true
    } else {
      Write-Host "`n==> GitHub CLI (gh) not found; skipping CI wait. Monitor deploy in GitHub Actions." -ForegroundColor Yellow
    }
  }

  # 8. Optional local Cloudflare deploy (-LocalDeploy) and/or standalone Cron Worker (-DeployCron)
  if ((-not $SkipDeploy) -and ($LocalDeploy -or $DeployCron)) {
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

    if ($LocalDeploy) {
      Invoke-Step -Label 'Deploying locally to Cloudflare Pages (npm run deploy)' -Command { npm run deploy }
    }
    if ($DeployCron) {
      Invoke-Step -Label 'Deploying Standalone Cron Worker (npm run deploy:cron)' -Command { npm run deploy:cron }
    }
  }

  # 9. Post-deploy live security check (runs after CI deploy finishes or after -LocalDeploy)
  if ((-not $SkipDeploy) -and ($CiCompleted -or $LocalDeploy)) {
    Invoke-Step -Label 'Verifying live production security (npm run security:scan:live)' -Command { npm run security:scan:live }
  } elseif ((-not $SkipDeploy) -and $PushedToRemote) {
    Write-Host "`n==> Skipping local live security scan because CI deploy is still running. Run 'npm run security:scan:live' once GitHub Actions finishes." -ForegroundColor DarkGray
  }

  Write-Host "`nDone! Released v$AppVersion." -ForegroundColor Green
}
finally {
  Pop-Location
}
