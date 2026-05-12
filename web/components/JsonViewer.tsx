'use client'

import { useEffect, useState } from 'react'
import ThreeJsonViewer, { type ThreeGeometryJson } from './ThreeJsonViewer'
import type { CameraLink } from './GltfViewer'

function isThreeGeometryJson(data: unknown): data is ThreeGeometryJson {
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  if ('asset' in d || 'scenes' in d) return false
  return Array.isArray(d.vertices) && Array.isArray(d.faces)
}

export default function JsonViewer({ url, cameraLink }: { url: string; cameraLink?: CameraLink }) {
  const [data, setData]   = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView]   = useState<'3d' | 'text'>('3d')

  useEffect(() => {
    setData(null)
    setError(null)
    setView('3d')
    fetch(url)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError('Failed to load JSON'))
  }, [url])

  if (error) return <p className="text-red-400 p-4">{error}</p>
  if (!data)  return <p className="text-gray-400 p-4">Loading…</p>

  if (isThreeGeometryJson(data)) {
    if (view === 'text') {
      return (
        <div className="h-full flex flex-col">
          <div className="flex gap-2 p-2 shrink-0 bg-gray-900 border-b border-gray-800">
            <button
              onClick={() => setView('3d')}
              className="px-3 py-1 rounded text-sm font-medium bg-gray-700 text-gray-300 hover:bg-gray-600"
            >
              3D
            </button>
            <button
              disabled
              className="px-3 py-1 rounded text-sm font-medium bg-blue-600 text-white cursor-default"
            >
              JSON
            </button>
          </div>
          <pre className="flex-1 overflow-auto p-4 text-sm text-green-300 whitespace-pre-wrap break-all bg-gray-950">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )
    }
    // view === '3d'
    return <ThreeJsonViewer data={data} onSwitchToText={() => setView('text')} cameraLink={cameraLink} />
  }

  // Regular data JSON — scrollable text view
  return (
    <div className="h-full overflow-auto p-4">
      <pre className="text-sm text-green-300 whitespace-pre-wrap break-all">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  )
}
