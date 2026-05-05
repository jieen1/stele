$ErrorActionPreference = "Stop"

$packDir = $PSScriptRoot
$projectDir = (Get-Location).Path
$packageJsonPath = Join-Path $projectDir "package.json"
$tarballs = @(
  "stele-core-0.1.0.tgz",
  "stele-backend-python-0.1.0.tgz",
  "stele-cli-0.1.0.tgz",
  "stele-claude-code-plugin-0.1.0.tgz"
) | ForEach-Object { Join-Path $packDir $_ }

foreach ($tarball in $tarballs) {
  if (-not (Test-Path -LiteralPath $tarball)) {
    throw "Missing Stele package: $tarball"
  }
}

if (-not (Test-Path -LiteralPath $packageJsonPath)) {
  npm init -y | Out-Null
}

npm install --save-dev @tarballs

$packageJson = Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json
if ($null -eq $packageJson.PSObject.Properties["scripts"]) {
  $packageJson | Add-Member -MemberType NoteProperty -Name "scripts" -Value ([pscustomobject]@{})
}

$scriptCommands = [ordered]@{
  "stele:init" = "stele init --language python"
  "stele:generate" = "stele generate"
  "stele:generate:force" = "stele generate --force"
  "stele:lock" = "stele lock"
  "stele:check" = "stele check"
  "stele:list" = "stele list"
}

foreach ($entry in $scriptCommands.GetEnumerator()) {
  if ($null -eq $packageJson.scripts.PSObject.Properties[$entry.Key]) {
    $packageJson.scripts | Add-Member -MemberType NoteProperty -Name $entry.Key -Value $entry.Value
  } else {
    $packageJson.scripts.PSObject.Properties[$entry.Key].Value = $entry.Value
  }
}

$json = $packageJson | ConvertTo-Json -Depth 20
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($packageJsonPath, "$json`n", $utf8NoBom)

Write-Host ""
Write-Host "Stele local packages installed."
Write-Host "Next:"
Write-Host "  npm run stele:init"
Write-Host "  npm run stele:generate"
Write-Host "  python -m pytest tests/contract -q"
Write-Host "  npm run stele:lock -- --reason `"initial contract baseline`""
Write-Host "  npm run stele:check"
