'use client'

import { useEffect, useRef, useState } from 'react'
import JsonViewer from './JsonViewer'
import GltfViewer from './GltfViewer'
import type { CameraLink, CameraState } from './GltfViewer'

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

function FileViewer({ file, cameraLink }: { file: FileItem | null; cameraLink?: CameraLink }) {
  if (!file) return <p className="text-gray-500 p-4 text-sm">Select a file to preview.</p>
  if (file.type === 'json') return <JsonViewer url={file.url} cameraLink={cameraLink} />
  if (file.type === 'gltf') return <GltfViewer url={file.url} cameraLink={cameraLink} />
  return <p className="text-gray-400 p-4 text-sm">Unsupported file type.</p>
}

export default function FileList() {
  const [files, setFiles]     = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)
  const [compareMode, setCompareMode] = useState(false)
  const [cameraLock, setCameraLock]   = useState(false)
  const [selectedA, setSelectedA]     = useState<FileItem | null>(null)
  const [selectedB, setSelectedB]     = useState<FileItem | null>(null)
  const [activeSlot, setActiveSlot]   = useState<'A' | 'B'>('A')

  // Shared camera state — plain mutable object, no re-renders on update
  // version starts at -1 so neither viewer applies it on mount
  const sharedCam = useRef<CameraState>({
    px: 0, py: 0, pz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    tx: 0, ty: 0, tz: 0,
    version: -1,
    masterId: '',
  })

  // Stable link objects — created once, never recreated
  const camLinkA = useRef<CameraLink>({ state: sharedCam, id: 'A' })
  const camLinkB = useRef<CameraLink>({ state: sharedCam, id: 'B' })

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 768) setOpen(true)
  }, [])

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => setError('Failed to load files'))
      .finally(() => setLoading(false))
  }, [])

  function handleSelect(f: FileItem) {
    if (compareMode) {
      if (activeSlot === 'A') { setSelectedA(f); setActiveSlot('B') }
      else                    { setSelectedB(f); setActiveSlot('A') }
    } else {
      setSelectedA(f)
    }
    if (typeof window !== 'undefined' && window.innerWidth < 768) setOpen(false)
  }

  function toggleCompare() {
    if (compareMode) {
      setCompareMode(false); setSelectedB(null); setActiveSlot('A')
      setCameraLock(false)
    } else {
      setCompareMode(true); setActiveSlot('A')
    }
  }

  function toggleLock() {
    if (cameraLock) {
      // Reset version so cameras don't snap when re-locking later
      sharedCam.current.version = -1
      sharedCam.current.masterId = ''
      setCameraLock(false)
    } else {
      setCameraLock(true)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900 border-b border-gray-800 shrink-0">
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-gray-400 hover:text-gray-100 w-7 h-7 flex items-center justify-center rounded hover:bg-gray-700 text-base shrink-0"
          title="Toggle file list"
        >
          ☰
        </button>
        <span className="flex-1 text-xs text-gray-500 truncate min-w-0">
          {compareMode
            ? `Slot ${activeSlot} — click a file`
            : selectedA ? displayName(selectedA.name) : ''}
        </span>
        {compareMode && (
          <button
            onClick={toggleLock}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors shrink-0 ${
              cameraLock ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            title={cameraLock ? 'Unlock camera sync' : 'Lock cameras together'}
          >
            {cameraLock ? '🔒' : '🔓'}
          </button>
        )}
        <button
          onClick={toggleCompare}
          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors shrink-0 ${
            compareMode ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Compare
        </button>
      </div>

      {/* ── Main area ───────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative flex overflow-hidden">

        {/* Backdrop — mobile only */}
        {open && (
          <div
            className="md:hidden absolute inset-0 bg-black/60 z-10"
            onClick={() => setOpen(false)}
          />
        )}

        {/* Sidebar */}
        {open && (
          <aside className="
            absolute md:static z-20 md:z-auto
            top-0 left-0 bottom-0
            w-72 md:w-56 shrink-0
            bg-gray-900 border-r border-gray-800
            flex flex-col overflow-hidden
          ">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Files</span>
              <button
                onClick={() => setOpen(false)}
                className="md:hidden text-gray-500 hover:text-gray-200 w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700"
              >
                ✕
              </button>
            </div>

            {/* Compare slot selector */}
            {compareMode && (
              <div className="flex gap-1 px-2 py-2 border-b border-gray-800 shrink-0">
                <button
                  onClick={() => setActiveSlot('A')}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold transition-colors ${
                    activeSlot === 'A' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  A {selectedA ? '✓' : '—'}
                </button>
                <button
                  onClick={() => setActiveSlot('B')}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold transition-colors ${
                    activeSlot === 'B' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  B {selectedB ? '✓' : '—'}
                </button>
              </div>
            )}

            <ul className="flex-1 overflow-y-auto p-2 space-y-1">
              {loading && <li className="text-gray-400 text-sm p-2">Loading…</li>}
              {error   && <li className="text-red-400 text-sm p-2">{error}</li>}
              {!loading && !error && files.length === 0 && (
                <li className="text-gray-400 text-sm p-2">No files uploaded yet.</li>
              )}
              {files.map((f) => {
                const isA = selectedA?.name === f.name
                const isB = compareMode && selectedB?.name === f.name
                return (
                  <li key={f.name}>
                    <button
                      onClick={() => handleSelect(f)}
                      title={displayName(f.name)}
                      className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                        isA ? 'bg-blue-600 text-white'
                          : isB ? 'bg-purple-600 text-white'
                          : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="opacity-60 shrink-0 text-xs font-mono">
                          {f.type === 'json' ? '{}' : f.type === 'gltf' ? '3D' : '—'}
                        </span>
                        <span className="truncate min-w-0">{displayName(f.name)}</span>
                        {isA && <span className="ml-auto shrink-0 text-xs font-bold opacity-80">A</span>}
                        {isB && <span className="ml-auto shrink-0 text-xs font-bold opacity-80">B</span>}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </aside>
        )}

        {/* ── Viewer area ─────────────────────────────────────── */}
        <div className={`flex-1 min-w-0 min-h-0 flex overflow-hidden ${compareMode ? 'flex-col md:flex-row' : ''}`}>
          {compareMode ? (
            <>
              {/* Panel A */}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col border-b md:border-b-0 md:border-r border-gray-700">
                <div className="px-3 py-1 bg-blue-950/60 border-b border-blue-900 shrink-0 flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-blue-400 shrink-0">A</span>
                  <span className="text-xs text-gray-400 truncate min-w-0">
                    {selectedA ? displayName(selectedA.name) : 'no file selected'}
                  </span>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  <FileViewer file={selectedA} cameraLink={cameraLock ? camLinkA.current : undefined} />
                </div>
              </div>
              {/* Panel B */}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                <div className="px-3 py-1 bg-purple-950/60 border-b border-purple-900 shrink-0 flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-purple-400 shrink-0">B</span>
                  <span className="text-xs text-gray-400 truncate min-w-0">
                    {selectedB ? displayName(selectedB.name) : 'no file selected'}
                  </span>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  <FileViewer file={selectedB} cameraLink={cameraLock ? camLinkB.current : undefined} />
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <FileViewer file={selectedA} />
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
