import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import { RELEASES_BUCKET, isValidVersion } from '@/lib/releases'

/**
 * Upload ZIP-a przez serwer (21.09, pod strone /releases) - ZAPAS, nie glowna droga.
 * Glowna droga to PUT z przegladarki prosto na signed URL Supabase (jak publish-release.ps1).
 * Gdy przegladarka nie moze (CORS), strona sprobuje tu.
 *
 * Vercel ucina cialo funkcji na 4,5 MB - stad twardy prog 4 MB. Wieksza paczka
 * ma isc signed URL-em albo skryptem; ten endpoint odpowiada 413 z jasnym powodem.
 *
 * PUT /api/releases/<version>/upload   body: application/zip   Bearer admin / cookie
 *   204 | 413 | 404 (brak zapowiedzi wersji) | 401 | 400
 */
export const dynamic = 'force-dynamic'

const MAX_PROXY_BYTES = 4 * 1024 * 1024

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ version: string }> }
) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const version = (await params).version
  if (!isValidVersion(version)) {
    return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
  }

  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_PROXY_BYTES) {
    return NextResponse.json(
      { error: `Package ${(declared / 1048576).toFixed(1)} MB exceeds proxy limit 4 MB - use direct upload` },
      { status: 413 }
    )
  }

  const { data: row, error } = await supabaseAdmin
    .from('releases')
    .select('storage_path, status')
    .eq('version', version)
    .maybeSingle()
  if (error) {
    console.error('[releases] proxy upload lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'Version not announced (POST /api/releases first)' }, { status: 404 })
  if (row.status === 'published') {
    return NextResponse.json({ error: 'Version already published' }, { status: 409 })
  }

  const bytes = Buffer.from(await req.arrayBuffer())
  if (bytes.length === 0) return NextResponse.json({ error: 'Empty body' }, { status: 400 })
  if (bytes.length > MAX_PROXY_BYTES) {
    return NextResponse.json({ error: 'Package exceeds proxy limit 4 MB - use direct upload' }, { status: 413 })
  }

  const { error: upError } = await supabaseAdmin.storage
    .from(RELEASES_BUCKET)
    .upload(row.storage_path, bytes, { contentType: 'application/zip', upsert: true })
  if (upError) {
    console.error('[releases] proxy upload failed', upError)
    return NextResponse.json({ error: 'Storage upload failed' }, { status: 500 })
  }

  return new NextResponse(null, { status: 204 })
}
