'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TOOLS = [
  { label: 'Fibonacci Sphere', href: '/tools/fibonacci-sphere' },
  { label: 'Visual Hull', href: '/tools/visual-hull' },
]

export default function ToolsNav() {
  const path = usePathname()

  return (
    <nav className="flex items-center gap-1">
      {TOOLS.map(t => (
        <Link
          key={t.href}
          href={t.href}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            path === t.href
              ? 'bg-blue-900/60 text-blue-300 border border-blue-700/60'
              : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
