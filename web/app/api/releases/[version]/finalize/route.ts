import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import {
  MAX_RELEASE_BYTES,
  RELEASES_BUCKET,
  hashStoredFile,
  isValidVersion,
  promoteRelease,
  pruneOldReleases,
} from '@/lib/releases'

/**
 * Krok 2 publikacji. Token admina.
 *
 * Sprawdza, ze ZIP faktycznie lezy w Storage, liczy SHA-256 i rozmiar z tego
 * pliku (nie ufamy wartosciom od klienta), oznacza wersje jako opublikowana
 * i kasuje wersje ponad RELEASES_KEEP.
 *
 * S6 (21.09): opcjonalne cialo { "promote": true, "mandatory": bool }.
 * promote=true -> po udanej finalizacji app_release wskazuje te wersje
 * (notes z rekordu, mandatory z ciala). Domyslnie false - istniejace skrypty
 * publikacji nie zmieniaja zachowania. Promocja PRZED prune, zeby retencja
 * juz widziala wyjatek i nie skasowala tego, co wlasnie promujemy.
 *
 * mandatory=true tylko dla wersji, bez ktorej add-in nie moze pracowac:
 * klient przerywa start SW oknem pobierania i przypomina co 5 min.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ version: string }> }
) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const version = (await params).version
  if (!isValidVersion(version)) {
    return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
  }

  // Cialo jest opcjonalne (istniejace skrypty go nie wysylaja). Puste albo
  // nie-JSON = brak promocji. Jawnie zle typy = 400, zeby nie promowac przez przypadek.
  let promote = false
  let mandatory = false
  const raw = await req.text()
  if (raw.trim().length > 0) {
    let body: { promote?: unknown; mandatory?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    if (body.promote !== undefined && typeof body.promote !== 'boolean') {
      return NextResponse.json({ error: 'promote must be boolean' }, { status: 400 })
    }
    if (body.mandatory !== undefined && typeof body.mandatory !== 'boolean') {
      return NextResponse.json({ error: 'mandatory must be boolean' }, { status: 400 })
    }
    promote = body.promote === true
    mandatory = body.mandatory === true
  }

  const { data: row, error } = await supabaseAdmin
    .from('releases')
    .select('storage_path, status')
    .eq('version', version)
    .maybeSingle()
  if (error) {
    console.error('[releases] finalize lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (row.status === 'published') {
    return NextResponse.json({ error: 'Version already published' }, { status: 409 })
  }

  const hashed = await hashStoredFile(row.storage_path)
  if (!hashed) {
    return NextResponse.json({ error: 'File not uploaded' }, { status: 404 })
  }
  if (hashed.sizeBytes > MAX_RELEASE_BYTES) {
    await supabaseAdmin.storage.from(RELEASES_BUCKET).remove([row.storage_path])
    return NextResponse.json({ error: 'File too large' }, { status: 413 })
  }

  const { error: updateError } = await supabaseAdmin
    .from('releases')
    .update({
      status: 'published',
      sha256: hashed.sha256,
      size_bytes: hashed.sizeBytes,
      published_at: new Date().toISOString(),
    })
    .eq('version', version)
  if (updateError) {
    console.error('[releases] finalize update failed', updateError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  // S6: promocja PRZED prune - retencja ma juz widziec wyjatek dla tej wersji
  let promoted = false
  if (promote) {
    const promoteError = await promoteRelease(version, mandatory)
    if (promoteError) {
      // wydanie JEST opublikowane, tylko app_release nie ustawione - mowimy wprost
      console.error('[releases] promote after finalize failed', version, promoteError)
      return NextResponse.json(
        { error: `Published, but promote failed: ${promoteError}`, version },
        { status: 500 }
      )
    }
    promoted = true
  }

  const removed = await pruneOldReleases()

  return NextResponse.json({
    version,
    sha256: hashed.sha256,
    sizeBytes: hashed.sizeBytes,
    removed,
    ...(promote ? { promoted, mandatory } : {}),
  })
}
