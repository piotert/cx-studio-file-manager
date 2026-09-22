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
        # NUMER WYDANIA = AssemblyFileVersion - nasza zmienna, podbijana recznie przy kazdym
        # wydaniu (decyzja 22.09). TO wysyla klient w /api/update?version= i pod tym publikujemy.
        # Skladany z pol liczbowych jak w add-inie (AddinIdentity.ReadReleaseVersion):
        # "0.3.0.00" wpisane w AssemblyInfo i tak da "0.3.0.0".
        # AssemblyVersion jest zamrozona (tozsamosc DLL) - pokazujemy ja tylko informacyjnie.
        $rv = $null
        $av = $null
        if (Test-Path $main) {
            $vi = (Get-Item $main).VersionInfo
            $rv = "$($vi.FileMajorPart).$($vi.FileMinorPart).$($vi.FileBuildPart).$($vi.FilePrivatePart)"
            try { $av = [Reflection.AssemblyName]::GetAssemblyName((Resolve-Path $main).Path).Version.ToString() } catch { }
        }
        return [pscustomobject]@{
            Opis            = "folder: $($files.Count) plików, $($dlls.Count) DLL, $(Format-Size $bytes) przed spakowaniem"
            ReleaseVersion  = $rv
            AssemblyVersion = $av
        }
    }
    if ($src -like '*.zip' -and (Test-Path $src -PathType Leaf)) {
        return [pscustomobject]@{ Opis = "gotowy ZIP, $(Format-Size (Get-Item $src).Length)"; ReleaseVersion = $null; AssemblyVersion = $null }
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
    if ($summary.ReleaseVersion) {
        Write-SpectreHost "[grey]Numer wydania SWAddIn_CX.dll (FileVersion): [/][white bold]$(Esc $summary.ReleaseVersion)[/] [grey](to wysyła klient - pod tym publikujemy)[/]"
    }
    if ($summary.AssemblyVersion) {
        Write-SpectreHost "[grey]AssemblyVersion: $(Esc $summary.AssemblyVersion) (zamrożona tożsamość DLL - nie do publikacji)[/]"
    }

    # Podpowiedz: numer wydania z DLL (to wysyla klient), a nie "nastepna po serwerze" (22.09).
    if ($summary.ReleaseVersion) { $suggest = $summary.ReleaseVersion }

    do {
        $v = if ($suggest) {
            Read-SpectreText -Message "Wersja" -DefaultAnswer $suggest
        } else {
            Read-SpectreText -Message "Wersja (x.y.z.w)"
        }
        $v = $v.Trim()
        $ok = $v -match $VersionRegex
        if (-not $ok) { Write-SpectreHost "[red]Wersja musi mieć postać x.y.z albo x.y.z.w[/]" }
    } until ($ok)

    # Klient porownuje SWOJ numer wydania (FileVersion) z wersja z serwera - rozjazd = aktualizacja w kolko albo wcale.
    $refVer = $summary.ReleaseVersion
    $fv = $null
    if ($refVer -and [version]::TryParse((($refVer -split '[ ,]')[0]), [ref]$fv)) {
        $pv = [version]$v
        $norm = { param($x) [version]::new($x.Major, $x.Minor, [math]::Max($x.Build, 0), [math]::Max($x.Revision, 0)) }
        if ((& $norm $fv) -ne (& $norm $pv)) {
            Format-SpectrePanel -Color Orange1 -Expand -Header "[orange1]Uwaga[/]" -Data (
                "Wersja w DLL to [bold]$(Esc $refVer)[/], a publikujesz jako [bold]$(Esc $v)[/].`n" +
                "Klient wysyła wersję z DLL - po instalacji add-in będzie widział inną wersję niż serwer."
            ) | Out-SpectreHost
        }
    }

    $notes = Read-SpectreText -Message "Notatki [grey](Enter = brak)[/]" -AllowEmpty

    # S6: promocja = /api/update wskazuje te wersje. Bez niej klienci nic nie zobacza.
    $promote = Read-SpectreConfirm -Message "Ustawić jako aktualizację dla klientów (/api/update)?" -DefaultAnswer 'y'
    $mandatory = $false
    if ($promote) {
        $mandatory = Read-SpectreConfirm -Message "[orange1]Obowiązkowa?[/] [grey](przerywa start SW oknem pobierania, przypomina co 5 min - tylko gdy bez tej wersji add-in nie działa)[/]" -DefaultAnswer 'n'
    }

    Format-SpectreTable -Color $Accent -HideHeaders -Data @(
        [pscustomobject]@{ K = 'Wersja';  V = "[bold]$(Esc $v)[/]" }
        [pscustomobject]@{ K = 'Źródło';  V = Esc $src }
        [pscustomobject]@{ K = 'Notatki'; V = if ($notes) { Esc $notes } else { '[grey]-[/]' } }
        [pscustomobject]@{ K = 'Serwer';  V = Esc $BaseUrl }
        [pscustomobject]@{ K = 'Promocja'; V = if ($promote) { if ($mandatory) { '[orange1 bold]TAK, obowiązkowa[/]' } else { '[green]tak[/]' } } else { '[grey]nie - /api/update bez zmian[/]' } }
    ) -AllowMarkup | Out-SpectreHost

    if (-not (Read-SpectreConfirm -Message "Publikować?" -DefaultAnswer 'n')) {
        Write-SpectreHost "[grey]Anulowano.[/]"
        return
    }

    # GetNewClosure kopiuje tylko zmienne LOKALNE - $BaseUrl (skryptowa) musi byc skopiowana.
    $script = Join-Path $Root "publish-release.ps1"
    $server = $BaseUrl
    $result = Invoke-SpectreCommandWithStatus -Title "Pakuję, wysyłam i weryfikuję SHA-256..." -Spinner Dots -Color $Accent -ScriptBlock {
        & $script -Version $v -Source $src -Notes $notes -BaseUrl $server -Promote:$promote -Mandatory:$mandatory -Quiet
    }.GetNewClosure()

    $removed = if ($result.Removed.Count -gt 0) { "[yellow]$(Esc ($result.Removed -join ', '))[/]" } else { '[grey]nic[/]' }
    Show-Success "Opublikowano $(Esc $result.Version)" (
        "Rozmiar:  $(Format-Size $result.SizeBytes)`n" +
        "SHA-256:  $($result.Sha256) [green](zgodny z lokalnym)[/]`n" +
        "Usunięte: $removed"
    )
    if ($result.Promoted) {
        Write-SpectreHost "[green]/api/update wskazuje $(Esc $result.Version)$(if ($result.Mandatory) { ' [orange1 bold](obowiązkowa)[/]' }).[/]"
    } else {
        Write-SpectreHost "[grey]/api/update bez zmian - klienci nie zobaczą tej wersji, dopóki jej nie promujesz.[/]"
    }
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

# ---------------------------------------------------------------- dokumentacja

# Dzieli markdown na sekcje po naglowkach "## ". Tekst przed pierwszym naglowkiem = wstep.
function Get-DocSections([string] $text) {
    $sections = [System.Collections.Generic.List[object]]::new()
    $title = 'Wstęp'
    $buf = [System.Text.StringBuilder]::new()
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^##\s+(.+)$') {
            if ($buf.ToString().Trim()) { $sections.Add([pscustomobject]@{ Title = $title; Body = $buf.ToString() }) }
            $title = $matches[1].Trim()
            $buf = [System.Text.StringBuilder]::new()
        }
        [void]$buf.AppendLine($line)
    }
    if ($buf.ToString().Trim()) { $sections.Add([pscustomobject]@{ Title = $title; Body = $buf.ToString() }) }
    return ,$sections
}

