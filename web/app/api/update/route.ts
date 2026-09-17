import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

/**
 * Informacja o aktualizacji add-inu. Bez tokenu - tresc jest publiczna
 * (add-in wysyla Bearer, ale nie jest wymagany).
 *
 * GET /api/update?version=1.2.30
 *
 * Zrodlo: jednowierszowa tabela public.app_release (migracja 20260905120000).
 * published=false albo pusta wersja -> updateAvailable=false.
 * Bez ?version= -> updateAvailable=true, gdy cokolwiek jest opublikowane.
 * Nieparsowalna wersja klienta -> false (lepiej milczec niz falszywy alarm,
 * tak samo jak fallback w CxServerClient).
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
  const { data: row, error } = await supabaseAdmin
    .from('app_release')
    .select('version, download_url, notes, mandatory, sha256, released_at, published')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    console.error('[update] lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const clientVersion = req.nextUrl.searchParams.get('version')
  const live = !!row?.published && !!row?.version

  let updateAvailable = false
  if (live) {
    updateAvailable = clientVersion ? isNewer(row!.version as string, clientVersion) : true
  }

  return NextResponse.json(
    {
      version: live ? row!.version : null,
      downloadUrl: live ? row!.download_url : null,
      notes: live ? row!.notes : null,
      mandatory: live ? row!.mandatory : false,
      sha256: live ? row!.sha256 : null,
      releasedAt: live ? row!.released_at : null,
      updateAvailable,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
