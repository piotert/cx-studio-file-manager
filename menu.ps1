#Requires -Version 7
# menu.ps1 - obsluga paczek add-inu na serwerze CX (/api/releases), interfejs Spectre.Console
#
#   pwsh .\menu.ps1
#   pwsh .\menu.ps1 -BaseUrl http://localhost:3000
#
# Tokeny czytane z .env.local obok skryptu (plik jest w .gitignore):
#   UPLOAD_BEARER_TOKEN   - lista i pobieranie (token zapisu, ten sam co w add-inie)
#   FEEDBACK_ADMIN_TOKEN  - publikacja (przez publish-release.ps1)
# Zmienne srodowiskowe CX_WRITE_TOKEN / CX_ADMIN_TOKEN maja pierwszenstwo.

param([string] $BaseUrl = "https://cx.ptrnd.pl")

$ErrorActionPreference = "Stop"
$OutputEncoding = [console]::InputEncoding = [console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

if (-not (Get-Module -ListAvailable -Name PwshSpectreConsole)) {
    Write-Host "Instaluje PwshSpectreConsole..." -ForegroundColor DarkGray
    Install-Module PwshSpectreConsole -Scope CurrentUser -Force
}
Import-Module PwshSpectreConsole

$Root          = $PSScriptRoot
$DefaultSource = "D:\02. DEV\10. CX Studio\2026_SW_AddIn\SWAddIn_CX\bin\Release"
$Accent        = "DeepSkyBlue1"
$VersionRegex  = '^\d+\.\d+\.\d+(\.\d+)?$'

# ---------------------------------------------------------------- narzedzia

function Esc([object] $text) {
    $s = [string]$text
    if ([string]::IsNullOrEmpty($s)) { return '' }
    return Get-SpectreEscapedText -Text $s
}

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
    if (-not $t) { throw "Brak tokenu zapisu: dopisz UPLOAD_BEARER_TOKEN=... do .env.local" }
    return @{ Authorization = "Bearer $t" }
}

function Get-Hint([int] $code) {
    switch ($code) {
        401 { " - zły lub brakujący token w .env.local" }
        404 { " - brak takiej wersji albo pliku" }
        409 { " - ta wersja jest już opublikowana, podaj nowy numer" }
        { $_ -ge 500 } { " - błąd serwera, sprawdź logi Vercela" }
        default { "" }
    }
}

# GET z tokenem zapisu; blad HTTP -> wyjatek z czytelnym komunikatem.
function Invoke-Api([string] $Uri) {
    $r = Invoke-WebRequest -Uri $Uri -Headers (Get-WriteHeaders) -SkipHttpErrorCheck
    if ($r.StatusCode -ge 400) {
        $msg = try { ($r.Content | ConvertFrom-Json).error } catch { $r.Content }
        throw "HTTP $($r.StatusCode): $msg$(Get-Hint $r.StatusCode)"
    }
    return $r.Content | ConvertFrom-Json
}

function Get-Releases { return ,@((Invoke-Api "$BaseUrl/api/releases").items) }

function Get-ReleasesWithStatus {
    $items = Invoke-SpectreCommandWithStatus -Title "Pobieram liste z serwera..." -Spinner Dots -Color $Accent -ScriptBlock {
        Get-Releases
    }
    return ,@($items)
}

function Format-Size([long] $bytes) { "{0:N2} MB" -f ($bytes / 1MB) }

function Get-InnerMessage($err) {
    $ex = $err.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    return $ex.Message
}

function Show-Success([string] $header, [string] $body) {
    Format-SpectrePanel -Data $body -Header "[green]$header[/]" -Color Green -Expand | Out-SpectreHost
}

# ---------------------------------------------------------------- widoki