# Komorka tabeli markdown -> markup Spectre (`kod`, **pogrubienie**).
function Convert-CellMarkup([string] $cell) {
    $s = Esc $cell.Trim()
    $s = [regex]::Replace($s, '\*\*(.+?)\*\*', '[bold]$1[/]')
    $s = [regex]::Replace($s, '`([^`]+)`', '[olive]$1[/]')
    if (-not $s) { $s = ' ' }
    return $s
}

function Split-TableRow([string] $line) {
    $t = $line.Trim()
    if ($t.StartsWith('|')) { $t = $t.Substring(1) }
    if ($t.EndsWith('|'))   { $t = $t.Substring(0, $t.Length - 1) }
    return ,@($t -split '\|')
}

function Write-MarkdownTable([string[]] $lines) {
    $headers = Split-TableRow $lines[0]
    # unikalne, niepuste nazwy kolumn (pusta = spacje o roznej dlugosci)
    $names = for ($i = 0; $i -lt $headers.Count; $i++) {
        $h = Convert-CellMarkup $headers[$i]
        if ($h -eq ' ') { ' ' * ($i + 1) } else { $h }
    }
    $rows = foreach ($line in ($lines | Select-Object -Skip 2)) {
        $cells = Split-TableRow $line
        $o = [ordered]@{}
        for ($i = 0; $i -lt $names.Count; $i++) {
            $o[$names[$i]] = if ($i -lt $cells.Count) { Convert-CellMarkup $cells[$i] } else { ' ' }
        }
        [pscustomobject]$o
    }
    Format-SpectreTable -Data $rows -Color Grey -HeaderColor $Accent -AllowMarkup | Out-SpectreHost
}

