import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, BUCKET } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'

export async function DELETE(req: NextRequest) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

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
