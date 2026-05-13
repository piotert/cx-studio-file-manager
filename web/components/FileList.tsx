'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import JsonViewer from './JsonViewer'
import GltfViewer from './GltfViewer'
import {
  DEFAULT_SETTINGS, PRESETS,
  type CameraLink, type CameraState, type ViewerSettings,
} from './GltfViewer'

// ── Constants ─────────────────────────────────────────────────────────────────

const SLOT_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const SLOT_COLORS = [
  { active: 'bg-blue-600',   dim: 'bg-blue-950/50',  border: 'border-blue-900',  text: 'text-blue-400'   },
  { active: 'bg-purple-600', dim: 'bg-purple-950/50', border: 'border-purple-900', text: 'text-purple-400' },
  { active: 'bg-emerald-600',dim: 'bg-emerald-950/50',border: 'border-emerald-900',text: 'text-emerald-400'},
  { active: 'bg-orange-600', dim: 'bg-orange-950/50', border: 'border-orange-900', text: 'text-orange-400' },
  { active: 'bg-red-600',    dim: 'bg-red-950/50',    border: 'border-red-900',    text: 'text-red-400'    },
  { active: 'bg-cyan-600',   dim: 'bg-cyan-950/50',   border: 'border-cyan-900',   text: 'text-cyan-400'   },
  { active: 'bg-pink-600',   dim: 'bg-pink-950/50',   border: 'border-pink-900',   text: 'text-pink-400'   },
  { active: 'bg-yellow-600', dim: 'bg-yellow-950/50', border: 'border-yellow-900', text: 'text-yellow-400' },
]

type LayoutMode = 'horizontal' | 'vertical' | 'grid'

type FileItem = {
  name: string
  url: string
  type: 'json' | 'gltf' | 'other'
  size: number | null
  createdAt: string | null
}

function displayName(name: string): string {
  return name.replace(/^\d+_/, '')
}

function gridCols(n: number): number {
  return Math.ceil(Math.sqrt(n))
}

// ── Snapshot helper ────────────────────────────────────────────────────────────

async function snapshotContainer(el: HTMLElement): Promise<void> {
  const canvas = el.querySelector('canvas')
  if (!canvas) return
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) return
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch {
    // fallback: download
    const url = URL.createObjectURL(blob)
    const a   = document.createElement('a')
    a.href = url; a.download = 'snapshot.png'; a.click()
    URL.revokeObjectURL(url)
  }
}

async function snapshotGrid(container: HTMLElement | null): Promise<void> {
  if (!container) return
  const canvases = Array.from(container.querySelectorAll('canvas')) as HTMLCanvasElement[]
  if (canvases.length === 0) return
  if (canvases.length === 1) {
    const blob = await new Promise<Blob | null>((res) => canvases[0].toBlob(res, 'image/png'))
    if (!blob) return
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) }
    catch {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = 'snapshot.png'; a.click()
      URL.revokeObjectURL(url)
    }
    return
  }
  // Composite all canvases into one
  const w   = canvases[0].width
  const h   = canvases[0].height
  const cols = Math.ceil(Math.sqrt(canvases.length))
  const rows = Math.ceil(canvases.length / cols)
  const out  = document.createElement('canvas')
  out.width  = w * cols
  out.height = h * rows
  const ctx  = out.getContext('2d')!
  canvases.forEach((cv, i) => {
    ctx.drawImage(cv, (i % cols) * w, Math.floor(i / cols) * h, w, h)
  })
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'))
  if (!blob) return
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) }
  catch {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'snapshot-grid.png'; a.click()
    URL.revokeObjectURL(url)
  }
}

// ── FileViewer ────────────────────────────────────────────────────────────────

function FileViewer({
  file,
  cameraLink,
  settings,
}: {
  file: FileItem | null
  cameraLink?: CameraLink
  settings: ViewerSettings
}) {
  if (!file) return <p className="text-gray-500 p-4 text-sm">Select a file to preview.</p>
  const name = displayName(file.name)
  if (file.type === 'json')
    return <JsonViewer url={file.url} cameraLink={cameraLink} settings={settings} fileName={name} />
  if (file.type === 'gltf')
    return <GltfViewer url={file.url} cameraLink={cameraLink} settings={settings} fileName={name} />
  return <p className="text-gray-400 p-4 text-sm">Unsupported file type.</p>
}

// ── ViewerToolbar ─────────────────────────────────────────────────────────────

