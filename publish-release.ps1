# publish-release.ps1
# Publikuje paczke add-inu na serwerze CX (max RELEASES_KEEP wersji, domyslnie najnowsza + 3 wstecz).
#
# Uzycie:
#   $env:CX_ADMIN_TOKEN = "<FEEDBACK_ADMIN_TOKEN>"
#   .\publish-release.ps1 -Version 1.2.32 -Source "D:\...\bin\Release" -Notes "Opis zmian"
#   .\publish-release.ps1 -Version 1.2.32 -Source ".\paczka.zip"
#
# Przeplyw: POST /api/releases -> PUT ZIP na signed URL -> POST /finalize (serwer liczy SHA-256).

param(
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $Source,
    [string] $Notes = "",
    [string] $BaseUrl = "https://cx.ptrnd.pl"
)

$ErrorActionPreference = "Stop"

$token = $env:CX_ADMIN_TOKEN
if (-not $token) { throw "Brak zmiennej CX_ADMIN_TOKEN (token admina)." }
if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw "Wersja musi miec postac x.y.z" }

# --- Paczka ---
$tempZip = $null
if (Test-Path $Source -PathType Container) {
    $tempZip = Join-Path $env:TEMP "SWAddIn_CX-$Version.zip"
    if (Test-Path $tempZip) { Remove-Item $tempZip }
    Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $tempZip
    $zip = $tempZip
} elseif ($Source -like '*.zip' -and (Test-Path $Source)) {
    $zip = (Resolve-Path $Source).Path
} else {
    throw "Source musi byc folderem albo plikiem .zip: $Source"
}

$localHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $zip).Length
Write-Host "Paczka: $zip ($([math]::Round($size/1MB,2)) MB)"
Write-Host "SHA-256 lokalnie: $localHash"

$headers = @{ Authorization = "Bearer $token" }

try {
    # --- 1. Zapowiedz wersji ---
    $body = @{ version = $Version; notes = $Notes } | ConvertTo-Json
    $created = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/releases" -Headers $headers `
        -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))

    # --- 2. Upload prosto do Storage (BEZ naglowka Authorization) ---
    Invoke-RestMethod -Method Put -Uri $created.upload.url -ContentType "application/zip" -InFile $zip | Out-Null
    Write-Host "Upload OK"

    # --- 3. Finalizacja ---
    $result = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/releases/$Version/finalize" -Headers $headers
}
finally {
    if ($tempZip -and (Test-Path $tempZip)) { Remove-Item $tempZip }
}

if ($result.sha256 -ne $localHash) {
    throw "NIEZGODNY HASH! serwer: $($result.sha256) lokalnie: $localHash"
}

Write-Host "Opublikowano $($result.version), SHA-256 zgodny." -ForegroundColor Green
if ($result.removed.Count -gt 0) {
    Write-Host "Usuniete stare wersje: $($result.removed -join ', ')" -ForegroundColor Yellow
}
