import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import {
  RELEASES_BUCKET,
  isValidVersion,
  listPublished,
  releaseStoragePath,
} from '@/lib/releases'

/**
 * Lista opublikowanych wersji. Token zapisu wystarcza - ma go kazdy add-in,
 * a lista zawiera tylko metadane, bez linkow.
 */
export async function GET(req: NextRequest) {
  const denied = requireScope(req, 'write')
  if (denied) return denied

  try {
    const items = (await listPublished()).map((r) => ({
      version: r.version,
      sha256: r.sha256,
      sizeBytes: r.size_bytes,
      notes: r.notes,
      publishedAt: r.published_at,
    }))
    return NextResponse.json({ items })
  } catch (error) {
    console.error('[releases] list failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

/**
 * Krok 1 publikacji. Token admina.
 *
 * Cialo: { "version": "1.2.32", "notes": "..." }
 * Odpowiedz: signed URL, pod ktory klient robi PUT z ZIP-em prosto do Storage
 * (Content-Type: application/zip, bez Authorization). Plik idzie z pominieciem
 * funkcji, wiec limit 4,5 MB Vercela nie ma znaczenia.
 * Krok 2: POST /api/releases/{version}/finalize.
 */
export async function POST(req: NextRequest) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  let body: { version?: unknown; notes?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  if (!isValidVersion(body.version)) {
    return NextResponse.json({ error: 'Invalid version, expected x.y.z' }, { status: 400 })
  }
  const version = body.version
  const notes = typeof body.notes === 'string' ? body.notes.slice(0, 5000) : null

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from('releases')
    .select('status')
    .eq('version', version)
    .maybeSingle()
  if (lookupError) {
    console.error('[releases] lookup failed', lookupError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  // Opublikowanej wersji nie nadpisujemy - ten sam numer musi znaczyc te same bajty.
  if (existing?.status === 'published') {
    return NextResponse.json({ error: 'Version already published' }, { status: 409 })
  }

  const path = releaseStoragePath(version)

  // 'pending' mozna ponawiac: nieudany upload nie blokuje numeru wersji.
  const { error: upsertError } = await supabaseAdmin
    .from('releases')
    .upsert(
      { version, storage_path: path, notes, status: 'pending', sha256: null, size_bytes: null },
      { onConflict: 'version' }
    )
  if (upsertError) {
    console.error('[releases] upsert failed', upsertError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(RELEASES_BUCKET)
    .createSignedUploadUrl(path, { upsert: true })
  if (signError || !signed) {
    console.error('[releases] signed upload url failed', signError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json(
    { version, upload: { url: signed.signedUrl, method: 'PUT', contentType: 'application/zip' } },
    { status: 201 }
  )
}
