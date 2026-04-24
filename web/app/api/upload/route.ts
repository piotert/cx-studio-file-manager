import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin, BUCKET } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token || token !== process.env.UPLOAD_BEARER_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const allowedExtensions = ['.json', '.gltf', '.glb']
  const ext = '.' + file.name.split('.').pop()?.toLowerCase()

  if (!allowedExtensions.includes(ext)) {
    return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
  }

  const timestamp = Date.now()

  // For .gltf files, accept an optional .bin companion.
  // The .bin is stored first, then the .gltf is patched with its absolute URL
  // so GLTFLoader can resolve the buffer regardless of where the .gltf is hosted.
  let binPublicUrl: string | null = null
  if (ext === '.gltf') {
    const binFile = formData.get('bin') as File | null
    if (binFile) {
      if (!binFile.name.toLowerCase().endsWith('.bin')) {
        return NextResponse.json({ error: 'Secondary file must be a .bin' }, { status: 400 })
      }
      const binBuffer = Buffer.from(await binFile.arrayBuffer())
      const binPath = `${timestamp}_${binFile.name}`
      const { error: binErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(binPath, binBuffer, { contentType: 'application/octet-stream', upsert: false })
      if (binErr) {
        return NextResponse.json({ error: binErr.message }, { status: 500 })
      }
      const { data: binUrlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(binPath)
      binPublicUrl = binUrlData.publicUrl
    }
  }

  let fileBuffer: Buffer
  let contentType: string

  if (ext === '.gltf' && binPublicUrl) {
    // Patch buffers[].uri to absolute Supabase URL so GLTFLoader can fetch the .bin
    const gltfJson = JSON.parse(await file.text())
    if (Array.isArray(gltfJson.buffers)) {
      for (const buf of gltfJson.buffers as Array<{ uri?: string }>) {
        if (
          typeof buf.uri === 'string' &&
          !buf.uri.startsWith('data:') &&
          !buf.uri.startsWith('http')
        ) {
          buf.uri = binPublicUrl
        }
      }
    }
    fileBuffer = Buffer.from(JSON.stringify(gltfJson))
    contentType = 'model/gltf+json'
  } else {
    fileBuffer = Buffer.from(await file.arrayBuffer())
    contentType =
      file.type ||
      (ext === '.glb' ? 'model/gltf-binary' : ext === '.gltf' ? 'model/gltf+json' : 'application/octet-stream')
  }

  const path = `${timestamp}_${file.name}`
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, fileBuffer, { contentType, upsert: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path)

  return NextResponse.json({ path, url: urlData.publicUrl }, { status: 201 })
}
