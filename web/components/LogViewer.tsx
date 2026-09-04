'use client'

import { useEffect, useMemo, useState } from 'react'

type Level = 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'plain'

interface Line {
  time: string | null
  level: Level
  context: string | null
  method: string | null
  message: string
  /** Kontynuacja poprzedniego wpisu — stack trace, wielolinijkowy komunikat. */
  cont: boolean
}

/** Serilog skraca poziomy do trzech liter, ale przyjmujemy tez pelne nazwy. */
const LEVELS: Record<string, Level> = {
  VRB: 'verbose', TRC: 'verbose', VERBOSE: 'verbose', TRACE: 'verbose',
  DBG: 'debug', DEBUG: 'debug',
  INF: 'info', INFO: 'info', INFORMATION: 'info',
  WRN: 'warn', WARN: 'warn', WARNING: 'warn',
  ERR: 'error', ERROR: 'error',
  FTL: 'fatal', FATAL: 'fatal', CRIT: 'fatal', CRITICAL: 'fatal',
}

const LEVEL_TEXT: Record<Level, string> = {
  verbose: 'text-gray-600',
  debug: 'text-gray-400',
  info: 'text-sky-300',
  warn: 'text-amber-300',
  error: 'text-red-400',
  fatal: 'text-fuchsia-300',
  plain: 'text-gray-400',
}

const LEVEL_BADGE: Record<Level, string> = {
  verbose: 'text-gray-600',
  debug: 'text-gray-500',
  info: 'text-sky-400',
  warn: 'text-amber-400',
  error: 'text-red-400 font-semibold',
  fatal: 'text-fuchsia-400 font-semibold',
  plain: 'text-gray-700',
}

const LEVEL_ROW: Record<Level, string> = {
  verbose: '',
  debug: '',
  info: '',
  warn: 'bg-amber-500/[0.06]',
  error: 'bg-red-500/[0.08]',
  fatal: 'bg-fuchsia-500/[0.10]',
  plain: '',
}

/** [12:09:45.167] DBG  [AddinRuntime] ".Metoda" | "Komunikat" */
const HEAD = /^\[(\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?)\]\s+([A-Za-z]{3,11})\b\s*(.*)$/
const CONTEXT = /^\[([^\]]*)\]\s*(.*)$/

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).trim()
  return t
}

function parse(text: string): Line[] {
  const out: Line[] = []
  let last: Level = 'plain'

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) {
      out.push({ time: null, level: last, context: null, method: null, message: '', cont: true })
      continue
    }

    const head = HEAD.exec(line)
    if (!head) {
      // Stack trace i przenoszone komunikaty dziedzicza poziom wpisu wyzej.
      out.push({ time: null, level: last, context: null, method: null, message: line, cont: true })
      continue
    }

    const [, time, levelRaw, rest0] = head
    const level = LEVELS[levelRaw.toUpperCase()] ?? 'plain'
    last = level

    let rest = rest0
    let context: string | null = null
    const ctx = CONTEXT.exec(rest)
    if (ctx) {
      context = ctx[1]
      rest = ctx[2]
    }

    let method: string | null = null
    let message = rest
    const bar = rest.indexOf('|')
    if (bar > 0) {
      method = unquote(rest.slice(0, bar))
      message = rest.slice(bar + 1)
    }

    out.push({ time, level, context, method: method || null, message: unquote(message), cont: false })
  }

  return out
}

/** Ile linii renderujemy na raz — kilkadziesiat tysiecy wezlow zabija scroll. */
const PAGE = 2000

