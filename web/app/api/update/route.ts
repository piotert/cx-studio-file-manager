import { NextRequest, NextResponse } from 'next/server'
import {
  getAppRelease,
  getPublishedRelease,
  type AppRelease,
  type PublishedRelease,
} from '@/lib/releases'

/**
 * Informacja o aktualizacji add-inu. Bez tokenu - tresc jest publiczna
 * (add-in wysyla Bearer, ale nie jest wymagany).
 *
 * GET /api/update?version=0.2.9758.8788
 *
 * Zrodlo: jednowierszowa tabela public.app_release (migracja 20260905120000),
 * ustawiana przez POST /api/releases/<ver>/finalize { promote: true } (S6).
 * published=false albo pusta wersja -> updateAvailable=false.
 * Wersja bez opublikowanego rekordu w `releases` -> updateAvailable=false (S2).
 * Bez ?version= -> updateAvailable=true, gdy cokolwiek jest opublikowane.
 * Nieparsowalna wersja klienta -> false (lepiej milczec niz falszywy alarm,
 * tak samo jak fallback w CxServerClient).
 *
 * Porownanie wersji: numeryczne, czteroczlonowe. Klient wysyla AssemblyVersion
 * add-inu (0.2.9758.8788 - dwa ostatnie czlony z daty builda), nigdy leksykograficznie.
 */
export const dynamic = 'force-dynamic'

/** Czlony numeryczne; sufiks '-beta' pomijany. null = nieparsowalne. */
function parseVersion(v: string): number[] | null {
  const core = v.trim().split('-')[0]
  if (!/^\d+(\.\d+){0,3}$/.test(core)) return null
  return core.split('.').map(Number)
}

function isNewer(server: string, client: string): boolean {
  const s = parseVersion(server)
  const c = parseVersion(client)
  if (!s || !c) return false
  for (let i = 0; i < 4; i++) {
    const d = (s[i] ?? 0) - (c[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

export async function GET(req: NextRequest) {
  let row: AppRelease | null
  try {
    row = await getAppRelease()
  } catch (error) {
    console.error('[update] lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const clientVersion = req.nextUrl.searchParams.get('version')
  let live = !!row?.published && !!row?.version

  // S2 (21.09): wersja z app_release MUSI istniec w magazynie jako opublikowana -
  // klient bierze stamtad hash i plik. Brak -> "brak aktualizacji" + ostrzezenie,
  // nie 500 i nie wskazywanie paczki, ktorej nie ma.
  let release: PublishedRelease | null = null
  if (live) {
    try {
      release = await getPublishedRelease(row!.version as string)
    } catch (error) {
      console.error('[update] release lookup failed', error)
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }
    if (!release) {
      console.warn(
        `[update] app_release=${row!.version} has no published release in storage - reporting no update`
      )
      live = false
    }
  }

  let updateAvailable = false
  if (live) {
    updateAvailable = clientVersion ? isNewer(row!.version as string, clientVersion) : true
  }

  // S2 opcja: downloadUrl wskazuje endpoint pobierania na TYM hoscie, nie placeholder z bazy.
  const downloadUrl = live ? `${req.nextUrl.origin}/api/releases/${row!.version}/download` : null

  return NextResponse.json(
    {
      version: live ? row!.version : null,
      downloadUrl,
      notes: live ? row!.notes : null,
      mandatory: live ? row!.mandatory : false,
      // S4: hash z rekordu wydania (policzony z pliku przy finalize); fallback na app_release.
      // Brak w obu -> null, nie zmyslamy.
      sha256: live ? (release?.sha256 ?? row!.sha256 ?? null) : null,
      releasedAt: live ? row!.released_at : null,
      updateAvailable,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
