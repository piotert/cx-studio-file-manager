import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import { FEEDBACK_BUCKET } from '@/lib/feedback'

/** Ile sekund zyje link do pobrania logu. */
const DOWNLOAD_TTL_SECONDS = 300

/**
 * Link do pobrania logu. Token admina.
 *
 * Bucket jest prywatny, wiec oddajemy krotko zyjacy signed URL zamiast
 * przepuszczac kilkanascie megabajtow przez funkcje — i tak nie zmiescilyby
 * sie w limicie 4,5 MB na odpowiedz.
 *
 * Przy sciezce z signed uploadem nic nie potwierdza, ze klient faktycznie
 * wgral plik, wiec sprawdzamy to tutaj i przy okazji domykamy log_uploaded.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  }

  const { data: row, error } = await supabaseAdmin
    .from('feedback')
    .select('id, log_path, log_uploaded')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[feedback] log lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!row.log_path) return NextResponse.json({ error: 'No log attached' }, { status: 404 })

  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(FEEDBACK_BUCKET)
    .createSignedUrl(row.log_path, DOWNLOAD_TTL_SECONDS, { download: true })

  if (signError || !signed) {
    // Najczestsza przyczyna: zapowiedziany log nigdy nie zostal wgrany.
    if (row.log_uploaded) {
      await supabaseAdmin.from('feedback').update({ log_uploaded: false }).eq('id', id)
    }
    return NextResponse.json({ error: 'Log not available' }, { status: 404 })
  }

  if (!row.log_uploaded) {
    await supabaseAdmin.from('feedback').update({ log_uploaded: true }).eq('id', id)
  }

  return NextResponse.json({ url: signed.signedUrl, expiresInSeconds: DOWNLOAD_TTL_SECONDS })
}