function ViewerToolbar({
  settings,
  onSettings,
  activePreset,
  onPreset,
  compareMode,
  cameraLock,
  onToggleLock,
  layoutMode,
  onLayout,
  compareCount,
  onCompareCount,
  onSnapshotAll,
}: {
  settings: ViewerSettings
  onSettings: (p: Partial<ViewerSettings>) => void
  activePreset: number | null
  onPreset: (i: number) => void
  compareMode: boolean
  cameraLock: boolean
  onToggleLock: () => void
  layoutMode: LayoutMode
  onLayout: (m: LayoutMode) => void
  compareCount: number
  onCompareCount: (n: number) => void
  onSnapshotAll: () => void
}) {
  return (
    <div className="flex gap-1 flex-wrap items-center px-2 py-1.5 shrink-0 bg-gray-900 border-b border-gray-800">

      {/* Body */}
      <button
        onClick={() => onSettings({ showBody: !settings.showBody })}
        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
          settings.showBody ? 'bg-gray-600 text-white' : 'bg-gray-700 text-gray-400 line-through hover:bg-gray-600'
        }`}
        title="[B] Body"
      >Body</button>

      {/* RGB */}
      <button
        onClick={() => onSettings({ showRgb: !settings.showRgb })}
        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
          settings.showRgb ? 'bg-pink-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
        }`}
        title="[R] Normal-map RGB shader"
      >RGB</button>

      <div className="border-l border-gray-700 self-stretch" />

      {/* Edges */}
      <div className="flex items-center">
        <button
          onClick={() => onSettings({ showEdges: !settings.showEdges })}
          className={`px-2.5 py-1 rounded-l text-xs font-medium transition-colors ${
            settings.showEdges ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
          title="[E] Edges"
        >Edges</button>
        <input
          type="color" value={settings.edgesColor}
          onChange={(e) => onSettings({ edgesColor: e.target.value })}
          className="h-6 w-6 rounded-r cursor-pointer p-0.5 bg-gray-700 border-0"
          title="Edges color"
        />
      </div>

      {/* Mesh */}
      <div className="flex items-center">
        <button
          onClick={() => onSettings({ showMesh: !settings.showMesh })}
          className={`px-2.5 py-1 rounded-l text-xs font-medium transition-colors ${
            settings.showMesh ? 'bg-cyan-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
          title="[M] Wireframe mesh"
        >Mesh</button>
        <input
          type="color" value={settings.meshColor}
          onChange={(e) => onSettings({ meshColor: e.target.value })}
          className="h-6 w-6 rounded-r cursor-pointer p-0.5 bg-gray-700 border-0"
          title="Mesh color"
        />
      </div>

      {/* Line width */}
      <div className="flex items-center gap-1">
        <span className="text-xs text-gray-500">W</span>
        <input
          type="range" min="1" max="6" step="0.5"
          value={settings.lineWidth}
          onChange={(e) => onSettings({ lineWidth: Number(e.target.value) })}
          className="w-16 accent-blue-500"
          title={`Line width: ${settings.lineWidth}px`}
        />
        <span className="text-xs text-gray-500 w-4">{settings.lineWidth}</span>
      </div>

      <div className="border-l border-gray-700 self-stretch" />

      {/* Presets */}
      {PRESETS.map((p, i) => (
        <button
          key={p.name}
          onClick={() => onPreset(i)}
          className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
            activePreset === i ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
          title={`Preset: ${p.name} — [/] cycle`}
        >{p.name}</button>
      ))}

      {compareMode && <>
        <div className="border-l border-gray-700 self-stretch" />

        {/* Camera lock */}
        <button
          onClick={onToggleLock}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            cameraLock ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
          title="[L] Lock cameras"
        >{cameraLock ? '🔒' : '🔓'}</button>

        {/* Layout */}
        {(['horizontal', 'vertical', 'grid'] as LayoutMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onLayout(m)}
            className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
              layoutMode === m ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title={`[${m[0].toUpperCase()}] Layout: ${m}`}
          >
            {m === 'horizontal' ? '⬛⬛' : m === 'vertical' ? '⬜\n⬜' : '⊞'}
          </button>
        ))}

        {/* Slot count */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-500">Slots</span>
          {[2, 3, 4, 5, 6, 7, 8].map((n) => (
            <button
              key={n}
              onClick={() => onCompareCount(n)}
              className={`w-5 h-5 rounded text-xs font-bold transition-colors ${
                compareCount === n ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >{n}</button>
          ))}
        </div>
      </>}

      <div className="border-l border-gray-700 self-stretch" />

      {/* Snapshot all */}
      <button
        onClick={onSnapshotAll}
        className="px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
        title="[S] Snapshot to clipboard (all panels in compare, single view otherwise)"
      >📷</button>
    </div>
  )
}

// ── Keyboard help ─────────────────────────────────────────────────────────────

const KEYBINDS = [
  ['B', 'Toggle body'],
  ['E', 'Toggle edges'],
  ['M', 'Toggle wireframe mesh'],
  ['R', 'Toggle normals (RGB)'],
  ['C', 'Toggle compare mode'],
  ['L', 'Lock / unlock cameras (compare)'],
  ['H', 'Horizontal layout (compare)'],
  ['V', 'Vertical layout (compare)'],
  ['G', 'Grid layout (compare)'],
  ['1–8', 'Select active slot (compare)'],
  ['[ ]', 'Cycle presets backward / forward'],
  ['S', 'Snapshot all panels to clipboard'],
  ['P', 'Snapshot active panel to clipboard'],
  ['?', 'Show / hide this help'],
  ['Esc', 'Close sidebar'],
]

function KeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 w-72 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold text-gray-200">Keyboard shortcuts</span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-sm">✕</button>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {KEYBINDS.map(([k, desc]) => (
              <tr key={k} className="border-t border-gray-800">
                <td className="py-1 pr-3 font-mono text-yellow-400 whitespace-nowrap">{k}</td>
                <td className="py-1 text-gray-300">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── FileList (main) ───────────────────────────────────────────────────────────

export default function FileList() {
  const [files, setFiles]     = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const [compareMode, setCompareMode] = useState(false)
  const [compareCount, setCompareCount] = useState(2)
  const [slots, setSlots]     = useState<(FileItem | null)[]>(Array(8).fill(null))
  const [activeSlot, setActiveSlot] = useState(0)
  const [selectedSingle, setSelectedSingle] = useState<FileItem | null>(null)

  const [cameraLock, setCameraLock] = useState(false)
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('horizontal')
  const [settings, setSettings]     = useState<ViewerSettings>(DEFAULT_SETTINGS)
  const [activePreset, setActivePreset] = useState<number | null>(null)
  const [showKeyHelp, setShowKeyHelp]   = useState(false)

  // Grid container ref for whole-grid snapshot
  const gridRef = useRef<HTMLDivElement>(null)
  // Per-slot panel refs for single-panel snapshot
  const panelRefs = useRef<(HTMLDivElement | null)[]>(Array(8).fill(null))

  // Shared camera state
  const sharedCam = useRef<CameraState>({
    px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    tx: 0, ty: 0, tz: 0, version: -1, masterId: '',
  })
  // Stable camera links for each slot
  const camLinks = useRef<CameraLink[]>(
    Array.from({ length: 8 }, (_, i) => ({ state: sharedCam, id: SLOT_LABELS[i] }))
  )

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) setSidebarOpen(true)
  }, [])

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => setError('Failed to load files'))
      .finally(() => setLoading(false))
  }, [])

  const patchSettings = useCallback((patch: Partial<ViewerSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    setActivePreset(null)
  }, [])

  const applyPreset = useCallback((idx: number) => {
    const p = PRESETS[idx]
    setSettings({
      showBody: p.showBody, showEdges: p.showEdges, showMesh: p.showMesh,
      showRgb: p.showRgb, edgesColor: p.edgesColor, meshColor: p.meshColor,
      lineWidth: p.lineWidth, bgColor: p.bgColor,
    })
    setActivePreset(idx)
  }, [])

  function handleSelect(f: FileItem) {
    if (compareMode) {
      setSlots((prev) => {
        const next = [...prev]
        next[activeSlot] = f
        return next
      })
      setActiveSlot((prev) => (prev + 1) % compareCount)
    } else {
      setSelectedSingle(f)
    }
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false)
  }

  function toggleCompare() {
    if (compareMode) {
      setCompareMode(false)
      setSlots(Array(8).fill(null))
      setActiveSlot(0)
      setCameraLock(false)
    } else {
      setCompareMode(true)
      setActiveSlot(0)
    }
  }

  function toggleLock() {
    if (cameraLock) {
      sharedCam.current.version  = -1
      sharedCam.current.masterId = ''
      setCameraLock(false)
    } else {
      setCameraLock(true)
    }
  }

  function handleCompareCount(n: number) {
    setCompareCount(n)
    setSlots((prev) => {
      const next = [...prev]
      for (let i = n; i < 8; i++) next[i] = null
      return next
    })
    setActiveSlot((prev) => Math.min(prev, n - 1))
  }

  const snapshotSingleSlot = useCallback((slotIdx: number) => {
    const el = panelRefs.current[slotIdx]
    if (el) snapshotContainer(el)
  }, [])

  const snapshotAll = useCallback(() => {
    snapshotGrid(gridRef.current)
  }, [])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      switch (e.key) {
        case 'b': case 'B': setSettings((p) => ({ ...p, showBody:  !p.showBody  })); setActivePreset(null); break
        case 'e': case 'E': setSettings((p) => ({ ...p, showEdges: !p.showEdges })); setActivePreset(null); break
        case 'm': case 'M': setSettings((p) => ({ ...p, showMesh:  !p.showMesh  })); setActivePreset(null); break
        case 'r': case 'R': setSettings((p) => ({ ...p, showRgb:   !p.showRgb   })); setActivePreset(null); break
        case 'c': case 'C': toggleCompare(); break
        case 'l': case 'L': if (compareMode) toggleLock(); break
        case 'h': case 'H': if (compareMode) setLayoutMode('horizontal'); break
        case 'v': case 'V': if (compareMode) setLayoutMode('vertical'); break
        case 'g': case 'G': if (compareMode) setLayoutMode('grid'); break
        case 's': case 'S':
          if (compareMode) snapshotAll(); else snapshotSingleSlot(0)
          break
        case 'p': case 'P': snapshotSingleSlot(compareMode ? activeSlot : 0); break
        case '[':
          setActivePreset((prev) => {
            const next = Math.max(0, (prev ?? 0) - 1)
            applyPreset(next)
            return next
          })
          break
        case ']':
          setActivePreset((prev) => {
            const next = Math.min(PRESETS.length - 1, (prev ?? -1) + 1)
            applyPreset(next)
            return next
          })
          break
        case '?': setShowKeyHelp((h) => !h); break
        case 'Escape': setSidebarOpen(false); setShowKeyHelp(false); break
        case '1': case '2': case '3': case '4':
        case '5': case '6': case '7': case '8': {
          const idx = parseInt(e.key) - 1
          if (compareMode && idx < compareCount) setActiveSlot(idx)
          break
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareMode, cameraLock, compareCount, activeSlot, snapshotAll, snapshotSingleSlot, applyPreset])

  // ── Grid layout style ─────────────────────────────────────────────────────
  function gridStyle(): CSSProperties {
    const n = compareCount
    if (layoutMode === 'vertical')    return { display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: `repeat(${n}, 1fr)` }
    if (layoutMode === 'horizontal')  return { display: 'grid', gridTemplateColumns: `repeat(${n}, 1fr)` }
    const cols = gridCols(n)
    return { display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)` }
  }

  const activeSlots = slots.slice(0, compareCount)

  return (
    <div className="h-full flex flex-col overflow-hidden relative">

      {showKeyHelp && <KeyHelp onClose={() => setShowKeyHelp(false)} />}

      {/* ── Top toolbar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <button
          onClick={() => setSidebarOpen((o) => !o)}
          className="text-gray-400 hover:text-gray-100 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-700 text-base shrink-0"
          title="Toggle file list"
        >☰</button>

        <span className="flex-1 text-xs text-gray-500 truncate min-w-0">
          {compareMode
            ? `Slot ${SLOT_LABELS[activeSlot]} — click a file`
            : selectedSingle ? displayName(selectedSingle.name) : ''}
        </span>

        <button
          onClick={() => setShowKeyHelp((h) => !h)}
          className="text-gray-500 hover:text-gray-200 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 text-sm shrink-0"
          title="Keyboard shortcuts (?)"
        >?</button>

        <button
          onClick={toggleCompare}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors shrink-0 ${
            compareMode ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
          title="[C] Compare mode"
        >Compare</button>
      </div>

      {/* ── Viewer settings toolbar ───────────────────────────────────────── */}
      <ViewerToolbar
        settings={settings}
        onSettings={patchSettings}
        activePreset={activePreset}
        onPreset={applyPreset}
        compareMode={compareMode}
        cameraLock={cameraLock}
        onToggleLock={toggleLock}
        layoutMode={layoutMode}
        onLayout={setLayoutMode}
        compareCount={compareCount}
        onCompareCount={handleCompareCount}
        onSnapshotAll={snapshotAll}
      />

      {/* ── Main area ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative flex overflow-hidden">

        {/* Backdrop — mobile only */}
        {sidebarOpen && (
          <div
            className="md:hidden absolute inset-0 bg-black/60 z-10"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="
            absolute md:static z-20 md:z-auto
            top-0 left-0 bottom-0
            w-72 md:w-52 shrink-0
            bg-gray-900 border-r border-gray-800
            flex flex-col overflow-hidden
          ">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Files</span>
              <button
                onClick={() => setSidebarOpen(false)}
                className="md:hidden text-gray-500 hover:text-gray-200 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700"
              >✕</button>
            </div>

            {/* Compare slot selector */}
            {compareMode && (
              <div className="flex flex-wrap gap-1 px-2 py-2 border-b border-gray-800 shrink-0">
                {Array.from({ length: compareCount }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveSlot(i)}
                    className={`flex-1 min-w-[2rem] py-1 rounded text-xs font-bold transition-colors ${
                      activeSlot === i
                        ? SLOT_COLORS[i].active + ' text-white'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }`}
                    title={`Slot ${SLOT_LABELS[i]} [key ${i + 1}]`}
                  >
                    {SLOT_LABELS[i]}{slots[i] ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            )}

            <ul className="flex-1 overflow-y-auto p-2 space-y-1">
              {loading && <li className="text-gray-400 text-sm p-2">Loading…</li>}
              {error   && <li className="text-red-400 text-sm p-2">{error}</li>}
              {!loading && !error && files.length === 0 && (
                <li className="text-gray-400 text-sm p-2">No files uploaded yet.</li>
              )}
              {files.map((f) => {
                const singleActive = !compareMode && selectedSingle?.name === f.name
                const slotIdx      = compareMode ? slots.slice(0, compareCount).findIndex((s) => s?.name === f.name) : -1
                return (
                  <li key={f.name}>
                    <button
                      onClick={() => handleSelect(f)}
                      title={displayName(f.name)}
                      className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                        singleActive ? 'bg-blue-600 text-white'
                          : slotIdx >= 0 ? SLOT_COLORS[slotIdx].active + ' text-white'
                          : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="opacity-60 shrink-0 text-xs font-mono">
                          {f.type === 'json' ? '{}' : f.type === 'gltf' ? '3D' : '—'}
                        </span>
                        <span className="truncate min-w-0">{displayName(f.name)}</span>
                        {slotIdx >= 0 && (
                          <span className="ml-auto shrink-0 text-xs font-bold opacity-90">
                            {SLOT_LABELS[slotIdx]}
                          </span>
                        )}
                        {singleActive && (
                          <span className="ml-auto shrink-0 text-xs font-bold opacity-80">▶</span>
                        )}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </aside>
        )}

        {/* ── Viewer area ───────────────────────────────────────────────── */}
        {compareMode ? (
          <div ref={gridRef} className="flex-1 min-w-0 min-h-0 overflow-hidden" style={gridStyle()}>
            {activeSlots.map((file, i) => {
              const col = SLOT_COLORS[i]
              return (
                <div
                  key={i}
                  ref={(el: HTMLDivElement | null) => { panelRefs.current[i] = el }}
                  className={`min-h-0 min-w-0 flex flex-col border border-gray-800 relative overflow-hidden`}
                >
                  {/* Panel header */}
                  <div className={`px-2 py-0.5 ${col.dim} border-b ${col.border} shrink-0 flex items-center gap-1.5 min-w-0`}>
                    <span className={`text-xs font-bold ${col.text} shrink-0`}>{SLOT_LABELS[i]}</span>
                    <span className="text-xs text-gray-500 truncate min-w-0">
                      {file ? displayName(file.name) : 'empty'}
                    </span>
                    <button
                      onClick={() => snapshotSingleSlot(i)}
                      className="ml-auto shrink-0 text-gray-600 hover:text-gray-300 text-xs"
                      title="Snapshot this panel [P on active slot]"
                    >📷</button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <FileViewer
                      file={file}
                      cameraLink={cameraLock ? camLinks.current[i] : undefined}
                      settings={settings}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div
            ref={(el: HTMLDivElement | null) => { panelRefs.current[0] = el }}
            className="flex-1 min-h-0 min-w-0 overflow-hidden"
          >
            <FileViewer file={selectedSingle} settings={settings} />
          </div>
        )}
      </div>
    </div>
  )
}
