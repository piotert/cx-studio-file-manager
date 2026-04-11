import { NextResponse } from 'next/server'
import { supabaseAdmin, BUCKET } from '@/lib/supabase'

export async function GET() {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list('', {
    limit: 200,
    sortBy: { column: 'created_at', order: 'desc' },
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const files = (data ?? []).map((item) => {
    const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(item.name)
    const ext = item.name.split('.').pop()?.toLowerCase()
    return {
      name: item.name,
      url: urlData.publicUrl,
      type: ext === 'json' ? 'json' : ext === 'gltf' || ext === 'glb' ? 'gltf' : 'other',
      size: item.metadata?.size ?? null,
      createdAt: item.created_at,
    }
  })

  return NextResponse.json({ files })
}
