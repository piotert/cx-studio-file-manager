export const FEEDBACK_BUCKET = 'feedback'

export const FEEDBACK_KINDS = ['Blad', 'Sugestia', 'Pytanie'] as const
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_STATUSES = ['new', 'in_progress', 'done', 'wontfix'] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

/** Zgodne z MaxUploadBytes w add-inie. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024

/**
 * Vercel odrzuca zadania powyzej 4,5 MB bledem 413 FUNCTION_PAYLOAD_TOO_LARGE,
 * i dotyczy to calego multiparta. Ponizej tego progu przyjmujemy log wprost
 * w zadaniu; wieksze musza pojsc signed URL-em prosto do Supabase Storage.
 * Zapas na naglowki multiparta i reszte pol.
 */
export const INLINE_LOG_LIMIT_BYTES = 4 * 1024 * 1024

/** Ile zgloszen z jednego IP na godzine. */
export const RATE_LIMIT_PER_HOUR = 10

export const MAX_DESCRIPTION_CHARS = 20_000

/** Ile znakow opisu pokazuje lista, zeby nie ciagnac calych zgloszen. */
export const LIST_SNIPPET_CHARS = 200

export interface FeedbackPayload {
  kind: FeedbackKind
  description: string
  user: string | null
  version: string | null
  context: string | null
  createdAt: string | null
  logFile: string | null
}

function trimmedOrNull(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  return text.slice(0, max)
}

/**
 * Czas z zegara uzytkownika przychodzi bez strefy ("2026-09-03 14:22:07").
 * Interpretujemy go jako UTC — nie znamy strefy stacji roboczej. Sluzy
 * wylacznie do porownania z created_at serwera, nigdy do sortowania.
 */
function parseClientTimestamp(value: unknown): string | null {
  const text = trimmedOrNull(value, 40)
  if (!text) return null
  const parsed = new Date(text.replace(' ', 'T') + (/[Zz]|[+-]\d{2}:?\d{2}$/.test(text) ? '' : 'Z'))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export type ParseResult =
  | { ok: true; value: FeedbackPayload }
  | { ok: false; error: string }

export function parseFeedbackPayload(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Payload must be a JSON object' }
  }
  const input = raw as Record<string, unknown>

  const kind = trimmedOrNull(input.kind, 32)
  if (!kind || !FEEDBACK_KINDS.includes(kind as FeedbackKind)) {
    return { ok: false, error: `Field "kind" must be one of: ${FEEDBACK_KINDS.join(', ')}` }
  }

  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (!description) {
    return { ok: false, error: 'Field "description" is required' }
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `Field "description" exceeds ${MAX_DESCRIPTION_CHARS} characters` }
  }

  return {
    ok: true,
    value: {
      kind: kind as FeedbackKind,
      description,
      user: trimmedOrNull(input.user, 200),
      version: trimmedOrNull(input.version, 64),
      context: trimmedOrNull(input.context, 2000),
      createdAt: parseClientTimestamp(input.createdAt),
      logFile: trimmedOrNull(input.logFile, 260),
    },
  }
}

/**
 * Nazwa pliku od klienta trafia do sciezki w Storage, wiec musi byc bezpieczna:
 * zadnych separatorow katalogow ani wyjscia w gore drzewa.
 */
export function safeLogName(name: string | null): string {
  const fallback = 'log.zip'
  if (!name) return fallback
  const base = name.split(/[\\/]/).pop() ?? fallback
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  if (!cleaned || cleaned === '.zip') return fallback
  return cleaned.slice(0, 120)
}

/** Sciezka w buckecie: id zgloszenia daje unikalnosc i wiaze plik z rekordem. */
export function logStoragePath(id: number, name: string | null): string {
  return `${id}/${safeLogName(name)}`
}
