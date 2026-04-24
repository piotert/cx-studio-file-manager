'use client'

import { useEffect, useState } from 'react'
import ThreeJsonViewer, { type ThreeGeometryJson } from './ThreeJsonViewer'

function isThreeGeometryJson(data: unknown): data is ThreeGeometryJson {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  const meta = d.metadata as Record<string, unknown> | undefined
  return (
    typeof meta?.formatVersion === 'number' &&
    Array.isArray(d.vertices) &&
    Array.isArray(d.faces)
  )
}

type View = '3d' | 'text'

export default function JsonViewer({ url }: { url: string }) {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('3d')

  useEffect(() => {
    setData(null)
    setError(null)
    setView('3d')
    fetch(url)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError('Failed to load JSON'))
  }, [url])

  if (error) return <p className="text-red-400">{error}</p>
  if (!data) return <p className="text-gray-400">Loading...</p>

  if (isThreeGeometryJson(data)) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            onClick={() => setView('3d')}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              view === '3d'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            3D
          </button>
          <button
            onClick={() => setView('text')}
            className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
              view === 'text'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            JSON
          </button>
        </div>

        {view === '3d' ? (
          <ThreeJsonViewer data={data} />
        ) : (
          <pre className="bg-gray-900 rounded p-4 overflow-auto text-sm text-green-300 max-h-[70vh] whitespace-pre-wrap break-all">
            {JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  return (
    <pre className="bg-gray-900 rounded p-4 overflow-auto text-sm text-green-300 max-h-[70vh] whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
