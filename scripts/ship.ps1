<#
.SYNOPSIS
  Test, version-bump, commit, and deploy Pickup Baseball + Clubhouse to Cloudflare Pages.

.DESCRIPTION
  Editable release workflow script. By default, runs the test suite, bumps the cache/app
  version (`npm run bump`), commits all working-tree changes to git, and deploys `public/`
  (plus Cloudflare Pages Functions under `functions/`) via `npm run deploy`.

.EXAMPLE
  .\scripts\ship.ps1 -Message "Update clubhouse behavior covenant"
  .\scripts\ship.ps1 -Message "Hotfix schedule" -Push
  .\scripts\ship.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$Message = '',
  [switch]$SkipTest,
  [switch]$SkipBump,
  [switch]$Push,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# Editable defaults
$DefaultBranch = 'trunk'
$RemoteName = 'origin'

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
  if (-not $SkipTest) {
    Invoke-Step -Label 'Running test suite (npm test)' -Command { npm test }
  }

  if (-not $SkipBump) {
    Invoke-Step -Label 'Bumping app & asset version (npm run bump)' -Command { npm run bump }
  }

  $VersionSrc = Get-Content (Join-Path $RepoRoot 'src\app\version.js') -Raw
  if ($VersionSrc -match "CURRENT_APP_VERSION\s*=\s*'(\d+)'") {
    $AppVersion = $Matches[1]
  } else {
    $AppVersion = 'unknown'
  }

  $PendingStatus = (git status --porcelain) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "git status failed with exit code $LASTEXITCODE"
  }

  if ([string]::IsNullOrWhiteSpace($PendingStatus)) {
    Write-Host "`n==> No git changes to commit." -ForegroundColor Yellow
  } else {
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

  Invoke-Step -Label 'Deploying to Cloudflare Pages (npm run deploy)' -Command { npm run deploy }

  if ($Push) {
    Invoke-Step -Label "Pushing to $RemoteName/$DefaultBranch" -Command { git push $RemoteName $DefaultBranch }
  }

  Write-Host "`nDone! Released v$AppVersion." -ForegroundColor Green
}
finally {
  Pop-Location
}
