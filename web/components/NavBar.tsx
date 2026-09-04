'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { label: 'File Manager', href: '/', match: (p: string) => p === '/' },
  { label: 'Tools', href: '/tools/fibonacci-sphere', match: (p: string) => p.startsWith('/tools') },
  { label: 'Zgłoszenia', href: '/feedback', match: (p: string) => p.startsWith('/feedback') },
]

export default function NavBar() {
  const path = usePathname()

  return (
    <nav className="flex items-center gap-1">
      {TABS.map((tab) => {
        const active = tab.match(path)
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
