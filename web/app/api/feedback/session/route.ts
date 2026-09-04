import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { ADMIN_COOKIE, hasScope, unauthorized } from '@/lib/auth'

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/**
 * Wymiana tokenu admina na ciasteczko sesyjne dla widoku w przegladarce.
 *
 * Token celowo nie jedzie w URL-u: trafilby do logow Vercela, historii
 * przegladarki i naglowka Referer. Ciasteczko jest httpOnly, wiec nie siegnie
 * po nie zaden skrypt na stronie.
 */
export async function POST(req: NextRequest) {
  let token = ''
  try {
    const body = await req.json()
    token = typeof body?.token === 'string' ? body.token.trim() : ''
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }

  // Sprawdzamy token tak samo jak przy naglowku Authorization.
  const probe = new Request(req.url, { headers: { authorization: `Bearer ${token}` } })
  if (!hasScope(probe, 'admin')) return unauthorized()

  const store = await cookies()
  store.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })

  return NextResponse.json({ ok: true })
}

/** Wylogowanie. */
export async function DELETE() {
  const store = await cookies()
  store.set(ADMIN_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return NextResponse.json({ ok: true })
}

/** Czy przegladarka ma wazna sesje — pyta o to widok przy starcie. */
export async function GET(req: NextRequest) {
  return NextResponse.json({ authenticated: hasScope(req, 'admin') })
}
