'use client'

import { useEffect, useState } from 'react'
import JsonViewer from './JsonViewer'
import GltfViewer from './GltfViewer'

type FileItem = {
  name: string
  url: string
  type: 'json' | 'gltf' | 'other'
  size: number | null
  createdAt: string | null
}

export default function FileList() {
  const [files, setFiles]     = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<FileItem | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(true)

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => setError('Failed to load files'))
      .finally(() => setLoading(false))
  }, [])

  function selectFile(f: FileItem) {
    setSelected(f)
    if (typeof window !== 'undefined' && window.innerWidth < 768) setOpen(false)
  }

  return (
    <div className="h-full flex overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside
        className={`${
          open ? 'w-64' : 'w-0'
        } shrink-0 overflow-hidden transition-[width] duration-300 bg-gray-900 border-r border-gray-800 flex flex-col`}
      >
        {/* inner wrapper keeps width stable while animating */}
        <div className="w-64 h-full flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Files</span>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-500 hover:text-gray-200 text-xs px-1 py-0.5 rounded hover:bg-gray-700"
              title="Collapse"
            >
              ◀
            </button>
          </div>

          <ul className="flex-1 overflow-y-auto p-2 space-y-1">
            {loading && <li className="text-gray-400 text-sm p-2">Loading…</li>}
            {error   && <li className="text-red-400  text-sm p-2">{error}</li>}
            {!loading && !error && files.length === 0 && (
              <li className="text-gray-400 text-sm p-2">No files uploaded yet.</li>
            )}
            {files.map((f) => (
              <li key={f.name}>
                <button
                  onClick={() => selectFile(f)}
                  className={`w-full text-left px-3 py-2 rounded text-sm truncate transition-colors ${
                    selected?.name === f.name
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
                  }`}
                >
                  <span className="mr-2 opacity-60">
                    {f.type === 'json' ? '{}' : f.type === 'gltf' ? '3D' : '—'}
                  </span>
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* ── Open button (visible when sidebar is closed) ─────── */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="shrink-0 w-8 flex items-center justify-center bg-gray-900 hover:bg-gray-800 border-r border-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          title="Open file list"
        >
          ▶
        </button>
      )}

      {/* ── Viewer ───────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        {selected ? (
          selected.type === 'json' ? (
            <JsonViewer url={selected.url} />
          ) : selected.type === 'gltf' ? (
            <GltfViewer url={selected.url} />
          ) : (
            <p className="text-gray-400 p-4">Unsupported file type.</p>
          )
        ) : (
          <p className="text-gray-500 p-4">Select a file to preview.</p>
        )}
      </div>

    </div>
  )
}
