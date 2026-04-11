$token = "cx-file-manager-secret-2026"
$url = "https://cx.ptrnd.pl/api/upload"
$filePath = "$PSScriptRoot\Duck.glb"

$form = [System.Net.Http.MultipartFormDataContent]::new()
$fileBytes = [System.IO.File]::ReadAllBytes($filePath)
$content = [System.Net.Http.ByteArrayContent]::new($fileBytes)
$content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new("model/gltf-binary")
$form.Add($content, "file", [System.IO.Path]::GetFileName($filePath))

$client = [System.Net.Http.HttpClient]::new()
$client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $token)

$response = $client.PostAsync($url, $form).Result
$body = $response.Content.ReadAsStringAsync().Result

Write-Host "Status: $($response.StatusCode)"
Write-Host "Response: $body"
