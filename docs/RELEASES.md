# Paczki add-inu – serwer `cx.ptrnd.pl`

> Stan: 17.09.2026 · serwer testowy (Vercel Hobby + Supabase), docelowo inny host.
> Powiązane: `2026_SW_AddIn_Updater\.doc\2026-09-16 Architektura updatera.md`

## 1. W skrócie

Serwer trzyma spakowane wydania `SWAddIn_CX` (ZIP z zawartością `bin\Release`)
i oddaje je add-inowi oraz updaterowi. Przechowuje **najnowszą wersję + 3 wstecz**.
Starsze kasuje automatycznie przy każdej publikacji.

Dwa osobne mechanizmy – **ważne, bo dziś nie są połączone**:

| | `/api/update` | `/api/releases` |
|---|---|---|
| Rola | „czy jest coś nowego” (komunikat w add-inie) | magazyn paczek (pobieranie przez updater) |
| Źródło | tabela `app_release` – **jeden wiersz, ustawiany ręcznie** | tabela `releases` + bucket `releases` |
| Token | brak | zapis (lista, pobieranie) / admin (publikacja) |
| Wypełniane przez | ręcznie w Supabase | `menu.ps1` / `publish-release.ps1` |

Publikacja paczki **nie zmienia** `/api/update`. Patrz §6.

## 2. Przechowywanie

- **Tabela `public.releases`** (migracja `20260917120000_releases.sql`):
  `version` (unikalna, `x.y.z` lub `x.y.z.w`), `status` (`pending` → `published`),
  `sha256`, `size_bytes`, `notes`, `published_at`.
- **Bucket `releases`** – prywatny, tylko `application/zip`, max 50 MB na plik.
  Ścieżka: `{version}/SWAddIn_CX-{version}.zip`.
- `sha256` i `size_bytes` **liczy serwer** z pliku leżącego w Storage. Wartości od klienta nie są przyjmowane.
- Opublikowanego numeru wersji nie da się nadpisać (409). Ten sam numer = te same bajty.
- Retencja: zmienna środowiskowa `RELEASES_KEEP`, domyślnie 4. Kolejność wersji liczona numerycznie (`1.10.0 > 1.9.0`), nie po dacie.

## 3. Tokeny

| Token | Zmienna na serwerze | Kto ma | Uprawnia do |
|---|---|---|---|
| zapis | `UPLOAD_BEARER_TOKEN` | każdy add-in (`appsettings.json`), updater | lista, pobieranie |
| admin | `FEEDBACK_ADMIN_TOKEN` | tylko Piotr (`.env.local`) | publikacja |

Nagłówek: `Authorization: Bearer <token>`. Zły token → goły 401.
Token zapisu trzeba traktować jak publiczny (leży na każdej maszynie) – dlatego nie pozwala publikować.

## 4. API

### `GET /api/releases` – lista (token zapisu)
```json
{ "items": [
  { "version": "1.2.32", "sha256": "4e50…f330", "sizeBytes": 2945542,
    "notes": "test", "publishedAt": "2026-09-17T14:05:12+00:00" }
] }
```
Posortowane od najnowszej. Tylko wersje opublikowane.

### `GET /api/releases/{version|latest}/download` – pobranie (token zapisu)
- Domyślnie: **302** na link Supabase ważny **5 minut**. Nagłówki:
  `X-Release-Version`, `X-Release-Sha256`, `X-Release-Size`.
- Z `?json=1`: zamiast przekierowania
  `{ "url", "expiresInSeconds", "version", "sha256", "sizeBytes" }`.
- 404 – brak takiej wersji (albo nic nie opublikowano przy `latest`).

Link z Supabase **nie wymaga tokenu** – uprawnienie jest w URL-u.
Wygasa 5 minut po wydaniu – pobieranie musi się w tym czasie **zacząć**.

### `POST /api/releases` – publikacja, krok 1 (admin)
Ciało: `{ "version": "1.2.33", "notes": "…" }` →
`201 { "version", "upload": { "url", "method": "PUT", "contentType": "application/zip" } }`.
Wersję w stanie `pending` można zapowiadać wielokrotnie (nieudany upload nie blokuje numeru).

**Krok 2 – upload:** `PUT` na `upload.url`, `Content-Type: application/zip`,
**bez** nagłówka `Authorization`. Plik idzie prosto do Supabase, z pominięciem
funkcji – limit 4,5 MB Vercela nie dotyczy.

### `POST /api/releases/{version}/finalize` – publikacja, krok 3 (admin)
Serwer pobiera plik ze Storage, liczy SHA-256 i rozmiar, publikuje, przycina do `RELEASES_KEEP`.
`200 { "version", "sha256", "sizeBytes", "removed": ["1.2.28"] }`.
404 = pliku nie ma w Storage (upload nie doszedł).

### `GET /api/update?version=x.y.z` – komunikat o aktualizacji (bez tokenu)
```json
{ "version": "1.2.31", "downloadUrl": "…", "notes": "…", "mandatory": true,
  "sha256": null, "releasedAt": "…", "updateAvailable": true }
```
- `updateAvailable` = wersja z `app_release` nowsza niż `?version=`.
- Bez `?version=` → `true`, gdy cokolwiek opublikowano.
- `published = false` w tabeli → wszystkie pola `null`, `updateAvailable: false`.
- Nieparsowalna wersja klienta → `false` (lepiej milczeć niż fałszywy alarm).

