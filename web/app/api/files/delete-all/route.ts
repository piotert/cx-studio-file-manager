import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, BUCKET } from '@/lib/supabase'

export async function DELETE(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || token !== process.env.DELETE_BEARER_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error: listError } = await supabaseAdmin.storage.from(BUCKET).list('', { limit: 1000 })
  if (listError) {
    return NextResponse.json({ error: listError.message }, { status: 500 })
  }

  const names = (data ?? []).map((f) => f.name)
  if (names.length === 0) {
    return NextResponse.json({ deleted: 0 })
  }

  const { error: removeError } = await supabaseAdmin.storage.from(BUCKET).remove(names)
  if (removeError) {
    return NextResponse.json({ error: removeError.message }, { status: 500 })
  }

  return NextResponse.json({ deleted: names.length, files: names })
}
