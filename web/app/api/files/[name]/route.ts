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

  // pliki sa zapisywane z prefiksem timestamp: "1234567890_nazwa.json"
  // szukamy po dokladnej nazwie lub po suffixie
  const match = (data ?? []).find((f) => f.name === name || f.name.endsWith(`_${name}`))
  return NextResponse.json({ name, exists: !!match, storedAs: match?.name ?? null })
}
