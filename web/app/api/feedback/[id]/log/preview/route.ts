import { NextRequest, NextResponse } from 'next/server'
import { unzipSync, strFromU8 } from 'fflate'
import { supabaseAdmin } from '@/lib/supabase'
import { requireScope } from '@/lib/auth'
import { FEEDBACK_BUCKET } from '@/lib/feedback'

/**
 * Odpowiedz funkcji Vercela nie moze przekroczyc 4,5 MB, wiec tniemy tresc
 * z zapasem na JSON i naglowki. Przy przekroczeniu oddajemy KONIEC pliku —
 * przy diagnozie liczy sie to, co dzialo sie tuz przed zgloszeniem.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Plik binarny w archiwum nie ma sensu jako podglad tekstowy. */
function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 4000)
  for (const b of probe) if (b === 0) return true
  return false
}

/**
 * Rozpakowuje ZIP z logiem i oddaje jego tresc jako tekst.
 *
 * Rozpakowanie robimy na serwerze, zeby przegladarka nie musiala ciagnac
 * biblioteki do ZIP-a ani calego archiwum.
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
    .select('id, log_path')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    console.error('[feedback] preview lookup failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
  if (!row?.log_path) return NextResponse.json({ error: 'No log attached' }, { status: 404 })

  const { data: blob, error: dlError } = await supabaseAdmin.storage
    .from(FEEDBACK_BUCKET)
    .download(row.log_path)

  if (dlError || !blob) {
    return NextResponse.json({ error: 'Log not available' }, { status: 404 })
  }

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  } catch {
    return NextResponse.json({ error: 'Nie udało się rozpakować archiwum' }, { status: 422 })
  }

  // Katalogi pojawiaja sie jako puste wpisy — pomijamy je.
  const names = Object.keys(entries).filter((n) => !n.endsWith('/') && entries[n].length > 0)
  if (names.length === 0) {
    return NextResponse.json({ error: 'Archiwum jest puste' }, { status: 404 })
  }

  const requested = req.nextUrl.searchParams.get('file')
  const name = requested && names.includes(requested) ? requested : names[0]
  const bytes = entries[name]

  const files = names.map((n) => ({ name: n, size: entries[n].length }))

  if (looksBinary(bytes)) {
    return NextResponse.json({
      files,
      name,
      binary: true,
      size: bytes.length,
      content: '',
      truncated: false,
    })
  }

  const truncated = bytes.length > MAX_TEXT_BYTES
  const slice = truncated ? bytes.subarray(bytes.length - MAX_TEXT_BYTES) : bytes
  let content = strFromU8(slice)

  // Po przycieciu od konca pierwsza linia bywa urwana w polowie — tniemy ja.
  if (truncated) {
    const firstBreak = content.indexOf('\n')
    if (firstBreak >= 0) content = content.slice(firstBreak + 1)
  }

  return NextResponse.json({
    files,
    name,
    binary: false,
    size: bytes.length,
    content,
    truncated,
  })
}
