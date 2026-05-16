# test-upload-glb-s.ps1
# Upload GLB do cx.ptrnd.pl z interaktywnym UI (PwshSpectreConsole)

using module PwshSpectreConsole

$token = "cx-file-manager-secret-2026"
$url   = "https://cx.ptrnd.pl/api/upload"

# ── Znane lokalizacje ────────────────────────────────────────
$knownLocations = [ordered]@{
    "FileManager  (projekt NodeJS)"  = "D:\02. DEV\10. CX Studio\2026_NodeJS_CX_FileManager\cx-studio-file-manager"
    "ModelData    (SW AddIn testy)"  = "D:\02. DEV\10. CX Studio\2026_SW_AddIn\.modelData"
    "Wskaż folder ręcznie..."        = $null
}

# ── Nagłówek ────────────────────────────────────────────────
Write-SpectreRule "CX Studio — Upload GLB" -Color "CadetBlue"
Write-Host ""

# ── Wybór lokalizacji ────────────────────────────────────────
$locationChoice = Read-SpectreSelection `
    -Title "[cadetblue]Skąd uploadować plik GLB?[/]" `
    -Choices $knownLocations.Keys `
    -Color "CadetBlue"

if ($knownLocations[$locationChoice] -eq $null)
{
    $folder = Read-SpectreText -Prompt "[cadetblue]Podaj ścieżkę do folderu:[/]"
    $folder = $folder.Trim('"').Trim("'")
}
else
{
    $folder = $knownLocations[$locationChoice]
}

# ── Sprawdź folder ───────────────────────────────────────────
if (-not (Test-Path $folder))
{
    Write-SpectreHost "[red]Folder nie istnieje:[/] $folder"
    exit 1
}

# ── Znajdź pliki GLB ─────────────────────────────────────────
$glbFiles = Get-ChildItem -Path $folder -Filter "*.glb" | Select-Object -ExpandProperty Name

if ($glbFiles.Count -eq 0)
{
    Write-SpectreHost "[red]Brak plików .glb w:[/] $folder"
    exit 1
}

Write-Host ""

# ── Wybór pliku ──────────────────────────────────────────────
$selectedFile = Read-SpectreSelection `
    -Title "[cadetblue]Wybierz plik GLB do uploadu:[/]" `
    -Choices $glbFiles `
    -Color "CadetBlue"

$filePath = Join-Path $folder $selectedFile

# ── Potwierdzenie ────────────────────────────────────────────
Write-Host ""
Write-SpectreHost "[grey]Plik:[/]    [white]$filePath[/]"
Write-SpectreHost "[grey]Serwis:[/]  [white]$url[/]"
Write-Host ""

$confirm = Read-SpectreConfirm -Message "Uploadować?" -DefaultAnswer "y"

if (-not $confirm)
{
    Write-SpectreHost "[grey]Anulowano.[/]"
    exit 0
}

# ── Upload ───────────────────────────────────────────────────
Write-Host ""

Invoke-SpectreCommandWithStatus `
    -Spinner "Dots" `
    -Title "Uploading $selectedFile..." `
    -Color "CadetBlue" `
    -ScriptBlock {

    $form = [System.Net.Http.MultipartFormDataContent]::new()
    $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
    $content = [System.Net.Http.ByteArrayContent]::new($fileBytes)
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new("model/gltf-binary")
    $form.Add($content, "file", [System.IO.Path]::GetFileName($filePath))

    $client = [System.Net.Http.HttpClient]::new()
    $client.DefaultRequestHeaders.Authorization = `
        [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $token)

    $script:response = $client.PostAsync($url, $form).Result
    $script:body     = $script:response.Content.ReadAsStringAsync().Result
}

# ── Wynik ────────────────────────────────────────────────────
Write-Host ""

if ([int]$script:response.StatusCode -lt 300)
{
    Write-SpectreHost "[green]✓ Upload OK[/] — Status: [white]$($script:response.StatusCode)[/]"
    Write-SpectreHost "[grey]Response:[/] $($script:body)"
}
else
{
    Write-SpectreHost "[red]✗ Upload nieudany[/] — Status: [white]$($script:response.StatusCode)[/]"
    Write-SpectreHost "[grey]Response:[/] $($script:body)"
}

Write-Host ""
