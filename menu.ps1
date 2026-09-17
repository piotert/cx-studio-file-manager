# menu.ps1 - obsluga paczek add-inu na serwerze CX (/api/releases)
#
#   .\menu.ps1                       -> https://cx.ptrnd.pl
#   .\menu.ps1 -BaseUrl http://localhost:3000
#
# Tokeny czytane z .env.local obok skryptu (plik jest w .gitignore):
#   UPLOAD_BEARER_TOKEN   - lista i pobieranie (token zapisu, ten sam co w add-inie)
#   FEEDBACK_ADMIN_TOKEN  - publikacja (przez publish-release.ps1)
# Zmienne srodowiskowe CX_WRITE_TOKEN / CX_ADMIN_TOKEN maja pierwszenstwo.

param([string] $BaseUrl = "https://cx.ptrnd.pl")

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$DefaultSource = "D:\02. DEV\10. CX Studio\2026_SW_AddIn\SWAddIn_CX\bin\Release"

function Read-EnvLocal([string] $key) {
    $file = Join-Path $Root ".env.local"
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in Get-Content $file) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") { return $matches[1].Trim().Trim('"') }
    }
    return $null
}

function Get-WriteHeaders {
    $t = if ($env:CX_WRITE_TOKEN) { $env:CX_WRITE_TOKEN } else { Read-EnvLocal "UPLOAD_BEARER_TOKEN" }
    if (-not $t) { throw "Brak tokenu zapisu: UPLOAD_BEARER_TOKEN w .env.local" }
    return @{ Authorization = "Bearer $t" }
}

function Get-Releases {
    $res = Invoke-RestMethod -Uri "$BaseUrl/api/releases" -Headers (Get-WriteHeaders)
    return ,@($res.items)
}

function Show-Releases {
    $items = @(Get-Releases)
    if ($items.Count -eq 0) {
        Write-Host "Brak opublikowanych wersji." -ForegroundColor Yellow
        return ,$items
    }
    $n = 0
    $items | ForEach-Object {
        $n++
        [pscustomobject]@{
            Nr           = $n
            Wersja       = $_.version
            'MB'         = [math]::Round($_.sizeBytes / 1MB, 2)
            Opublikowano = if ($_.publishedAt) { ([datetime]$_.publishedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } else { '' }
            SHA256       = if ($_.sha256) { $_.sha256.Substring(0, 12) + '...' } else { '' }
            Notatki      = $_.notes
        }
    } | Format-Table -AutoSize | Out-Host
    Write-Host "Najnowsza: $($items[0].version)   (serwer trzyma najnowsza + 3 wstecz)" -ForegroundColor Cyan
    return ,$items
}

function Get-NextVersion($items) {
    if ($items.Count -eq 0) { return "" }
    $p = $items[0].version.Split('.')
    $p[-1] = [string]([int]$p[-1] + 1)
    return ($p -join '.')
}

function Invoke-Upload {
    $suggest = Get-NextVersion @(Get-Releases)

    $v = Read-Host "Wersja [$suggest]"
    if (-not $v) { $v = $suggest }
    $src = Read-Host "Folder albo plik .zip [$DefaultSource]"
    if (-not $src) { $src = $DefaultSource }
    $src = $src.Trim().Trim('"')
    $notes = Read-Host "Notatki (Enter = brak)"

    Write-Host ""
    Write-Host "Wersja : $v"
    Write-Host "Zrodlo : $src"
    Write-Host "Serwer : $BaseUrl"
    $ok = Read-Host "Publikowac? [t/N]"
    if ($ok -notin @('t', 'T', 'y', 'Y')) { Write-Host "Anulowano."; return }

    & (Join-Path $Root "publish-release.ps1") -Version $v -Source $src -Notes $notes -BaseUrl $BaseUrl
}

function Invoke-Download {
    $items = Show-Releases
    if ($items.Count -eq 0) { return }

    $sel = Read-Host "Nr wersji [1 = najnowsza]"
    if (-not $sel) { $sel = '1' }
    $idx = 0
    if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 1 -or $idx -gt $items.Count) {
        Write-Host "Nieprawidlowy numer." -ForegroundColor Red; return
    }
    $rel = $items[$idx - 1]

    $defaultDest = Join-Path $HOME "Downloads"
    $dest = Read-Host "Folder docelowy [$defaultDest]"
    if (-not $dest) { $dest = $defaultDest }
    $dest = $dest.Trim().Trim('"')
    if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }
    $file = Join-Path $dest "SWAddIn_CX-$($rel.version).zip"

    # ?json=1 -> sam link; drugie zapytanie idzie BEZ tokenu (uprawnienie jest w URL-u)
    $info = Invoke-RestMethod -Uri "$BaseUrl/api/releases/$($rel.version)/download?json=1" -Headers (Get-WriteHeaders)
    Invoke-WebRequest -Uri $info.url -OutFile $file -UseBasicParsing

    $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    $size = (Get-Item $file).Length
    if ($hash -ne $info.sha256 -or $size -ne $info.sizeBytes) {
        Remove-Item $file -Force
        throw "Plik uszkodzony - usuniety. SHA serwer: $($info.sha256), pobrany: $hash; rozmiar $($info.sizeBytes) vs $size"
    }
    Write-Host "Pobrano $file ($([math]::Round($size/1MB,2)) MB), SHA-256 zgodny." -ForegroundColor Green
}

function Show-Error($err) {
    $msg = if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $err.ErrorDetails.Message } else { $err.Exception.Message }
    $code = $null
    try { $code = [int]$err.Exception.Response.StatusCode } catch { }
    $hint = switch ($code) {
        401     { " -> zly lub brakujacy token w .env.local" }
        404     { " -> brak takiej wersji albo pliku" }
        409     { " -> ta wersja jest juz opublikowana, podaj nowy numer" }
        500     { " -> blad serwera, sprawdz logi Vercela" }
        default { "" }
    }
    Write-Host "BLAD$(if ($code) { " [$code]" }): $msg$hint" -ForegroundColor Red
}

while ($true) {
    Write-Host ""
    Write-Host "=== Paczki SWAddIn_CX  ($BaseUrl) ===" -ForegroundColor Cyan
    Write-Host "  1. Wyswietl wersje na serwerze"
    Write-Host "  2. Zaladuj nowy ZIP"
    Write-Host "  3. Pobierz wersje"
    Write-Host "  0. Wyjscie"
    $choice = Read-Host "Wybor"

    try {
        switch ($choice) {
            '1' { Show-Releases | Out-Null }
            '2' { Invoke-Upload }
            '3' { Invoke-Download }
            '0' { return }
            default { Write-Host "Nieznana opcja." -ForegroundColor Yellow }
        }
    }
    catch {
        Show-Error $_
    }
}
