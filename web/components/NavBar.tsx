'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { label: 'File Manager', href: '/' },
  { label: 'Tools', href: '/tools/fibonacci-sphere' },
]

export default function NavBar() {
  const path = usePathname()
  const isTools = path.startsWith('/tools')

  return (
    <nav className="flex items-center gap-1">
      {TABS.map((tab, i) => {
        const active = i === 0 ? !isTools : isTools
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              active
                ? 'bg-gray-700 text-gray-100'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
            }`}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
