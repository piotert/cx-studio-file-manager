import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, BUCKET } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  // Auth check
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const expected = process.env.UPLOAD_BEARER_TOKEN ?? ''
  if (!token || token !== expected) {
    return NextResponse.json({
      error: 'Unauthorized',
      debug: { tokenLen: token.length, expectedLen: expected.length, envSet: !!expected }
    }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const allowedTypes = ['application/json', 'model/gltf+json', 'model/gltf-binary']
  const allowedExtensions = ['.json', '.gltf', '.glb']
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()

  if (!allowedExtensions.includes(ext)) {
    return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
  }

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const path = `${Date.now()}_${file.name}`
  const contentType = file.type || (ext === '.glb' ? 'model/gltf-binary' : 'application/octet-stream')

  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, upsert: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path)

  return NextResponse.json({ path, url: urlData.publicUrl }, { status: 201 })
}
