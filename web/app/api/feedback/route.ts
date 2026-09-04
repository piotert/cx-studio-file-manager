import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { clientIp, requireScope } from '@/lib/auth'
import {
  FEEDBACK_BUCKET,
  INLINE_LOG_LIMIT_BYTES,
  MAX_LOG_BYTES,
  RATE_LIMIT_PER_HOUR,
  logStoragePath,
  parseFeedbackPayload,
} from '@/lib/feedback'

/**
 * Przyjmuje zgloszenie z add-inu. Token zapisu — nie daje odczytu niczego.
 *
 * Cialo zadania: multipart/form-data z polem `payload` (JSON) i opcjonalnym
 * `log` (ZIP), albo samo application/json z payloadem.
 *
 * Log ponizej INLINE_LOG_LIMIT_BYTES zapisujemy od razu. Wiekszy nie zmiesci
 * sie w limicie 4,5 MB funkcji Vercela, wiec zamiast niego oddajemy klientowi
 * signed URL — wrzuca plik prosto do Supabase Storage, z pominieciem API.
 */
export async function POST(req: NextRequest) {
  const denied = requireScope(req, 'write')
  if (denied) return denied

  const contentType = req.headers.get('content-type') ?? ''
  let rawPayload: unknown
  let logBlob: File | null = null

  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData()
      const payloadField = form.get('payload')
      if (typeof payloadField !== 'string') {
        return NextResponse.json({ error: 'Missing "payload" field' }, { status: 400 })
      }
      rawPayload = JSON.parse(payloadField)
      const log = form.get('log')
      logBlob = log instanceof File ? log : null
    } else {
      rawPayload = await req.json()
    }
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const parsed = parseFeedbackPayload(rawPayload)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }
  const payload = parsed.value

  if (logBlob && logBlob.size > MAX_LOG_BYTES) {
    return NextResponse.json({ error: 'Log exceeds 10 MB' }, { status: 413 })
  }

  const ip = clientIp(req)

  // Rate limiting po IP. Wyciekly token zapisu jest kwestia czasu, wiec to
  // jedyna realna bariera przed zasmieceniem bazy.
  if (ip) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count, error } = await supabaseAdmin
      .from('feedback')
      .select('id', { count: 'exact', head: true })
      .eq('client_ip', ip)
      .gte('created_at', since)

    if (error) {
      console.error('[feedback] rate limit check failed', error)
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
    }
    if ((count ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return NextResponse.json(
        { error: 'Too many reports from this address, try again later' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      )
    }
  }

  const wantsLog = !!logBlob || !!payload.logFile

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('feedback')
    .insert({
      kind: payload.kind,
      description: payload.description,
      user_name: payload.user,
      addin_version: payload.version,
      context: payload.context,
      client_created_at: payload.createdAt,
      client_ip: ip,
      log_path: null,
      log_uploaded: false,
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    console.error('[feedback] insert failed', insertError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  const id = inserted.id as number

  if (!wantsLog) {
    return NextResponse.json({ id }, { status: 201 })
  }

  const path = logStoragePath(id, logBlob?.name ?? payload.logFile)

  // Maly log: zapisujemy od razu, klient ma wszystko w jednym zadaniu.
  if (logBlob && logBlob.size <= INLINE_LOG_LIMIT_BYTES) {
    const buffer = Buffer.from(await logBlob.arrayBuffer())
    const { error: uploadError } = await supabaseAdmin.storage
      .from(FEEDBACK_BUCKET)
      .upload(path, buffer, { contentType: 'application/zip', upsert: true })

    if (uploadError) {
      // Zgloszenie juz jest w bazie — nie gubimy go przez sam problem z logiem.
      console.error('[feedback] log upload failed', uploadError)
      return NextResponse.json({ id, logStored: false }, { status: 201 })
    }

    await supabaseAdmin
      .from('feedback')
      .update({ log_path: path, log_uploaded: true })
      .eq('id', id)

    return NextResponse.json({ id, logStored: true }, { status: 201 })
  }

  // Duzy log albo klient tylko zapowiedzial plik: oddajemy signed URL.
  const { data: signed, error: signError } = await supabaseAdmin.storage
    .from(FEEDBACK_BUCKET)
    .createSignedUploadUrl(path, { upsert: true })

  if (signError || !signed) {
    console.error('[feedback] signed upload url failed', signError)
    return NextResponse.json({ id, logStored: false }, { status: 201 })
  }

  await supabaseAdmin.from('feedback').update({ log_path: path }).eq('id', id)

  return NextResponse.json(
    {
      id,
      logStored: false,
      logUpload: { url: signed.signedUrl, token: signed.token, path: signed.path, method: 'PUT' },
    },
    { status: 201 }
  )
}