function Show-ReleasesTable($items) {
    if ($items.Count -eq 0) {
        Format-SpectrePanel -Data "[yellow]Na serwerze nie ma jeszcze żadnej opublikowanej wersji.[/]" `
            -Header "Wersje" -Color Yellow -Expand | Out-SpectreHost
        return
    }

    $n = 0
    $rows = foreach ($r in $items) {
        $n++
        $ver = if ($n -eq 1) { "[green bold]$(Esc $r.version)[/] [green]● najnowsza[/]" } else { Esc $r.version }
        [pscustomobject]@{
            '#'            = $n
            'Wersja'       = $ver
            'Rozmiar'      = Format-Size $r.sizeBytes
            'Opublikowano' = if ($r.publishedAt) { ([datetime]$r.publishedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } else { '' }
            'SHA-256'      = if ($r.sha256) { "[grey]$($r.sha256.Substring(0, 16))…[/]" } else { '' }
            'Notatki'      = Esc $r.notes
        }
    }

    Format-SpectreTable -Data $rows -Title "Wersje na $(Esc $BaseUrl)" -Color $Accent -HeaderColor $Accent -AllowMarkup -Expand |
        Out-SpectreHost
    Write-SpectreHost "[grey]Serwer trzyma najnowszą wersję + 3 wstecz. Starsze znikają przy kolejnej publikacji.[/]"
}

function Get-NextVersion($items) {
    if ($items.Count -eq 0) { return "" }
    $p = $items[0].version.Split('.')
    $p[-1] = [string]([int]$p[-1] + 1)
    return ($p -join '.')
}

function Get-SourceSummary([string] $src) {
    if (Test-Path $src -PathType Container) {
        $files = @(Get-ChildItem $src -Recurse -File)
        $bytes = ($files | Measure-Object Length -Sum).Sum
        $dlls  = @($files | Where-Object Extension -eq '.dll')
        $main  = Join-Path $src 'SWAddIn_CX.dll'
        $fv    = if (Test-Path $main) { (Get-Item $main).VersionInfo.FileVersion } else { $null }
        return [pscustomobject]@{
            Opis        = "folder: $($files.Count) plików, $($dlls.Count) DLL, $(Format-Size $bytes) przed spakowaniem"
            FileVersion = $fv
        }
    }
    if ($src -like '*.zip' -and (Test-Path $src -PathType Leaf)) {
        return [pscustomobject]@{ Opis = "gotowy ZIP, $(Format-Size (Get-Item $src).Length)"; FileVersion = $null }
    }
    return $null
}

# ---------------------------------------------------------------- akcje

function Invoke-Upload {
    $items   = Get-ReleasesWithStatus
    $suggest = Get-NextVersion $items
    if ($items.Count -gt 0) {
        Write-SpectreHost "Najnowsza na serwerze: [green]$(Esc $items[0].version)[/]"
    }

    $src = Read-SpectreText -Message "Folder albo plik .zip" -DefaultAnswer $DefaultSource
    $src = $src.Trim().Trim('"')
    $summary = Get-SourceSummary $src
    if (-not $summary) { throw "Nie ma takiego folderu ani pliku .zip: $src" }
    Write-SpectreHost "[grey]$(Esc $summary.Opis)[/]"
    if ($summary.FileVersion) {
        Write-SpectreHost "[grey]FileVersion SWAddIn_CX.dll: [/][white]$(Esc $summary.FileVersion)[/]"
    }

    do {
        $v = if ($suggest) {
            Read-SpectreText -Message "Wersja" -DefaultAnswer $suggest
        } else {
            Read-SpectreText -Message "Wersja (x.y.z)"
        }
        $v = $v.Trim()
        $ok = $v -match $VersionRegex
        if (-not $ok) { Write-SpectreHost "[red]Wersja musi mieć postać x.y.z albo x.y.z.w[/]" }
    } until ($ok)

    # Updater porownuje FileVersion z pliku - rozjazd = aktualizacja w kolko albo wcale.
    $fv = $null
    if ($summary.FileVersion -and [version]::TryParse((($summary.FileVersion -split '[ ,]')[0]), [ref]$fv)) {
        $pv = [version]$v
        $norm = { param($x) [version]::new($x.Major, $x.Minor, [math]::Max($x.Build, 0), [math]::Max($x.Revision, 0)) }
        if ((& $norm $fv) -ne (& $norm $pv)) {
            Format-SpectrePanel -Color Orange1 -Expand -Header "[orange1]Uwaga[/]" -Data (
                "FileVersion w DLL to [bold]$(Esc $summary.FileVersion)[/], a publikujesz jako [bold]$(Esc $v)[/].`n" +
                "Updater porównuje FileVersion z pliku - po instalacji add-in będzie widział inną wersję niż serwer."
            ) | Out-SpectreHost
        }
    }

    $notes = Read-SpectreText -Message "Notatki [grey](Enter = brak)[/]" -AllowEmpty

    Format-SpectreTable -Color $Accent -HideHeaders -Data @(
        [pscustomobject]@{ K = 'Wersja';  V = "[bold]$(Esc $v)[/]" }
        [pscustomobject]@{ K = 'Źródło';  V = Esc $src }
        [pscustomobject]@{ K = 'Notatki'; V = if ($notes) { Esc $notes } else { '[grey]-[/]' } }
        [pscustomobject]@{ K = 'Serwer';  V = Esc $BaseUrl }
    ) -AllowMarkup | Out-SpectreHost

    if (-not (Read-SpectreConfirm -Message "Publikować?" -DefaultAnswer 'n')) {
        Write-SpectreHost "[grey]Anulowano.[/]"
        return
    }

    $script = Join-Path $Root "publish-release.ps1"
    $result = Invoke-SpectreCommandWithStatus -Title "Pakuję, wysyłam i weryfikuję SHA-256..." -Spinner Dots -Color $Accent -ScriptBlock {
        & $script -Version $v -Source $src -Notes $notes -BaseUrl $BaseUrl -Quiet
    }.GetNewClosure()

    $removed = if ($result.Removed.Count -gt 0) { "[yellow]$(Esc ($result.Removed -join ', '))[/]" } else { '[grey]nic[/]' }
    Show-Success "Opublikowano $(Esc $result.Version)" (
        "Rozmiar:  $(Format-Size $result.SizeBytes)`n" +
        "SHA-256:  $($result.Sha256) [green](zgodny z lokalnym)[/]`n" +
        "Usunięte: $removed"
    )
    Write-SpectreHost "[grey]/api/update nie zmienia się sam - przestaw app_release ręcznie (docs/RELEASES.md §6).[/]"
}

