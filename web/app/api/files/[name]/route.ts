import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, BUCKET } from '@/lib/supabase'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list('', {
    search: name,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const exists = (data ?? []).some((f) => f.name === name)
  return NextResponse.json({ name, exists })
}
