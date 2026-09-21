import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/supabase'

export const RELEASES_BUCKET = 'releases'

/**
 * Ile opublikowanych wersji trzymamy: najnowsza + 3 wstecz.
 * Starsze sa kasowane (plik i wiersz) przy kazdej publikacji.
 */
export const RELEASES_KEEP = Math.max(Number(process.env.RELEASES_KEEP) || 4, 1)

/** Ile sekund zyje link do pobrania paczki. */
export const DOWNLOAD_TTL_SECONDS = 300

export const MAX_RELEASE_BYTES = 52428800

const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/

export function isValidVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v)
}

/**
 * Porownanie numeryczne, nie tekstowe: '1.10.0' > '1.9.0'.
 * Brakujacy czwarty czlon traktujemy jak zero, tak jak updater
 * (FileVersion zwraca cztery czlony, serwer zwykle trzy).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export function releaseStoragePath(version: string): string {
  return `${version}/SWAddIn_CX-${version}.zip`
}

export type PublishedRelease = {
  version: string
  storage_path: string
  sha256: string | null
  size_bytes: number | null
  notes: string | null
  published_at: string | null
}

/** Opublikowane wersje, od najnowszej (kolejnosc semver, nie data). */
export async function listPublished(): Promise<PublishedRelease[]> {
  const { data, error } = await supabaseAdmin
    .from('releases')
    .select('version, storage_path, sha256, size_bytes, notes, published_at')
    .eq('status', 'published')
  if (error) throw error
  return ((data ?? []) as PublishedRelease[]).sort((x, y) =>
    compareVersions(y.version, x.version)
  )
}

/** SHA-256 i rozmiar liczone z pliku, ktory faktycznie lezy w Storage. */
export async function hashStoredFile(
  path: string
): Promise<{ sha256: string; sizeBytes: number } | null> {
  const { data, error } = await supabaseAdmin.storage.from(RELEASES_BUCKET).download(path)
  if (error || !data) return null
  const buffer = Buffer.from(await data.arrayBuffer())
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
  }
}

/** Kasuje opublikowane wersje ponad RELEASES_KEEP. Zwraca skasowane numery.
 *
 * NIGDY nie kasuje wersji wskazywanej przez app_release (S2/S6, 21.09): to ta,
 * ktora /api/update kaze klientom pobrac. Retencja liczy sie od pozostalych.
 * Bez tego wyjatku publikacja 5. wersji skasowalaby promowana, gdyby byla
 * najstarsza - i /api/update wskazywalby paczke, ktorej nie ma. */
export async function pruneOldReleases(): Promise<string[]> {
  const published = await listPublished()
  const promoted = (await getAppRelease())?.version ?? null
  const candidates = published.filter((r) => r.version !== promoted)
  const keep = promoted ? Math.max(RELEASES_KEEP - 1, 0) : RELEASES_KEEP
  const stale = candidates.slice(keep)
  if (stale.length === 0) return []

  const { error: storageError } = await supabaseAdmin.storage
    .from(RELEASES_BUCKET)
    .remove(stale.map((r) => r.storage_path))
  if (storageError) {
    // Wiersze zostaja - przy nastepnej publikacji sprobujemy ponownie.
    console.error('[releases] prune storage failed', storageError)
    return []
  }

  const versions = stale.map((r) => r.version)
  const { error } = await supabaseAdmin.from('releases').delete().in('version', versions)
  if (error) console.error('[releases] prune rows failed', error)
  return versions
}

// ==== app_release (jednowierszowa wskazowka "co klient ma pobrac") ==========

export type AppRelease = {
  version: string | null
  download_url: string | null
  notes: string | null
  mandatory: boolean
  sha256: string | null
  released_at: string | null
  published: boolean
}

export async function getAppRelease(): Promise<AppRelease | null> {
  const { data, error } = await supabaseAdmin
    .from('app_release')
    .select('version, download_url, notes, mandatory, sha256, released_at, published')
    .eq('id', 1)
    .maybeSingle()
  if (error) throw error
  return (data as AppRelease | null) ?? null
}

/** Opublikowana wersja po numerze albo null. */
export async function getPublishedRelease(version: string): Promise<PublishedRelease | null> {
  const { data, error } = await supabaseAdmin
    .from('releases')
    .select('version, storage_path, sha256, size_bytes, notes, published_at')
    .eq('version', version)
    .eq('status', 'published')
    .maybeSingle()
  if (error) throw error
  return (data as PublishedRelease | null) ?? null
}

/**
 * Ustawia app_release na OPUBLIKOWANA wersje z magazynu (S6, 21.09).
 * Jedyne miejsce zapisu app_release z kodu - tu siedzi walidacja S1:
 * wersja musi pasowac do x.y.z[.w] I istniec w releases jako published.
 * Zwraca null przy sukcesie, albo komunikat bledu.
 */
export async function promoteRelease(
  version: string,
  mandatory: boolean
): Promise<string | null> {
  if (!isValidVersion(version)) return 'Invalid version'
  const rel = await getPublishedRelease(version)
  if (!rel) return 'Version not published'

  const { error } = await supabaseAdmin.from('app_release').upsert(
    {
      id: 1,
      version,
      // Adres do przegladarki przy mandatory; updater i tak idzie przez ?json=1.
      download_url: `/api/releases/${version}/download`,
      notes: rel.notes,
      mandatory,
      sha256: rel.sha256,
      released_at: rel.published_at ?? new Date().toISOString(),
      published: true,
    },
    { onConflict: 'id' }
  )
  if (error) {
    console.error('[releases] promote failed', error)
    return 'Internal error'
  }
  return null
}

export type DeleteOutcome = 'deleted' | 'not_found' | 'promoted' | 'error'

/**
 * Kasuje wersje (plik + wiersz), dowolny status (S5, 21.09).
 * ODMAWIA dla wersji wskazywanej przez app_release - inaczej jedno zadanie
 * zostawiloby /api/update z paczka, ktorej nie ma (lamie S2).
 */
export async function deleteRelease(version: string): Promise<DeleteOutcome> {
  const promoted = (await getAppRelease())?.version ?? null
  if (promoted && promoted === version) return 'promoted'

  const { data: row, error } = await supabaseAdmin
    .from('releases')
    .select('storage_path')
    .eq('version', version)
    .maybeSingle()
  if (error) {
    console.error('[releases] delete lookup failed', error)
    return 'error'
  }
  if (!row) return 'not_found'

  const { error: storageError } = await supabaseAdmin.storage
    .from(RELEASES_BUCKET)
    .remove([row.storage_path])
  // brak pliku w Storage nie blokuje - wiersz i tak ma zniknac
  if (storageError) console.warn('[releases] delete storage', version, storageError.message)

  const { error: rowError } = await supabaseAdmin.from('releases').delete().eq('version', version)
  if (rowError) {
    console.error('[releases] delete row failed', rowError)
    return 'error'
  }
  return 'deleted'
}