export default function LogViewer({ id }: { id: number }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; content: string; name: string; files: Array<{ name: string; size: number }>; truncated: boolean; binary: boolean; size: number }
  >({ kind: 'loading' })
  const [file, setFile] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)

  useEffect(() => {
    let alive = true
    const url = file
      ? `/api/feedback/${id}/log/preview?file=${encodeURIComponent(file)}`
      : `/api/feedback/${id}/log/preview`

    fetch(url)
      .then(async (res) => {
        if (!alive) return
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setState({ kind: 'error', message: body.error ?? 'Nie udało się wczytać logu.' })
          return
        }
        const d = await res.json()
        if (!alive) return
        setState({ kind: 'ready', ...d })
      })
      .catch(() => {
        if (alive) setState({ kind: 'error', message: 'Nie udało się wczytać logu.' })
      })

    return () => {
      alive = false
    }
  }, [id, file])

  const lines = useMemo(
    () => (state.kind === 'ready' && !state.binary ? parse(state.content) : []),
    [state]
  )

  const counts = useMemo(() => {
    const c: Partial<Record<Level, number>> = {}
    for (const l of lines) if (!l.cont) c[l.level] = (c[l.level] ?? 0) + 1
    return c
  }, [lines])

  if (state.kind === 'loading') {
    return <div className="px-3 py-2 text-[11px] text-gray-500">Rozpakowuję log…</div>
  }
  if (state.kind === 'error') {
    return <div className="px-3 py-2 text-[11px] text-red-400">{state.message}</div>
  }
  if (state.binary) {
    return (
      <div className="px-3 py-2 text-[11px] text-gray-500">
        {state.name} to plik binarny ({(state.size / 1024).toFixed(0)} kB) — pobierz go, żeby obejrzeć.
      </div>
    )
  }

  // Koniec pliku jest najciekawszy, wiec pokazujemy ogon.
  const visible = lines.slice(Math.max(0, lines.length - shown))
  const hidden = lines.length - visible.length

  return (
    <div className="border border-gray-800 rounded overflow-hidden">
      <div className="px-2 py-1.5 flex flex-wrap items-center gap-2 bg-gray-900/60 border-b border-gray-800">
        {state.files.length > 1 ? (
          <select
            value={state.name}
            onChange={(e) => {
              setShown(PAGE)
              setState({ kind: 'loading' })
              setFile(e.target.value)
            }}
            className="px-1.5 py-0.5 text-[11px] bg-gray-900 border border-gray-700 rounded text-gray-200
                       focus:outline-none focus:border-gray-500"
          >
            {state.files.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} ({(f.size / 1024).toFixed(0)} kB)
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] font-mono text-gray-400">{state.name}</span>
        )}

        <span className="text-[10px] text-gray-600">{lines.length} linii</span>

        {(['fatal', 'error', 'warn', 'info', 'debug', 'verbose'] as Level[])
          .filter((l) => counts[l])
          .map((l) => (
            <span key={l} className={`text-[10px] ${LEVEL_BADGE[l]}`}>
              {l.toUpperCase()} {counts[l]}
            </span>
          ))}

        {state.truncated && (
          <span className="text-[10px] text-amber-400/80">
            pokazany koniec pliku ({(state.size / 1024 / 1024).toFixed(1)} MB w całości)
          </span>
        )}
      </div>

      <div className="max-h-[28rem] overflow-auto bg-gray-950">
        {hidden > 0 && (
          <button
            onClick={() => setShown((n) => n + PAGE)}
            className="w-full px-3 py-1.5 text-[11px] text-gray-500 hover:text-gray-300
                       hover:bg-gray-900/60 transition-colors border-b border-gray-800/60"
          >
            ↑ pokaż wcześniejsze {Math.min(PAGE, hidden)} linii ({hidden} ukrytych)
          </button>
        )}

        <div className="font-mono text-[11px] leading-[1.45]">
          {visible.map((l, i) => (
            <div
              key={i}
              className={`px-2 flex gap-2 hover:bg-gray-900/70 ${LEVEL_ROW[l.level]}`}
            >
              {l.cont ? (
                <span className={`whitespace-pre-wrap break-all pl-[7.5rem] ${LEVEL_TEXT[l.level]} opacity-70`}>
                  {l.message}
                </span>
              ) : (
                <>
                  <span className="text-gray-600 shrink-0 tabular-nums">{l.time}</span>
                  <span className={`shrink-0 w-8 ${LEVEL_BADGE[l.level]}`}>
                    {l.level === 'plain' ? '' : l.level.slice(0, 3).toUpperCase()}
                  </span>
                  {l.context && (
                    <span className="text-violet-400/70 shrink-0 hidden lg:inline">[{l.context}]</span>
                  )}
                  {l.method && (
                    <span className="text-gray-600 shrink-0 hidden xl:inline">{l.method}</span>
                  )}
                  <span className={`whitespace-pre-wrap break-all ${LEVEL_TEXT[l.level]}`}>
                    {l.message}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