# Markdown -> konsola, w calosci przez Spectre. Obslugiwany podzbior (wystarcza na docs/):
# # / ## / ### naglowki, > cytat, listy - i 1. (z zagniezdzeniem), ``` bloki kodu,
# tabele, **pogrubienie**, `kod`. Naglowek "## " pomijany - tytul sekcji daje Write-SpectreRule.
function Show-MarkdownText([string] $md) {
    $table = [System.Collections.Generic.List[string]]::new()
    $code  = [System.Collections.Generic.List[string]]::new()
    $inFence = $false
    $prevBlank = $true

    foreach ($line in ($md -split "`r?`n")) {
        # --- blok kodu ---
        if ($line -match '^\s*```') {
            if ($inFence) {
                Format-SpectrePanel -Data (Esc ($code -join "`n")) -Color Grey -Expand | Out-SpectreHost
                $code.Clear()
            }
            $inFence = -not $inFence
            continue
        }
        if ($inFence) { $code.Add($line); continue }

        # --- tabela ---
        if ($line -match '^\s*\|') { $table.Add($line); continue }
        if ($table.Count) { Write-MarkdownTable $table.ToArray(); $table.Clear() }

        # --- reszta, linia po linii ---
        if (-not $line.Trim()) {
            if (-not $prevBlank) { Write-SpectreHost "" }
            $prevBlank = $true
            continue
        }
        $prevBlank = $false

        switch -Regex ($line) {
            '^##\s' { $prevBlank = $true; break }
            '^#\s+(.+)$' {
                Write-SpectreHost "[bold underline $Accent]$(Convert-CellMarkup $matches[1])[/]"; break
            }
            '^###\s+(.+)$' {
                Write-SpectreHost "[bold $Accent]$(Convert-CellMarkup $matches[1])[/]"; break
            }
            '^>\s?(.*)$' {
                Write-SpectreHost "[grey]│[/] [italic]$(Convert-CellMarkup $matches[1])[/]"; break
            }
            '^(\s*)([-*]|\d+\.)\s+(.*)$' {
                $indent = $matches[1]; $bullet = $matches[2]; $body = $matches[3]
                $level  = [math]::Floor($indent.Length / 2)
                $marker = if ($bullet -match '\d') { "[$Accent]$bullet[/]" } else { "[$Accent]•[/]" }
                Write-SpectreHost ("  " * ($level + 1) + "$marker $(Convert-CellMarkup $body)"); break
            }
            default {
                Write-SpectreHost ("  " + (Convert-CellMarkup $line))
            }
        }
    }
    if ($table.Count) { Write-MarkdownTable $table.ToArray() }
    if ($inFence -and $code.Count) {
        Format-SpectrePanel -Data (Esc ($code -join "`n")) -Color Grey -Expand | Out-SpectreHost
    }
}

