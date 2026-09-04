# Wysyłanie zgłoszeń z add-inu CX Studio 2026 na cx.ptrnd.pl

Specyfikacja dla strony klienckiej (C#, .NET Framework 4.8). Serwer jest
wdrożony i przetestowany na produkcji — poniższe zachowanie jest zweryfikowane,
nie planowane.

Zastępuje sekcję 9 pierwotnego briefu: kontrakt wyszedł inny, niż zakładano,
bo Vercel odrzuca żądania powyżej 4,5 MB. Powód jest opisany w sekcji „Dlaczego
dwa tryby".

---

## 1. Endpoint

```
POST https://cx.ptrnd.pl/api/feedback
Authorization: Bearer <FEEDBACK_WRITE_TOKEN>
```

`FEEDBACK_WRITE_TOKEN` to **ta sama wartość, co dotychczasowy `BearerToken`**
w `appsettings.json`. Nie trzeba nic rozsyłać użytkownikom — istniejące
add-iny mają już poprawny token.

Ten token pozwala **wyłącznie tworzyć zgłoszenia**. Nie daje odczytu listy,
podglądu cudzych zgłoszeń ani kasowania czegokolwiek. Gdy wycieknie, najgorsze
co grozi to spam — ograniczony limitem 10 zgłoszeń na godzinę z jednego IP.

W kodzie warto przemianować pole na `FeedbackToken`, żeby oddzielić je od
tokenu uploadu modeli, ale wartość na dziś jest wspólna.

---

## 2. Payload

Obiekt JSON, identyczny jak dotąd zapisywany do pliku `feedback-*.json`:

```json
{
  "kind": "Blad",
  "description": "Model 900x800 wychodzi w ePlano jako 900000 mm",
  "user": "ptrflak",
  "version": "0.2.9743.12345",
  "context": "preset=Medium flagi=Weld, Decimate brand=42",
  "createdAt": "2026-09-03 14:22:07",
  "logFile": "feedback-20260903_142207-log.zip"
}
```

| pole | wymagane | limit | uwagi |
|---|---|---|---|
| `kind` | **tak** | — | dokładnie `Blad`, `Sugestia` albo `Pytanie`. Inna wartość → 400 |
| `description` | **tak** | 20 000 znaków | puste lub same białe znaki → 400 |
| `user` | nie | 200 znaków | nazwa z ePlano albo `(niezalogowany)` |
| `version` | nie | 64 znaki | |
| `context` | nie | 2 000 znaków | |
| `createdAt` | nie | — | patrz niżej |
| `logFile` | nie | 260 znaków | `null`, gdy użytkownik nie dołączył logu |

Pola nadmiarowe są ignorowane. Wartości dłuższe niż limit są **przycinane po
cichu**, nie odrzucane — poza `description`, które powyżej 20 000 znaków daje 400.

### `createdAt` — ważna pułapka

Serwer interpretuje ten znacznik jako **UTC**, bo strefa stacji roboczej nie
jest przesyłana. Jeśli wyślesz czas lokalny, w bazie wyląduje przesunięty.

**Wysyłaj UTC:**

```csharp
createdAt = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss")
```

Możesz też podać pełny znacznik ISO-8601 ze strefą (`2026-09-03T14:22:07+02:00`)
— wtedy strefa jest respektowana. Wartość nieparsowalna nie wywala żądania,
po prostu zapisuje się `null`.

Ta wartość służy **wyłącznie** do porównania z zegarem serwera. Kolejność
i data zgłoszenia biorą się z `created_at` ustawianego serwerowo, więc
przestawiony zegar użytkownika niczego nie psuje.

---

## 3. Dwa tryby wysyłki

### Tryb A — jedno żądanie (log ≤ 4 MB albo brak logu)

`multipart/form-data` z polami:

- `payload` — JSON z sekcji 2, jako zwykły string
- `log` — plik ZIP, opcjonalny

```csharp
using (var form = new MultipartFormDataContent())
{
    form.Add(new StringContent(payloadJson, Encoding.UTF8), "payload");

    if (logBytes != null)
    {
        var logPart = new ByteArrayContent(logBytes);
        logPart.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
        form.Add(logPart, "log", logFileName);
    }

    var req = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/api/feedback");
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", feedbackToken);
    req.Content = form;

    var res = await http.SendAsync(req);
}
```

Odpowiedź `201`:

```json
{ "id": 47, "logStored": true }
```

`logStored: false` oznacza, że zgłoszenie zapisano, ale log nie doszedł.
**Nie traktuj tego jako błędu** — treść zgłoszenia jest bezpieczna, a to zwykle
ona ma znaczenie.

### Tryb B — dwa żądania (log > 4 MB)

Krok 1 — sam payload, `application/json`, z wypełnionym `logFile`:

```csharp
var req = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/api/feedback");
req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", feedbackToken);
req.Content = new StringContent(payloadJson, Encoding.UTF8, "application/json");
var res = await http.SendAsync(req);
```

Odpowiedź `201`:

```json
{
  "id": 47,
  "logStored": false,
  "logUpload": {
    "url": "https://fcrisphwxzqguosmmwno.supabase.co/storage/v1/object/upload/sign/feedback/47/…?token=…",
    "path": "47/feedback-20260903_142207-log.zip",
    "method": "PUT"
  }
}
```

Krok 2 — wrzuć ZIP pod `logUpload.url`. To idzie **prosto do Supabase Storage,
z pominięciem naszego API**, więc limit 4,5 MB nie obowiązuje:

```csharp
var put = new HttpRequestMessage(HttpMethod.Put, resp.LogUpload.Url);
put.Content = new ByteArrayContent(logBytes);
put.Content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
// Bez nagłówka Authorization — autoryzacja siedzi w tokenie wewnątrz URL-a.
var putRes = await httpLongTimeout.SendAsync(put);   // oczekiwane 200
```

Trzy rzeczy, które łatwo przeoczyć:

1. **`Content-Type` musi być `application/zip`.** Bucket ma białą listę typów
   MIME i odrzuci wszystko inne.
2. **Nie dokładaj nagłówka `Authorization`.** URL sam w sobie jest
   poświadczeniem.
3. **Link wygasa po 2 godzinach.** W praktyce bez znaczenia, ale nie kolejkuj
   go na później.

Jeśli krok 2 się nie powiedzie, zgłoszenie i tak jest w bazie — po prostu bez
logu. Nie ponawiaj kroku 1, bo powstanie duplikat.

---

## 4. Zalecenie: nie rozgałęziaj się po rozmiarze

Serwer obsługuje oba tryby, ale najprościej **zawsze używać trybu B**:
payload JSON-em, a log signed URL-em, jeśli w ogóle jest. Zyskujesz jedną
ścieżkę kodu zamiast dwóch, brak progu do pomylenia i zero ryzyka trafienia
w limit 4,5 MB. Kosztem jest jedno dodatkowe żądanie HTTP tylko wtedy, gdy
log faktycznie istnieje.

Tryb A ma sens, jeśli zależy Ci na jednym round-tripie i akceptujesz próg.
Wtedy przełączaj się przy **4 MB**, nie 4,5 — reszta budżetu idzie na nagłówki
multiparta, kodowanie i pozostałe pola.

---

## 5. Kody odpowiedzi

| kod | znaczenie | co zrobić w add-inie |
|---|---|---|
| `201` | przyjęte | pokaż `id` użytkownikowi |
| `400` | błąd walidacji, treść w `{"error":"…"}` | błąd programisty — zaloguj, nie ponawiaj |
| `401` | zły lub brak tokenu | komunikat o konfiguracji, nie ponawiaj |
| `413` | log przekracza 10 MB | nie wysyłaj logu albo przytnij |
| `429` | limit 10/h z tego IP | nagłówek `Retry-After: 3600`, nie ponawiaj od razu |
| `500` | błąd serwera | można ponowić raz, po chwili |

**Brak jakiejkolwiek deduplikacji.** Ponowione żądanie tworzy drugi rekord.
Ponawiaj wyłącznie przy `500` i błędach sieciowych, nigdy przy `4xx`.

---

## 6. Timeouty

30 sekund wystarczy na `POST /api/feedback` w trybie B i w trybie A z małym
logiem.

Na `PUT` signed URL-em ustaw **osobny, dłuższy timeout** — 10 MB przez wolne
łącze nie zmieści się w 30 sekundach. Rozsądny punkt wyjścia to 5 minut.

---

## 7. Czego NIE trzeba zmieniać

`FeedbackService` i `FeedbackForm` zostają bez zmian. Zmienia się tylko
warstwa transportu:

- `CxServerClient.UploadBytesAsync` → nowa `PostFeedbackAsync` (jedno wywołanie
  zamiast dwóch osobnych uploadów)
- `WebClientConfig.BearerToken` → osobne pole `FeedbackToken` (na dziś ta sama
  wartość)

Stary `POST /api/upload` **nadal działa** i przyjmuje modele. Nie ma presji
czasowej — możesz migrować spokojnie.

Jedna rzecz, o której warto wiedzieć: dotychczasowa wysyłka logu przez
`/api/upload` **nigdy nie działała**. Ten endpoint przyjmuje wyłącznie
`.json`, `.gltf` i `.glb`, więc każdy `feedback-*-log.zip` dostawał
`400 Unsupported file type`. W buckecie nie ma ani jednego zgłoszenia, co to
potwierdza. Nowy endpoint jest pierwszym, który faktycznie przyjmuje logi.

---

## 8. Dlaczego dwa tryby

Vercel odrzuca każde żądanie do funkcji, którego ciało przekracza **4,5 MB**,
zwracając `413 FUNCTION_PAYLOAD_TOO_LARGE`. Limit jest twardy, jednakowy na
wszystkich planach i obejmuje cały multipart, nie sam plik.

Brief zakładał 10 MB w jednym multiparcie — to fizycznie niewykonalne na tej
platformie. Signed URL omija problem u źródła: plik nigdy nie przechodzi przez
naszą funkcję, tylko leci prosto do Supabase Storage, gdzie obowiązuje limit
bucketa (10 MB, wyłącznie `application/zip`).

---

## 9. Jak sprawdzić, że zadziałało

Zgłoszenia są widoczne pod **https://cx.ptrnd.pl/feedback** (zakładka
„Zgłoszenia"). Wymaga tokenu administratora — innego niż token add-inu.

Nowe zgłoszenie pojawia się na liście natychmiast, ze statusem `new`. Znacznik
`LOG` w wierszu oznacza, że log dotarł; po rozwinięciu wiersza jest przycisk
pobierania.
