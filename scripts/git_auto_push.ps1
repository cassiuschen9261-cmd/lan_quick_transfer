param(
    [string]$Message = "",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    git rev-parse --is-inside-work-tree *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "This folder is not a Git repository. Run git init first."
    }

    $userName = git config --get user.name
    $userEmail = git config --get user.email
    if (-not $userName -or -not $userEmail) {
        Write-Host "Git user.name or user.email is not configured." -ForegroundColor Yellow
        Write-Host "Example:" -ForegroundColor Yellow
        Write-Host "  git config user.name \"Your Name\"" -ForegroundColor Yellow
        Write-Host "  git config user.email \"you@example.com\"" -ForegroundColor Yellow
        exit 1
    }

    if (-not $SkipTests) {
        Write-Host "Running regression tests before commit..." -ForegroundColor Cyan
        npm test
        if ($LASTEXITCODE -ne 0) {
            throw "Tests failed. Commit/push aborted."
        }
    }

    $status = git status --porcelain
    if (-not $status) {
        Write-Host "No changes to commit." -ForegroundColor Green
        exit 0
    }

    if (-not $Message) {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $Message = "chore: update project at $timestamp"
    }

    git add -A
    git commit -m $Message

    $remote = git remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $remote) {
        Write-Host "Committed locally, but no GitHub remote is configured." -ForegroundColor Yellow
        Write-Host "After creating an empty GitHub repository, run:" -ForegroundColor Yellow
        Write-Host "  git remote add origin https://github.com/<user>/<repo>.git" -ForegroundColor Yellow
        Write-Host "  git branch -M main" -ForegroundColor Yellow
        Write-Host "  git push -u origin main" -ForegroundColor Yellow
        exit 0
    }

    $branch = git branch --show-current
    if (-not $branch) {
        $branch = "main"
        git branch -M $branch
    }

    Write-Host "Pushing to $remote ($branch)..." -ForegroundColor Cyan
    git push -u origin $branch
}
finally {
    Pop-Location
}
