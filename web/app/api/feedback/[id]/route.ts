import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import { FEEDBACK_STATUSES, MAX_DESCRIPTION_CHARS, type FeedbackStatus } from '@/lib/feedback'

const COLUMNS =
  'id, created_at, client_created_at, kind, description, user_name, addin_version, context, log_path, log_uploaded, status, notes, client_ip, updated_at'

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/** Pelne zgloszenie. Token admina. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const id = parseId((await params).id)
  if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const { data, error } = await supabaseAdmin
    .from('feedback')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[feedback] fetch failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(data)
}

/** Zmiana statusu i notatek. Token admina. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const id = parseId((await params).id)
  if (id === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  const patch: { status?: FeedbackStatus; notes?: string | null } = {}

  if ('status' in body) {
    const status = body.status
    if (typeof status !== 'string' || !FEEDBACK_STATUSES.includes(status as FeedbackStatus)) {
      return NextResponse.json(
        { error: `Field "status" must be one of: ${FEEDBACK_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }
    patch.status = status as FeedbackStatus
  }

  if ('notes' in body) {
    const notes = body.notes
    if (notes === null) {
      patch.notes = null
    } else if (typeof notes === 'string') {
      patch.notes = notes.slice(0, MAX_DESCRIPTION_CHARS)
    } else {
      return NextResponse.json({ error: 'Field "notes" must be a string or null' }, { status: 400 })
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('feedback')
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .maybeSingle()

  if (error) {
    console.error('[feedback] update failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(data)
}
