import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import NavBar from '@/components/NavBar'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'CX File Manager',
  description: 'CAD file browser and 3D preview',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex flex-col bg-gray-950 text-gray-100">
        <header className="px-4 py-2 border-b border-gray-800 shrink-0 flex items-center gap-4">
          <span className="text-sm font-semibold tracking-wide text-gray-300 shrink-0">
            CX File Manager
          </span>
          <NavBar />
        </header>
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </body>
    </html>
  )
}
