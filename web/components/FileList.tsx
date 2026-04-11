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
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<FileItem | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/files')
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? []))
      .catch(() => setError('Failed to load files'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-gray-400">Loading...</p>
  if (error) return <p className="text-red-400">{error}</p>
  if (files.length === 0) return <p className="text-gray-400">No files uploaded yet.</p>

  return (
    <div className="flex gap-6">
      <ul className="w-72 shrink-0 space-y-1">
        {files.map((f) => (
          <li key={f.name}>
            <button
              onClick={() => setSelected(f)}
              className={`w-full text-left px-3 py-2 rounded text-sm truncate transition-colors ${
                selected?.name === f.name
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-200'
              }`}
            >
              <span className="mr-2 opacity-60">{f.type === 'json' ? '{}' : f.type === 'gltf' ? '3D' : '—'}</span>
              {f.name}
            </button>
          </li>
        ))}
      </ul>

      <div className="flex-1 min-w-0">
        {selected ? (
          selected.type === 'json' ? (
            <JsonViewer url={selected.url} />
          ) : selected.type === 'gltf' ? (
            <GltfViewer url={selected.url} />
          ) : (
            <p className="text-gray-400">Unsupported file type.</p>
          )
        ) : (
          <p className="text-gray-500">Select a file to preview.</p>
        )}
      </div>
    </div>
  )
}
