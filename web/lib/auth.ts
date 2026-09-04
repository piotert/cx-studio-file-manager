import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

/**
 * Dwa rozlaczne poziomy dostepu.
 *
 * `write`  - token rozsylany w appsettings.json add-inu, na kazdym komputerze
 *            uzytkownika. Zakladamy, ze wycieknie. Pozwala WYLACZNIE tworzyc
 *            zgloszenia i wrzucac pliki.
 * `admin`  - token wlasciciela. Listowanie, podglad, logi, zmiana statusu,
 *            kasowanie. Nigdy nie opuszcza serwera ani przegladarki wlasciciela.
 *
 * Token `write` celowo NIE daje odczytu ani kasowania.
 */
export type Scope = 'write' | 'admin'

/** Nazwa ciasteczka dla widoku przegladarki. Token nie trafia do URL-a. */
export const ADMIN_COOKIE = 'cx_admin'

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual rzuca przy roznych dlugosciach, wiec sprawdzamy je osobno.
  // Dlugosc tokenu nie jest sekretem, jego tresc juz tak.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Pusty lub nieustawiony sekret nigdy nie moze przepuscic zadania. */
function matches(candidate: string, secret: string | undefined): boolean {
  if (!candidate || !secret) return false
  return constantTimeEquals(candidate, secret)
}

function bearerToken(req: Request): string {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return ''
  return header.slice(7).trim()
}

function cookieToken(req: Request): string {
  const raw = req.headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === ADMIN_COOKIE) return decodeURIComponent(rest.join('='))
  }
  return ''
}

/**
 * Add-iny w terenie nadal wysylaja UPLOAD_BEARER_TOKEN — zostaje on tokenem
 * zapisu, zeby nie trzeba bylo aktualizowac konfiguracji u uzytkownikow.
 * FEEDBACK_WRITE_TOKEN jest opcjonalna nowa nazwa na przyszlosc.
 */
function writeSecrets(): Array<string | undefined> {
  return [process.env.FEEDBACK_WRITE_TOKEN, process.env.UPLOAD_BEARER_TOKEN]
}

function adminSecrets(): Array<string | undefined> {
  return [process.env.FEEDBACK_ADMIN_TOKEN]
}

/** Czy zadanie ma uprawnienia na danym poziomie. Admin implikuje write. */
export function hasScope(req: Request, scope: Scope): boolean {
  const presented = bearerToken(req) || cookieToken(req)
  if (!presented) return false

  const allowed =
    scope === 'admin' ? adminSecrets() : [...adminSecrets(), ...writeSecrets()]

  // Bez short-circuita: sprawdzamy wszystkie kandydatury, zeby czas odpowiedzi
  // nie zdradzal, ktory token pasowal.
  return allowed.reduce<boolean>((ok, secret) => matches(presented, secret) || ok, false)
}

/** Samo 401, bez wskazowki ktory token jest zly. */
export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

/** Zwraca null gdy dostep przyznany, albo gotowa odpowiedz 401. */
export function requireScope(req: Request, scope: Scope): NextResponse | null {
  return hasScope(req, scope) ? null : unauthorized()
}

/**
 * IP klienta zza proxy Vercela.
 *
 * Vercel nadpisuje x-forwarded-for adresem klienta i nie przepuszcza wartosci
 * przyslanych z zewnatrz — wlasnie po to, zeby nie dalo sie podszyc pod cudze
 * IP. x-vercel-forwarded-for jest jeszcze pewniejszy, bo nie nadpisze go proxy
 * postawione nad Vercelem, wiec probujemy go najpierw.
 *
 * `next dev` ustawia x-forwarded-for na ::1, wiec lokalnie rate limiting liczy
 * wszystkie zadania do jednego kubelka. Gdy zaden naglowek nie dojdzie,
 * zwracamy null i limit jest pomijany.
 */
export function clientIp(req: Request): string | null {
  for (const header of ['x-vercel-forwarded-for', 'x-forwarded-for', 'x-real-ip']) {
    const value = req.headers.get(header)
    if (!value) continue
    const first = value.split(',')[0]?.trim()
    if (first) return first
  }
  return null
}