## 5. Narzędzia (katalog repo serwera)

**`menu.ps1`** (`pwsh .\menu.ps1`, wymaga PowerShell 7 i modułu PwshSpectreConsole –
doinstaluje się sam) – wyświetl wersje / załaduj ZIP / pobierz wersję.
- Tokeny bierze z `.env.local` (`UPLOAD_BEARER_TOKEN`, `FEEDBACK_ADMIN_TOKEN`).
- Przy ładowaniu pokazuje `FileVersion` z `SWAddIn_CX.dll` i ostrzega, gdy różni się
  od publikowanego numeru – updater porównuje właśnie `FileVersion`.
- Pobieranie weryfikuje SHA-256 i rozmiar; uszkodzony plik jest usuwany.

**`publish-release.ps1`** – publikacja bez menu (np. ze skryptu builda):
```powershell
.\publish-release.ps1 -Version 1.2.33 -Source "...\bin\Release" -Notes "opis"
```
Pakuje folder (albo bierze gotowy `.zip`), przechodzi kroki 1–3 i sprawdza,
czy hash serwera zgadza się z lokalnym.

## 6. Jak `/api/update` ma wskazywać na paczkę – krok ręczny

Po publikacji, w Supabase → SQL Editor (wartości z wyniku publikacji):
```sql
update public.app_release set
  version      = '1.2.33',
  download_url = 'https://cx.ptrnd.pl/api/releases/1.2.33/download',
  sha256       = '<sha256 z wyniku publikacji>',
  notes        = 'opis zmian',
  mandatory    = false,
  released_at  = now(),
  published    = true
where id = 1;
```
Konkretny numer w `download_url` zamiast `latest` – żeby komunikat i paczka nie
rozjechały się, gdy opublikujesz kolejną wersję, a `app_release` zostanie po staremu.

**Do zrobienia (świadomie odłożone):** automatyczna aktualizacja `app_release` przy
`finalize` albo `/api/update` czytający bezpośrednio z `releases`. Do tego czasu
krok ręczny jest jedynym źródłem rozjazdu – przy publikacji zawsze oba kroki.

## 7. Add-in (`SWAddIn_CX`)

Stan obecny – bez zmian w kodzie:
- `CxServerClient.CheckUpdateAsync` → `GET /api/update?version=<wersja>`.
  Wynik trafia do listy komunikatów; przy `mandatory: true` okno z `downloadUrl`.
- Add-in **nie pobiera** paczek. Pobieranie i weryfikacja są wyłącznie w updaterze
  (jedno miejsce logiki hasha – architektura updatera §6).
- **Uwaga:** `downloadUrl` wskazujący `/api/releases/...` wymaga tokenu.
  Otwarcie go w przeglądarce z okna „mandatory” da 401. Okno powinno
  uruchamiać updater, nie przeglądarkę.

## 8. Updater (`CxUpdater`)

Przepływ `--download`:
1. `ManifestClient`: `GET /api/update?version=<FileVersion z AddinLocator>`.
   `updateAvailable = false` → koniec.
2. `PackageDownloader`:
   - `GET {downloadUrl}?json=1` z `Authorization: Bearer <token zapisu>` →
     `url`, `sha256`, `sizeBytes`.
   - Sprawdzenie miejsca na dysku (`sizeBytes`).
   - `GET url` **bez** `Authorization` → `staging\SWAddIn_CX-<ver>.zip`.
   - SHA-256 i rozmiar pliku == wartości z `?json=1`. Niezgodność → skasuj plik, `FAIL`.
   - Jeśli `/api/update` podał `sha256`, musi być równy temu z `?json=1`.
3. Rozpakowanie do `versions\<ver>\`, `state.json.pendingVersion`.

**Dlaczego `?json=1`, a nie podążanie za 302:** na zachowaniu `HttpClient`
w .NET Framework 4.8 przy przekierowaniu na inny host (czy zdejmuje
`Authorization`) nie warto polegać. Dwa jawne zapytania: token idzie tylko
do `cx.ptrnd.pl`, nigdy do Supabase – niezależnie od runtime'u.

**Obsługa błędów:**

| Kod | Znaczenie | Reakcja |
|---|---|---|
| 401 | zły token zapisu | FAIL, komunikat w feedzie, nie ponawiać |
| 404 | brak wersji / plik usunięty przez retencję | ponowić sprawdzenie przy następnym starcie |
| 400/403 z Supabase | link wygasł (>5 min) | ponowić od `?json=1` |
| 5xx / sieć | serwer | cisza, ponowić przy następnym starcie |

**Czego manifest jeszcze nie ma** (architektura updatera §8): `requiresFullInstall`,
`sizeBytes` w `/api/update`. `sizeBytes` jest dostępny w `?json=1`.

## 9. Migracja na docelowy serwer

Kontrakt HTTP z §4 zostaje. Wymienne są tylko:
- magazyn plików (`web/lib/releases.ts`: upload URL, signed URL, pobranie do hasha),
- baza (Postgres – obie migracje przenoszą się 1:1),
- `BaseUrl` w `updater.json` i `appsettings.json` add-inu.
