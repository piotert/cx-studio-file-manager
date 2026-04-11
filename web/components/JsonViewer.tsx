'use client'

import { useEffect, useState } from 'react'

export default function JsonViewer({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setContent(null)
    setError(null)
    fetch(url)
      .then((r) => r.json())
      .then((data) => setContent(JSON.stringify(data, null, 2)))
      .catch(() => setError('Failed to load JSON'))
  }, [url])

  if (error) return <p className="text-red-400">{error}</p>
  if (!content) return <p className="text-gray-400">Loading...</p>

  return (
    <pre className="bg-gray-900 rounded p-4 overflow-auto text-sm text-green-300 max-h-[70vh] whitespace-pre-wrap break-all">
      {content}
    </pre>
  )
}
