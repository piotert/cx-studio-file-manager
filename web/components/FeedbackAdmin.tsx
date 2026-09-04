'use client'

import { useEffect, useState } from 'react'

type Status = 'new' | 'in_progress' | 'done' | 'wontfix'

interface ListItem {
  id: number
  created_at: string
  client_created_at: string | null
  kind: string
  snippet: string
  truncated: boolean
  user_name: string | null
  addin_version: string | null
  context: string | null
  log_path: string | null
  log_uploaded: boolean
  status: Status
  notes: string | null
}

interface Detail extends Omit<ListItem, 'snippet' | 'truncated'> {
  description: string
  client_ip: string | null
  updated_at: string
}

const STATUSES: Array<{ value: Status; label: string }> = [
  { value: 'new', label: 'Nowe' },
  { value: 'in_progress', label: 'W toku' },
  { value: 'done', label: 'Zrobione' },
  { value: 'wontfix', label: 'Odrzucone' },
]

const STATUS_STYLE: Record<Status, string> = {
  new: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  in_progress: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  wontfix: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

const KIND_STYLE: Record<string, string> = {
  Blad: 'bg-red-500/15 text-red-300 border-red-500/30',
  Sugestia: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  Pytanie: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ---------------------------------------------------------------- logowanie */

function TokenGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const res = await fetch('/api/feedback/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    setBusy(false)
    if (res.ok) {
      setToken('')
      onAuthenticated()
    } else {
      setError('Nieprawidłowy token.')
    }
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3">
        <h1 className="text-sm font-semibold text-gray-200">Zgłoszenia — dostęp</h1>
        <p className="text-xs text-gray-500 leading-relaxed">
          Wklej token administratora. Zapisze się w ciasteczku httpOnly, więc nie trafi
          do adresu URL ani do historii przeglądarki.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          placeholder="FEEDBACK_ADMIN_TOKEN"
          className="w-full px-3 py-2 text-xs font-mono bg-gray-900 border border-gray-700 rounded
                     text-gray-100 placeholder-gray-600 focus:outline-none focus:border-gray-500"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="w-full px-3 py-2 text-xs rounded bg-gray-700 text-gray-100
                     hover:bg-gray-600 disabled:opacity-40 disabled:hover:bg-gray-700 transition-colors"
        >
          {busy ? 'Sprawdzam…' : 'Wejdź'}
        </button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------ szczegoly */

function Expanded({
  id,
  onStatusChange,
}: {
  id: number
  onStatusChange: (id: number, status: Status) => void
}) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [notes, setNotes] = useState('')
  const [saved, setSaved] = useState(false)
  const [logError, setLogError] = useState('')

  useEffect(() => {
    let alive = true
    fetch(`/api/feedback/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Detail | null) => {
        if (!alive || !d) return
        setDetail(d)
        setNotes(d.notes ?? '')
      })
    return () => {
      alive = false
    }
  }, [id])

  async function saveNotes() {
    const res = await fetch(`/api/feedback/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }

  async function openLog() {
    setLogError('')
    const res = await fetch(`/api/feedback/${id}/log`)
    if (!res.ok) {
      setLogError(
        res.status === 404 ? 'Log nie dotarł na serwer.' : 'Nie udało się pobrać logu.'
      )
      return
    }
    const { url } = await res.json()
    window.open(url, '_blank', 'noopener')
  }

  if (!detail) {
    return <div className="px-4 py-3 text-xs text-gray-500">Wczytuję…</div>
  }

  return (
    <div className="px-4 py-3 space-y-3 bg-gray-900/40 border-t border-gray-800">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Opis</div>
        <p className="text-xs text-gray-200 whitespace-pre-wrap leading-relaxed">
          {detail.description}
        </p>
      </div>

      {detail.context && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Kontekst</div>
          <p className="text-xs font-mono text-gray-400 break-all">{detail.context}</p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-[11px]">
        <Meta label="Wersja add-inu" value={detail.addin_version} />
        <Meta label="Zegar klienta" value={detail.client_created_at ? formatDate(detail.client_created_at) : null} />
        <Meta label="IP" value={detail.client_ip} />
        <Meta label="Log" value={detail.log_path ? detail.log_path.split('/').pop()! : 'brak'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => onStatusChange(id, s.value)}
            className={`px-2 py-1 text-[11px] rounded border transition-colors ${
              detail.status === s.value
                ? STATUS_STYLE[s.value]
                : 'border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
            }`}
          >
            {s.label}
          </button>
        ))}

        {detail.log_path && (
          <button
            onClick={openLog}
            className="px-2 py-1 text-[11px] rounded border border-gray-700 text-gray-300
                       hover:border-gray-500 hover:text-gray-100 transition-colors"
          >
            Pobierz log
          </button>
        )}
        {logError && <span className="text-[11px] text-red-400">{logError}</span>}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Notatki</div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          rows={2}
          placeholder="Notatka własna — zapisuje się po wyjściu z pola"
          className="w-full px-2 py-1.5 text-xs bg-gray-900 border border-gray-700 rounded
                     text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-y"
        />
        {saved && <span className="text-[11px] text-emerald-400">zapisano</span>}
      </div>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-gray-300 font-mono break-all">{value ?? '—'}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ lista */

export default function FeedbackAdmin() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [items, setItems] = useState<ListItem[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<string>('new')
  const [kind, setKind] = useState<string>('all')
  const [user, setUser] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/api/feedback/session')
      .then((r) => r.json())
      .then((d) => setAuthed(!!d.authenticated))
      .catch(() => setAuthed(false))
  }, [])

  // Bump, zeby wymusic ponowne pobranie tej samej listy (przycisk Odswiez,
  // powrot po zmianie statusu).
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!authed) return
    let alive = true

    const params = new URLSearchParams({ status, kind, limit: '100' })
    if (user.trim()) params.set('user', user.trim())

    fetch(`/api/feedback?${params}`)
      .then(async (res) => {
        if (!alive) return
        if (res.status === 401) {
          setAuthed(false)
          return
        }
        if (!res.ok) return
        const d = await res.json()
        if (!alive) return
        setItems(d.items)
        setTotal(d.total)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => {
      alive = false
    }
  }, [authed, status, kind, user, reload])

  /** Wywolywane z handlerow zdarzen, wiec setState jest tu dozwolone. */
  function refresh() {
    setLoading(true)
    setReload((n) => n + 1)
  }

  async function changeStatus(id: number, next: Status) {
    const res = await fetch(`/api/feedback/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
    if (!res.ok) return
    // Zgloszenie moglo wypasc z aktywnego filtra — przeladowujemy liste.
    if (status !== 'all' && next !== status) {
      setExpanded(null)
      refresh()
    } else {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, status: next } : it)))
    }
  }

  async function logout() {
    await fetch('/api/feedback/session', { method: 'DELETE' })
    setAuthed(false)
    setItems([])
  }

  if (authed === null) {
    return <div className="p-6 text-xs text-gray-500">Sprawdzam sesję…</div>
  }
  if (!authed) {
    return <TokenGate onAuthenticated={() => setAuthed(true)} />
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-gray-800 shrink-0 flex flex-wrap items-center gap-2">
        <Select value={status} onChange={(v) => { setLoading(true); setStatus(v) }} options={[['new', 'Nowe'], ['in_progress', 'W toku'], ['done', 'Zrobione'], ['wontfix', 'Odrzucone'], ['all', 'Wszystkie']]} />
        <Select value={kind} onChange={(v) => { setLoading(true); setKind(v) }} options={[['all', 'Każdy rodzaj'], ['Blad', 'Błąd'], ['Sugestia', 'Sugestia'], ['Pytanie', 'Pytanie']]} />
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="użytkownik"
          className="px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200
                     placeholder-gray-600 focus:outline-none focus:border-gray-500 w-32"
        />
        <button
          onClick={refresh}
          className="px-2 py-1 text-xs rounded border border-gray-700 text-gray-400
                     hover:text-gray-200 hover:border-gray-600 transition-colors"
        >
          Odśwież
        </button>
        <span className="text-xs text-gray-500 ml-auto">
          {loading ? 'wczytuję…' : `${items.length} z ${total}`}
        </span>
        <button
          onClick={logout}
          className="px-2 py-1 text-xs rounded border border-gray-800 text-gray-600
                     hover:text-gray-300 hover:border-gray-600 transition-colors"
        >
          Wyloguj
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 && !loading && (
          <div className="p-6 text-xs text-gray-500">Brak zgłoszeń dla tego filtra.</div>
        )}
        {items.map((it) => (
          <div key={it.id} className="border-b border-gray-800/60">
            <button
              onClick={() => setExpanded(expanded === it.id ? null : it.id)}
              className="w-full px-4 py-2 flex items-center gap-3 text-left hover:bg-gray-900/50 transition-colors"
            >
              <span className="text-[11px] font-mono text-gray-600 w-10 shrink-0">#{it.id}</span>
              <span className="text-[11px] font-mono text-gray-500 w-28 shrink-0 hidden sm:block">
                {formatDate(it.created_at)}
              </span>
              <span
                className={`px-1.5 py-0.5 text-[10px] rounded border shrink-0 ${
                  KIND_STYLE[it.kind] ?? 'border-gray-700 text-gray-400'
                }`}
              >
                {it.kind}
              </span>
              <span className="text-[11px] text-gray-400 w-24 shrink-0 truncate hidden md:block">
                {it.user_name ?? '—'}
              </span>
              <span className="text-xs text-gray-300 truncate flex-1 min-w-0">
                {it.snippet}
                {it.truncated && '…'}
              </span>
              {it.log_path && <span className="text-[10px] text-gray-600 shrink-0">LOG</span>}
              <span
                className={`px-1.5 py-0.5 text-[10px] rounded border shrink-0 ${STATUS_STYLE[it.status]}`}
              >
                {STATUSES.find((s) => s.value === it.status)?.label ?? it.status}
              </span>
            </button>
            {expanded === it.id && <Expanded id={it.id} onStatusChange={changeStatus} />}
          </div>
        ))}
      </div>
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: Array<[string, string]>
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-200
                 focus:outline-none focus:border-gray-500"
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  )
}
