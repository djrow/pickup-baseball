<#
.SYNOPSIS
  Bump version, test, commit, tag, deploy to Cloudflare Pages, and push to GitHub.

.DESCRIPTION
  Editable release workflow script.
  Default flow:
    1. Verify current git branch matches $DefaultBranch (unless -AllowWrongBranch)
    2. Bump app & cache version (npm run bump)
    3. Run the full test suite on the bumped files (npm test)
    4. Show `git status --short`, confirm staging, prompt for commit summary if -Message wasn't passed, and commit
    5. Create git tag `v<version>`
    6. Deploy to Cloudflare Pages (`npm run deploy`)
    7. Push branch and tag to GitHub (`origin/trunk`)

  You do NOT need to edit this file for commit messages: pass `-Message "..."` when
  running it, or just run `.\scripts\ship.ps1` and type the message when prompted.

.EXAMPLE
  .\scripts\ship.ps1
  .\scripts\ship.ps1 -Message "Change sportsmanship to goodwill"
  .\scripts\ship.ps1 -Message "Quick fix" -Yes
  .\scripts\ship.ps1 -NoPush -SkipDeploy
  .\scripts\ship.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Message = '',
  [switch]$SkipBump,
  [switch]$SkipTest,
  [switch]$SkipCommit,
  [switch]$SkipDeploy,
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
  if (-not $SkipBump) {
    Invoke-Step -Label 'Bumping app & asset version (npm run bump)' -Command { npm run bump }
  }

  # 3. Run full verification suite & security scan
  if (-not $SkipTest) {
    Invoke-Step -Label 'Running test suite (npm test)' -Command { npm test }
    Invoke-Step -Label 'Running security scan (npm run security:scan)' -Command { npm run security:scan }
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

    # 5. Tag release if it doesn't already exist
    if ($ShouldTag) {
      $ExistingTag = ((git tag -l $TagName) -join '').Trim()
      if ([string]::IsNullOrWhiteSpace($ExistingTag)) {
        Invoke-Step -Label "Creating git tag ($TagName)" -Command { git tag $TagName }
        $TagCreated = $true
      } else {
        Write-Host "`n==> Tag $TagName already exists; skipping tag creation." -ForegroundColor DarkGray
      }
    }
  }

  # 6. Deploy to Cloudflare Pages
  if (-not $SkipDeploy) {
    Invoke-Step -Label 'Deploying to Cloudflare Pages (npm run deploy)' -Command { npm run deploy }
  }

  # 7. Push branch (and new release tag) to remote
  if ($PushByDefault -and (-not $NoPush)) {
    Invoke-Step -Label "Pushing $CurrentBranch to $RemoteName" -Command { git push $RemoteName $CurrentBranch }
    if ($TagCreated) {
      Invoke-Step -Label "Pushing tag $TagName to $RemoteName" -Command { git push $RemoteName $TagName }
    }
  }

  Write-Host "`nDone! Released v$AppVersion." -ForegroundColor Green
}
finally {
  Pop-Location
}