function Invoke-Download {
    $items = Get-ReleasesWithStatus
    Show-ReleasesTable $items
    if ($items.Count -eq 0) { return }

    $n = 0
    $choices = foreach ($r in $items) {
        $n++
        $tag = if ($n -eq 1) { '  (najnowsza)' } else { '' }
        [pscustomobject]@{
            Label   = "$($r.version)$tag  -  $(Format-Size $r.sizeBytes)"
            Release = $r
        }
    }
    $picked = Read-SpectreSelection -Message "Którą wersję pobrać?" -Choices $choices -ChoiceLabelProperty Label -Color $Accent
    $rel = $picked.Release

    $defaultDest = Join-Path $HOME "Downloads"
    $dest = (Read-SpectreText -Message "Folder docelowy" -DefaultAnswer $defaultDest).Trim().Trim('"')
    $file = Join-Path $dest "SWAddIn_CX-$($rel.version).zip"
    if (Test-Path $file) {
        if (-not (Read-SpectreConfirm -Message "Plik $(Esc $file) istnieje. Nadpisać?" -DefaultAnswer 'n')) {
            Write-SpectreHost "[grey]Anulowano.[/]"
            return
        }
    }

    $headers = Get-WriteHeaders
    $infoUri = "$BaseUrl/api/releases/$($rel.version)/download?json=1"

    $outcome = Invoke-SpectreCommandWithStatus -Title "Pobieram $($rel.version)..." -Spinner Dots -Color $Accent -ScriptBlock {
        if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }

        # 1. link z tokenem, 2. sam plik BEZ tokenu (uprawnienie jest w URL-u)
        $r = Invoke-WebRequest -Uri $infoUri -Headers $headers -SkipHttpErrorCheck
        if ($r.StatusCode -ge 400) {
            $msg = try { ($r.Content | ConvertFrom-Json).error } catch { $r.Content }
            throw "HTTP $($r.StatusCode): $msg"
        }
        $info = $r.Content | ConvertFrom-Json

        Invoke-WebRequest -Uri $info.url -OutFile $file

        $hash = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
        $size = (Get-Item $file).Length
        if ($hash -ne $info.sha256 -or $size -ne [long]$info.sizeBytes) {
            Remove-Item $file -Force
            throw "Plik uszkodzony i usunięty. SHA serwer $($info.sha256), pobrany $hash; rozmiar $($info.sizeBytes) vs $size"
        }
        [pscustomobject]@{ Hash = $hash; Size = $size }
    }.GetNewClosure()

    Show-Success "Pobrano $(Esc $rel.version)" (
        "Plik:     $(Esc $file)`n" +
        "Rozmiar:  $(Format-Size $outcome.Size)`n" +
        "SHA-256:  $($outcome.Hash) [green](zgodny z serwerem)[/]"
    )
}

# ---------------------------------------------------------------- petla glowna

$menu = [ordered]@{
    'Wyświetl wersje na serwerze' = { Show-ReleasesTable (Get-ReleasesWithStatus) }
    'Załaduj nowy ZIP'            = { Invoke-Upload }
    'Pobierz wersję'              = { Invoke-Download }
    'Wyjście'                     = $null
}

Clear-Host
Write-SpectreFigletText -Text "CX Releases" -Color $Accent
Write-SpectreRule -Title "[grey]$(Esc $BaseUrl)[/]" -Color $Accent

while ($true) {
    Write-SpectreHost ""
    $choice = Read-SpectreSelection -Message "[bold]Co robimy?[/]" -Choices @($menu.Keys) -Color $Accent
    $action = $menu[$choice]
    if (-not $action) { break }

    Write-SpectreRule -Title "[bold]$choice[/]" -Color $Accent -Alignment Left
    try {
        & $action
    }
    catch {
        Format-SpectrePanel -Data "[red]$(Esc (Get-InnerMessage $_))[/]" -Header "[red]Błąd[/]" -Color Red -Expand |
            Out-SpectreHost
    }
    Read-SpectrePause -Message "[grey]Enter - powrót do menu[/]"
    Clear-Host
    Write-SpectreRule -Title "[grey]CX Releases · $(Esc $BaseUrl)[/]" -Color $Accent
}
