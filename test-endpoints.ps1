$base = "https://cx.ptrnd.pl"
$uploadToken = "cx-file-manager-secret-2026"
$deleteToken = "531b41ddc5a1cc34033b9dafc44a6eac4d3e901203de1a23"

function Invoke-Api($method, $url, $token = $null, $body = $null) {
    $client = [System.Net.Http.HttpClient]::new()
    if ($token) {
        $client.DefaultRequestHeaders.Authorization =
            [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $token)
    }
    $response = switch ($method) {
        "GET"    { $client.GetAsync($url).Result }
        "POST"   { $client.PostAsync($url, $body).Result }
        "DELETE" { $client.DeleteAsync($url).Result }
    }
    return @{
        Status = $response.StatusCode
        Body   = $response.Content.ReadAsStringAsync().Result
    }
}

function Test-Endpoint($label, $method, $url, $token = $null, $body = $null) {
    Write-Host "`n--- $label ---" -ForegroundColor Cyan
    Write-Host "$method $url"
    $r = Invoke-Api $method $url $token $body
    Write-Host "Status: $($r.Status)"
    Write-Host "Response: $($r.Body)"
}

# 1. Status
Test-Endpoint "System Status" "GET" "$base/api/status"

# 2. Lista plikow
Test-Endpoint "Lista plikow" "GET" "$base/api/files"

# 3. Czy plik istnieje (istniejacy)
Test-Endpoint "Czy plik istnieje (test-upload.json)" "GET" "$base/api/files/test-upload.json"

# 4. Czy plik istnieje (nieistniejacy)
Test-Endpoint "Czy plik istnieje (nieistniejacy.json)" "GET" "$base/api/files/nieistniejacy.json"

# 5. Weryfikacja tokena - poprawny
Test-Endpoint "Verify token - poprawny" "POST" "$base/api/auth/verify" $uploadToken ([System.Net.Http.StringContent]::new(""))

# 6. Weryfikacja tokena - bledny
Test-Endpoint "Verify token - bledny" "POST" "$base/api/auth/verify" "bledny-token" ([System.Net.Http.StringContent]::new(""))

# 7. Delete-all - bledny token
Test-Endpoint "Delete-all - bledny token" "DELETE" "$base/api/files/delete-all" "bledny-token"

# 8. Delete-all - poprawny token (odkomentuj jesli chcesz skasowac pliki)
# Test-Endpoint "Delete-all - poprawny token" "DELETE" "$base/api/files/delete-all" $deleteToken

Write-Host "`n--- Testy zakonczone ---`n" -ForegroundColor Green
