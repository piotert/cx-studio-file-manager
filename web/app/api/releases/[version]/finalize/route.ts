import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import {
  MAX_RELEASE_BYTES,
  RELEASES_BUCKET,
  hashStoredFile,
  isValidVersion,
  pruneOldReleases,
} from '@/lib/releases'

/**
 * Krok 2 publikacji. Token admina.
 *
 * Sprawdza, ze ZIP faktycznie lezy w Storage, liczy SHA-256 i rozmiar z tego
 * pliku (nie ufamy wartosciom od klienta), oznacza wersje jako opublikowana
 * i kasuje wersje ponad RELEASES_KEEP.
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

  const removed = await pruneOldReleases()

  return NextResponse.json({
    version,
    sha256: hashed.sha256,
    sizeBytes: hashed.sizeBytes,
    removed,
  })
}
