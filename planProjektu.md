# File Manager — Plan Projektu

## Cel
Apka C# uploaduje pliki na serwer, pliki można przeglądać przez przeglądarkę.

## Stack
- **Frontend + API:** Next.js (App Router, TypeScript) — nowy projekt Vercel
- **Storage:** Supabase Storage — nowy bucket, osobny od dfma.pl
- **Autoryzacja:** Bearer token w nagłówku HTTP

## Obsługiwane typy plików
| Typ | Widok |
|-----|-------|
| JSON | Sformatowany JSON viewer |
| GLTF | Przeglądarka 3D (Three.js / model-viewer) |

## API
- `POST /api/upload` — przyjmuje plik + metadane (multipart/form-data)
- Autoryzacja: `Authorization: Bearer <token>`
- Plik trafia do Supabase Storage, metadane opcjonalnie do bazy

## Klient C#
- `HttpClient` + `MultipartFormDataContent`
- Bearer token w nagłówkach

## Faza 2 — Konwersja STEP → GLTF (C#)
Do omówienia osobno. Wstępne opcje:
- **OpenCascade (OCCT)** przez binding OCC.NET
- Pipeline: STEP → mesh → GLTF przez `SharpGLTF`

## Status
- [ ] Faza 1: Projekt Vercel + Supabase + UI
- [ ] Faza 2: Konwersja STEP→GLTF w C#