# Runs typecheck + tests and writes a short summary to scripts/out/test-backend.summary.txt.
# Full output goes to scripts/out/test-backend.log.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $PSScriptRoot "out"
New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out "test-backend.log"
$summary = Join-Path $out "test-backend.summary.txt"

Push-Location $root
try {
    $tsc = & npx tsc -p tsconfig.json --noEmit 2>&1 | Out-String
    $tscCode = $LASTEXITCODE
    $vitest = & npx vitest run --reporter=default 2>&1 | Out-String
    $vitestCode = $LASTEXITCODE
} finally {
    Pop-Location
}

$clean = { param($s) $s -replace "\x1b\[[0-9;]*m", "" }
$tsc = & $clean $tsc
$vitest = & $clean $vitest
"=== tsc ===`n$tsc`n=== vitest ===`n$vitest" | Set-Content -Encoding utf8 $log

$lines = @()
$lines += "typecheck: " + ($(if ($tscCode -eq 0) { "PASS" } else { "FAIL" }))
if ($tscCode -ne 0) { $lines += ($tsc -split "`n" | Where-Object { $_ -match "error TS" } | Select-Object -First 15) }
$lines += "tests: " + ($(if ($vitestCode -eq 0) { "PASS" } else { "FAIL" }))
$lines += ($vitest -split "`n" | Where-Object { $_ -match "^\s*(Test Files|Tests)\s" })
if ($vitestCode -ne 0) {
    $lines += ($vitest -split "`n" | Where-Object { $_ -match "FAIL|AssertionError|Error:|expected|›|❯ test" } | Select-Object -First 40)
}
$lines | Set-Content -Encoding utf8 $summary
Get-Content $summary
if ($tscCode -ne 0 -or $vitestCode -ne 0) { exit 1 }
