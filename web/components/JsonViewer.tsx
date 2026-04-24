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

export default function JsonViewer({ url }: { url: string }) {
  const [data, setData] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    setError(null)
    fetch(url)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError('Failed to load JSON'))
  }, [url])

  if (error) return <p className="text-red-400">{error}</p>
  if (!data) return <p className="text-gray-400">Loading...</p>

  if (isThreeGeometryJson(data)) {
    return <ThreeJsonViewer data={data} />
  }

  return (
    <pre className="bg-gray-900 rounded p-4 overflow-auto text-sm text-green-300 max-h-[70vh] whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
