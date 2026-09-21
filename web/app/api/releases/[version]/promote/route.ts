import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/lib/auth'
import { isValidVersion, promoteRelease } from '@/lib/releases'

/**
 * Promocja JUZ opublikowanej wersji (21.09, pod strone /releases).
 * finalize promuje tylko w chwili publikacji; przelaczenie "aktualnej" miedzy
 * istniejacymi wersjami (rollback do poprzedniej, zmiana mandatory) idzie tedy.
 *
 * POST /api/releases/<version>/promote   body: { "mandatory": bool }   Bearer admin / cookie
 *   200 { version, mandatory }
 *   404 nie ma takiej OPUBLIKOWANEJ wersji (pending nie da sie promowac)
 *   400 zly numer albo zly typ mandatory
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ version: string }> }
) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const version = (await params).version
  if (!isValidVersion(version)) {
    return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
  }

  let mandatory = false
  const raw = await req.text()
  if (raw.trim().length > 0) {
    let body: { mandatory?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    if (body.mandatory !== undefined && typeof body.mandatory !== 'boolean') {
      return NextResponse.json({ error: 'mandatory must be boolean' }, { status: 400 })
    }
    mandatory = body.mandatory === true
  }

  try {
    const err = await promoteRelease(version, mandatory)
    if (err === 'Version not published') {
      return NextResponse.json({ error: err }, { status: 404 })
    }
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  } catch (error) {
    console.error('[releases] promote failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ version, mandatory })
}
