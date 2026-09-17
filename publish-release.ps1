# publish-release.ps1
# Publikuje paczke add-inu na serwerze CX (max RELEASES_KEEP wersji, domyslnie najnowsza + 3 wstecz).
#
# Uzycie:
#   (token admina: FEEDBACK_ADMIN_TOKEN w .env.local albo zmienna CX_ADMIN_TOKEN)
#   .\publish-release.ps1 -Version 1.2.32 -Source "D:\...\bin\Release" -Notes "Opis zmian"
#   .\publish-release.ps1 -Version 1.2.32 -Source ".\paczka.zip"
#   -Quiet : bez wypisywania, zwraca obiekt z wynikiem (uzywa menu.ps1)
#
# Przeplyw: POST /api/releases -> PUT ZIP na signed URL -> POST /finalize (serwer liczy SHA-256).

param(
    [Parameter(Mandatory)] [string] $Version,
    [Parameter(Mandatory)] [string] $Source,
    [string] $Notes = "",
    [string] $BaseUrl = "https://cx.ptrnd.pl",
    [switch] $Quiet
)

$ErrorActionPreference = "Stop"

function Say([string] $text, [string] $color = "Gray") {
    if (-not $Quiet) { Write-Host $text -ForegroundColor $color }
}

# Token admina: zmienna CX_ADMIN_TOKEN albo FEEDBACK_ADMIN_TOKEN z .env.local obok skryptu.
# .env.local jest w .gitignore - token nigdy nie trafia do repo.
function Read-EnvLocal([string] $key) {
    $file = Join-Path $PSScriptRoot ".env.local"
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in Get-Content $file) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") { return $matches[1].Trim().Trim('"') }
    }
    return $null
}

# Blad HTTP -> czytelny komunikat "krok: HTTP 409 {error}".
function Invoke-Step([string] $name, [scriptblock] $action) {
    try { return & $action }
    catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        if ($code) { throw "${name}: HTTP $code $detail" } else { throw "${name}: $detail" }
    }
}

$token = if ($env:CX_ADMIN_TOKEN) { $env:CX_ADMIN_TOKEN } else { Read-EnvLocal "FEEDBACK_ADMIN_TOKEN" }
if (-not $token) { throw "Brak tokenu admina: dopisz FEEDBACK_ADMIN_TOKEN=... do .env.local" }
if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw "Wersja musi miec postac x.y.z (podano: '$Version')" }

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
    throw "Zrodlo musi byc folderem albo plikiem .zip: $Source"
}

$localHash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $zip).Length
Say "Paczka: $zip ($([math]::Round($size/1MB,2)) MB)"
Say "SHA-256 lokalnie: $localHash"

$headers = @{ Authorization = "Bearer $token" }

try {
    # --- 1. Zapowiedz wersji ---
    $body = @{ version = $Version; notes = $Notes } | ConvertTo-Json
    $created = Invoke-Step "Zapowiedz wersji" {
        Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/releases" -Headers $headers `
            -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
    }

    # --- 2. Upload prosto do Storage (BEZ naglowka Authorization) ---
    Invoke-Step "Upload" {
        Invoke-RestMethod -Method Put -Uri $created.upload.url -ContentType "application/zip" -InFile $zip | Out-Null
    }
    Say "Upload OK"

    # --- 3. Finalizacja ---
    $result = Invoke-Step "Finalizacja" {
        Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/releases/$Version/finalize" -Headers $headers
    }
}
finally {
    if ($tempZip -and (Test-Path $tempZip)) { Remove-Item $tempZip }
}

if ($result.sha256 -ne $localHash) {
    throw "NIEZGODNY HASH! serwer: $($result.sha256) lokalnie: $localHash"
}

$removed = @($result.removed)

if ($Quiet) {
    return [pscustomobject]@{
        Version   = $result.version
        Sha256    = $result.sha256
        SizeBytes = [long]$result.sizeBytes
        Removed   = $removed
        Source    = $Source
    }
}

Say "Opublikowano $($result.version), SHA-256 zgodny." "Green"
if ($removed.Count -gt 0) {
    Say "Usuniete stare wersje: $($removed -join ', ')" "Yellow"
}
