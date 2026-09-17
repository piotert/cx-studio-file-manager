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

/** Kasuje opublikowane wersje ponad RELEASES_KEEP. Zwraca skasowane numery. */
export async function pruneOldReleases(): Promise<string[]> {
  const published = await listPublished()
  const stale = published.slice(RELEASES_KEEP)
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
