import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import {
  DOWNLOAD_TTL_SECONDS,
  RELEASES_BUCKET,
  isValidVersion,
  listPublished,
} from '@/lib/releases'

/**
 * Pobranie paczki. Token zapisu (ma go kazdy add-in i updater).
 *
 * {version} = numer wersji albo 'latest'.
 * Odpowiedz: 302 na krotko zyjacy signed URL Supabase. Plik nie przechodzi
 * przez funkcje, wiec rozmiar nie jest ograniczony limitem Vercela.
 * Naglowki X-Release-* pozwalaja zweryfikowac pobrany plik bez osobnego zapytania.
 * Z ?json=1 zamiast przekierowania zwraca { url, ... } - do testow z PowerShella.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ version: string }> }
) {
  const denied = requireScope(req, 'write')
  if (denied) return denied

  const requested = (await params).version
  if (requested !== 'latest' && !isValidVersion(requested)) {
    return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
  }

  let published
  try {
    published = await listPublished()
  } catch (error) {
    console.error('[releases] download lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const release =
    requested === 'latest' ? published[0] : published.find((r) => r.version === requested)
  if (!release) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: signed, error } = await supabaseAdmin.storage
    .from(RELEASES_BUCKET)
    .createSignedUrl(release.storage_path, DOWNLOAD_TTL_SECONDS, {
      download: `SWAddIn_CX-${release.version}.zip`,
    })
  if (error || !signed) {
    console.error('[releases] signed download url failed', error)
    return NextResponse.json({ error: 'File not available' }, { status: 404 })
  }

  const meta = {
    version: release.version,
    sha256: release.sha256,
    sizeBytes: release.size_bytes,
  }

  if (req.nextUrl.searchParams.get('json') === '1') {
    return NextResponse.json({ url: signed.signedUrl, expiresInSeconds: DOWNLOAD_TTL_SECONDS, ...meta })
  }

  const res = NextResponse.redirect(signed.signedUrl, 302)
  res.headers.set('Cache-Control', 'no-store')
  res.headers.set('X-Release-Version', meta.version)
  if (meta.sha256) res.headers.set('X-Release-Sha256', meta.sha256)
  if (meta.sizeBytes != null) res.headers.set('X-Release-Size', String(meta.sizeBytes))
  return res
}
