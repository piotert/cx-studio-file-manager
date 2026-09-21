'use client'

import { useCallback, useEffect, useState } from 'react'

/* ------------------------------------------------------------ typy */

type Release = {
  version: string
  sha256: string | null
  sizeBytes: number | null
  notes: string | null
  publishedAt: string | null
}

type Current = { version: string | null; mandatory: boolean }

const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/

/* ------------------------------------------------------------ pomocnicze */

function formatSize(bytes: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(2)} MB`
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' })
}

/** SHA-256 pliku w przegladarce - do porownania z tym, co policzyl serwer. */
async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** "SWAddIn_CX-0.2.9760.18107.zip" -> "0.2.9760.18107"; inaczej "". */
function versionFromFileName(name: string): string {
  const m = name.match(/(\d+\.\d+\.\d+(?:\.\d+)?)\.zip$/i)
  return m ? m[1] : ''
}

async function readError(res: Response): Promise<string> {
  try {
    const j = await res.json()
    return j?.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/* ------------------------------------------------------------ brama */

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
        <h1 className="text-sm font-semibold text-gray-200">Wydania — dostęp</h1>
        <p className="text-xs text-gray-500 leading-relaxed">
          Ten sam token administratora co w Zgłoszeniach. Zapisze się w ciasteczku httpOnly.
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

/* ------------------------------------------------------------ formularz publikacji */

type Step = 'idle' | 'hash' | 'announce' | 'upload' | 'finalize' | 'done' | 'error'

const STEP_LABEL: Record<Step, string> = {
  idle: '',
  hash: 'Liczę SHA-256 lokalnie…',
  announce: 'Zapowiadam wersję…',
  upload: 'Wysyłam paczkę do Storage…',
  finalize: 'Finalizuję (serwer liczy SHA-256)…',
  done: 'Opublikowano.',
  error: 'Błąd.',
}

function UploadForm({ onPublished }: { onPublished: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [promote, setPromote] = useState(true)
  const [mandatory, setMandatory] = useState(false)
  const [step, setStep] = useState<Step>('idle')
  const [message, setMessage] = useState('')

  const busy = step !== 'idle' && step !== 'done' && step !== 'error'
  const versionOk = VERSION_RE.test(version.trim())

  function pickFile(f: File | null) {
    setFile(f)
    setStep('idle')
    setMessage('')
    if (f && !version) setVersion(versionFromFileName(f.name))
  }

  async function publish(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !versionOk) return
    const v = version.trim()
    setMessage('')

    try {
      // 0. hash lokalnie - do porownania z wynikiem finalize (tak jak publish-release.ps1)
      setStep('hash')
      const localHash = await sha256Hex(file)

      // 1. zapowiedz
      setStep('announce')
      const ann = await fetch('/api/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v, notes }),
      })
      if (!ann.ok) throw new Error(`Zapowiedź: ${await readError(ann)}`)
      const { upload } = (await ann.json()) as { upload: { url: string } }

      // 2. upload - najpierw prosto do Storage (bez Authorization, poswiadczenie w URL);
      //    gdy przegladarka nie moze (CORS/siec) - przez nasz serwer, do 4 MB
      setStep('upload')
      let direct = false
      try {
        const put = await fetch(upload.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })
        if (!put.ok) throw new Error(`Storage odpowiedział ${put.status}`)
        direct = true
      } catch (err) {
        if (file.size > 4 * 1024 * 1024) {
          throw new Error(
            `Bezpośredni upload nie zadziałał (${(err as Error).message}), a paczka ma ${formatSize(file.size)} — ` +
              `zapasowa droga przez serwer przyjmuje do 4 MB. Użyj publish-release.ps1.`
          )
        }
        const proxied = await fetch(`/api/releases/${v}/upload`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        })
        if (!proxied.ok) throw new Error(`Upload przez serwer: ${await readError(proxied)}`)
      }

      // 3. finalize (+ promote)
      setStep('finalize')
      const fin = await fetch(`/api/releases/${v}/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promote, mandatory: promote && mandatory }),
      })
      if (!fin.ok) throw new Error(`Finalizacja: ${await readError(fin)}`)
      const result = (await fin.json()) as {
        version: string
        sha256: string
        sizeBytes: number
        removed: string[]
        promoted?: boolean
      }

      if (result.sha256 !== localHash) {
        throw new Error(`NIEZGODNY HASH — serwer ${result.sha256.slice(0, 12)}…, lokalnie ${localHash.slice(0, 12)}…`)
      }

      setStep('done')
      setMessage(
        `${result.version} · ${formatSize(result.sizeBytes)} · SHA-256 zgodny` +
          (direct ? '' : ' · upload przez serwer') +
          (result.promoted ? ' · /api/update wskazuje tę wersję' : ' · /api/update bez zmian') +
          (result.removed.length ? ` · usunięte: ${result.removed.join(', ')}` : '')
      )
      setFile(null)
      setVersion('')
      setNotes('')
      onPublished()
    } catch (err) {
      setStep('error')
      setMessage((err as Error).message)
    }
  }

  const input =
    'w-full px-3 py-2 text-xs bg-gray-900 border border-gray-700 rounded text-gray-100 ' +
    'placeholder-gray-600 focus:outline-none focus:border-gray-500 disabled:opacity-50'

  return (
    <form onSubmit={publish} className="space-y-3 p-4 border border-gray-800 rounded bg-gray-900/40">
      <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Nowe wydanie</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] text-gray-500">Paczka ZIP</span>
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:text-xs
                       file:rounded file:border-0 file:bg-gray-700 file:text-gray-100 hover:file:bg-gray-600"
          />
          {file && <span className="text-[11px] text-gray-500">{file.name} · {formatSize(file.size)}</span>}
        </label>

        <label className="space-y-1">
          <span className="text-[11px] text-gray-500">
            Wersja <span className="text-gray-600">(AssemblyVersion add-inu, np. 0.2.9760.18107)</span>
          </span>
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            disabled={busy}
            placeholder="0.2.xxxx.xxxx"
            className={`${input} font-mono ${version && !versionOk ? 'border-red-700' : ''}`}
          />
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] text-gray-500">Notatki</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} className={input} />
      </label>

      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-300">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={promote} onChange={(e) => setPromote(e.target.checked)} disabled={busy} />
          Ustaw jako aktualną (/api/update)
        </label>
        <label className={`flex items-center gap-2 ${promote ? '' : 'opacity-40'}`}>
          <input
            type="checkbox"
            checked={mandatory}
            onChange={(e) => setMandatory(e.target.checked)}
            disabled={busy || !promote}
          />
          <span className="text-orange-300">Obowiązkowa</span>
          <span className="text-gray-600">— przerywa start SW oknem pobierania, przypomina co 5 min</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !file || !versionOk}
          className="px-4 py-2 text-xs rounded bg-gray-700 text-gray-100 hover:bg-gray-600
                     disabled:opacity-40 disabled:hover:bg-gray-700 transition-colors"
        >
          {busy ? STEP_LABEL[step] : 'Publikuj'}
        </button>
        {message && (
          <span className={`text-xs ${step === 'error' ? 'text-red-400' : 'text-green-400'}`}>{message}</span>
        )}
      </div>
    </form>
  )
}

