$ErrorActionPreference = "Stop"

$packDir = $PSScriptRoot
$projectDir = (Get-Location).Path
$packageJsonPath = Join-Path $projectDir "package.json"
$binDir = Join-Path $projectDir "node_modules\.bin"
$cliEntry = Join-Path $projectDir "node_modules\@stele\cli\dist\index.js"
$expectedVersion = "0.1.0"
$tarballs = @(
  "stele-core-0.1.0.tgz",
  "stele-backend-python-0.1.0.tgz",
  "stele-cli-0.1.0.tgz",
  "stele-claude-code-plugin-0.1.0.tgz"
) | ForEach-Object { Join-Path $packDir $_ }

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Invoke-LocalCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $Command @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  [pscustomobject]@{
    ExitCode = $exitCode
    Output = (($output | ForEach-Object { $_.ToString() }) -join "`n")
  }
}

function Repair-SteleBinShims {
  if (-not (Test-Path -LiteralPath $cliEntry)) {
    throw "Missing Stele CLI entry after install: $cliEntry"
  }

  New-Item -ItemType Directory -Force -Path $binDir | Out-Null

  Write-Utf8NoBom -Path (Join-Path $binDir "stele.cmd") -Content @'
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\..\@stele\cli\dist\index.js" %*
'@

  Write-Utf8NoBom -Path (Join-Path $binDir "stele.ps1") -Content @'
#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe" "$basedir/../@stele/cli/dist/index.js" $args
  } else {
    & "$basedir/node$exe" "$basedir/../@stele/cli/dist/index.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe" "$basedir/../@stele/cli/dist/index.js" $args
  } else {
    & "node$exe" "$basedir/../@stele/cli/dist/index.js" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
'@

  Write-Utf8NoBom -Path (Join-Path $binDir "stele") -Content @'
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=`cygpath -w "$basedir"`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node" "$basedir/../@stele/cli/dist/index.js" "$@"
else
  exec node "$basedir/../@stele/cli/dist/index.js" "$@"
fi
'@
}

function Assert-SteleCliWorks {
  $npxResult = Invoke-LocalCommand -Command "npx" -Arguments @("stele", "--version")
  if ($npxResult.ExitCode -ne 0 -or $npxResult.Output.Trim() -ne $expectedVersion) {
    throw "npx stele --version did not resolve the local Stele CLI. Expected $expectedVersion, got exit $($npxResult.ExitCode): $($npxResult.Output)"
  }

  $npmScriptResult = Invoke-LocalCommand -Command "npm" -Arguments @("run", "stele", "--", "--version")
  if ($npmScriptResult.ExitCode -ne 0 -or -not $npmScriptResult.Output.Contains($expectedVersion)) {
    throw "npm run stele -- --version did not resolve the local Stele CLI. Expected $expectedVersion, got exit $($npmScriptResult.ExitCode): $($npmScriptResult.Output)"
  }
}

foreach ($tarball in $tarballs) {
  if (-not (Test-Path -LiteralPath $tarball)) {
    throw "Missing Stele package: $tarball"
  }
}

if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  npm init -y | Out-Null
}

if (Test-Path -LiteralPath $binDir) {
  foreach ($binName in @("stele", "stele.cmd", "stele.ps1")) {
    $binPath = Join-Path $binDir $binName
    if (Test-Path -LiteralPath $binPath) {
      Remove-Item -LiteralPath $binPath -Force
    }
  }
}

$installArguments = @("install", "--save-dev", "--force") + $tarballs
$installResult = Invoke-LocalCommand -Command "npm" -Arguments $installArguments
if ($installResult.ExitCode -ne 0) {
  throw "npm install failed while installing Stele packages: $($installResult.Output)"
}
Repair-SteleBinShims

$packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
if ($null -eq $packageJson.PSObject.Properties["scripts"]) {
  $packageJson | Add-Member -MemberType NoteProperty -Name "scripts" -Value ([pscustomobject]@{})
}

$steleCommand = "node ./node_modules/@stele/cli/dist/index.js"
$scriptCommands = [ordered]@{
  "stele" = $steleCommand
  "stele:init" = "$steleCommand init --language python"
  "stele:generate" = "$steleCommand generate"
  "stele:generate:force" = "$steleCommand generate --force"
  "stele:lock" = "$steleCommand lock"
  "stele:check" = "$steleCommand check"
  "stele:list" = "$steleCommand list"
}

foreach ($entry in $scriptCommands.GetEnumerator()) {
  if ($null -eq $packageJson.scripts.PSObject.Properties[$entry.Key]) {
    $packageJson.scripts | Add-Member -MemberType NoteProperty -Name $entry.Key -Value $entry.Value
  } else {
    $packageJson.scripts.PSObject.Properties[$entry.Key].Value = $entry.Value
  }
}

$json = $packageJson | ConvertTo-Json -Depth 20
Write-Utf8NoBom -Path $packageJsonPath -Content "$json`n"
Assert-SteleCliWorks

Write-Host ""
Write-Host "Stele local packages installed."
Write-Host "Verified: npx stele --version -> $expectedVersion"
Write-Host "Next:"
Write-Host "  npm run stele:init"
Write-Host "  npm run stele:generate"
Write-Host "  python -m pytest tests/contract -q"
Write-Host "  npm run stele:lock -- --reason `"initial contract baseline`""
Write-Host "  npm run stele:check"