function Show-Docs {
    $path = Join-Path $Root 'docs\RELEASES.md'
    if (-not (Test-Path $path)) { throw "Brak pliku dokumentacji: $path" }
    $text     = Get-Content $path -Raw -Encoding utf8
    $sections = Get-DocSections $text

    $all   = '[bold]Całość[/] [grey](przewiń terminal w górę)[/]'
    $code  = 'Otwórz w VS Code'
    $back  = '← Powrót do menu'

    while ($true) {
        $choices = @($all) + @($sections | ForEach-Object { Esc $_.Title }) + @($code, $back)
        $pick = Read-SpectreSelection -Message "[bold]Dokumentacja[/] [grey]docs/RELEASES.md[/]" -Choices $choices -Color $Accent -PageSize 15

        if ($pick -eq $back) { return }
        if ($pick -eq $code) {
            if (Get-Command code -ErrorAction SilentlyContinue) { code $path } else { Invoke-Item $path }
            continue
        }

        Clear-Host
        if ($pick -eq $all) {
            foreach ($sec in $sections) {
                Write-SpectreRule -Title "[bold]$(Esc $sec.Title)[/]" -Color $Accent -Alignment Left
                Show-MarkdownText $sec.Body
            }
        } else {
            $sec = $sections | Where-Object { (Esc $_.Title) -eq $pick } | Select-Object -First 1
            Write-SpectreRule -Title "[bold]$(Esc $sec.Title)[/]" -Color $Accent -Alignment Left
            Show-MarkdownText $sec.Body
        }
        Read-SpectrePause -Message "[grey]Enter - powrót do spisu treści[/]"
        Clear-Host
    }
}

# ---------------------------------------------------------------- petla glowna

$menu = [ordered]@{
    'Wyświetl wersje na serwerze' = { Show-ReleasesTable (Get-ReleasesWithStatus) }
    'Załaduj nowy ZIP'            = { Invoke-Upload }
    'Pobierz wersję'              = { Invoke-Download }
    'Dokumentacja'                = { Show-Docs }
    'Wyjście'                     = $null
}

# Akcje z wlasna nawigacja - bez pauzy po powrocie.
$noPause = @('Dokumentacja')

Clear-Host
Write-SpectreFigletText -Text "CX Releases" -Color $Accent
Write-SpectreRule -Title "[grey]$(Esc $BaseUrl)[/]" -Color $Accent

while ($true) {
    Write-SpectreHost ""
    $choice = Read-SpectreSelection -Message "[bold]Co robimy?[/]" -Choices @($menu.Keys) -Color $Accent
    $action = $menu[$choice]
    if (-not $action) { break }

    Write-SpectreRule -Title "[bold]$choice[/]" -Color $Accent -Alignment Left
    $failed = $false
    try {
        & $action
    }
    catch {
        $failed = $true
        Format-SpectrePanel -Data "[red]$(Esc (Get-InnerMessage $_))[/]" -Header "[red]Błąd[/]" -Color Red -Expand |
            Out-SpectreHost
    }
    if ($failed -or $choice -notin $noPause) {
        Read-SpectrePause -Message "[grey]Enter - powrót do menu[/]"
    }
    Clear-Host
    Write-SpectreRule -Title "[grey]CX Releases · $(Esc $BaseUrl)[/]" -Color $Accent
}