/* ------------------------------------------------------------ lista wydan */

function ReleaseRow({
  r,
  current,
  onChanged,
}: {
  r: Release
  current: Current
  onChanged: () => void
}) {
  const isCurrent = current.version === r.version
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function promote(mandatory: boolean) {
    setBusy(true)
    setMsg('')
    const res = await fetch(`/api/releases/${r.version}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mandatory }),
    })
    setBusy(false)
    if (res.ok) onChanged()
    else setMsg(await readError(res))
  }

  async function remove() {
    if (!confirm(`Usunąć wydanie ${r.version}? Plik i wpis znikną.`)) return
    setBusy(true)
    setMsg('')
    const res = await fetch(`/api/releases/${r.version}`, { method: 'DELETE' })
    setBusy(false)
    if (res.status === 204) onChanged()
    else if (res.status === 409) setMsg('To wersja aktualna — najpierw ustaw inną.')
    else setMsg(await readError(res))
  }

  const btn =
    'px-2 py-1 text-[11px] rounded border border-gray-700 text-gray-300 hover:bg-gray-800 ' +
    'disabled:opacity-40 disabled:hover:bg-transparent transition-colors'

  return (
    <tr className={`border-t border-gray-800 ${isCurrent ? 'bg-green-950/20' : ''}`}>
      <td className="px-3 py-2 font-mono text-xs text-gray-100">
        {r.version}
        {isCurrent && (
          <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-green-900 text-green-200">
            aktualna{current.mandatory ? ' · obowiązkowa' : ''}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{formatSize(r.sizeBytes)}</td>
      <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{formatDate(r.publishedAt)}</td>
      <td className="px-3 py-2 text-xs text-gray-400 max-w-[18rem] truncate" title={r.notes ?? ''}>
        {r.notes || <span className="text-gray-700">—</span>}
      </td>
      <td className="px-3 py-2 font-mono text-[10px] text-gray-600" title={r.sha256 ?? ''}>
        {r.sha256 ? r.sha256.slice(0, 12) + '…' : '—'}
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5 justify-end">
          {!isCurrent && (
            <button className={btn} disabled={busy} onClick={() => promote(false)} title="Ustaw jako aktualną">
              Ustaw aktualną
            </button>
          )}
          {isCurrent && !current.mandatory && (
            <button className={btn} disabled={busy} onClick={() => promote(true)} title="Oznacz jako obowiązkową">
              Obowiązkowa
            </button>
          )}
          {isCurrent && current.mandatory && (
            <button className={btn} disabled={busy} onClick={() => promote(false)} title="Zdejmij obowiązkowość">
              Nieobowiązkowa
            </button>
          )}
          <button
            className={`${btn} ${isCurrent ? '' : 'hover:border-red-800 hover:text-red-300'}`}
            disabled={busy || isCurrent}
            onClick={remove}
            title={isCurrent ? 'Aktualnej nie da się usunąć' : 'Usuń wydanie'}
          >
            Usuń
          </button>
        </div>
        {msg && <div className="text-[11px] text-red-400 text-right mt-1">{msg}</div>}
      </td>
    </tr>
  )
}

/* ------------------------------------------------------------ strona */

export default function ReleasesAdmin() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [items, setItems] = useState<Release[]>([])
  const [current, setCurrent] = useState<Current>({ version: null, mandatory: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/feedback/session')
      .then((r) => r.json())
      .then((j) => setAuthed(!!j.authenticated))
      .catch(() => setAuthed(false))
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [list, upd] = await Promise.all([fetch('/api/releases'), fetch('/api/update')])
      if (!list.ok) throw new Error(`Lista: ${await readError(list)}`)
      const lj = (await list.json()) as { items: Release[] }
      const uj = upd.ok ? ((await upd.json()) as { version: string | null; mandatory: boolean }) : null
      setItems(lj.items ?? [])
      setCurrent({ version: uj?.version ?? null, mandatory: !!uj?.mandatory })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authed) void refresh()
  }, [authed, refresh])

  async function logout() {
    await fetch('/api/feedback/session', { method: 'DELETE' })
    setAuthed(false)
    setItems([])
  }

  if (authed === null) return <div className="p-6 text-xs text-gray-500">Sprawdzam sesję…</div>
  if (!authed) return <TokenGate onAuthenticated={() => setAuthed(true)} />

  const orphanCurrent = current.version && !items.some((r) => r.version === current.version)

  return (
    <div className="p-4 space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold text-gray-200">Wydania add-inu</h1>
          <p className="text-[11px] text-gray-500">
            Serwer trzyma najnowszą + 3 wstecz; aktualna nigdy nie jest usuwana.
            {' '}Aktualna: <span className="font-mono text-gray-300">{current.version ?? 'brak'}</span>
            {orphanCurrent && (
              <span className="text-orange-300"> — wskazuje wersję, której nie ma w magazynie; /api/update zgłasza brak aktualizacji.</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void refresh()} disabled={loading}
                  className="px-2 py-1 text-[11px] rounded border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40">
            {loading ? 'Odświeżam…' : 'Odśwież'}
          </button>
          <button onClick={logout} className="px-2 py-1 text-[11px] text-gray-500 hover:text-gray-300">Wyloguj</button>
        </div>
      </div>

      <UploadForm onPublished={() => void refresh()} />

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="border border-gray-800 rounded overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-gray-900/60 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Wersja</th>
              <th className="px-3 py-2 font-medium">Rozmiar</th>
              <th className="px-3 py-2 font-medium">Opublikowano</th>
              <th className="px-3 py-2 font-medium">Notatki</th>
              <th className="px-3 py-2 font-medium">SHA-256</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-gray-600">Magazyn pusty.</td></tr>
            )}
            {items.map((r) => (
              <ReleaseRow key={r.version} r={r} current={current} onChanged={() => void refresh()} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
