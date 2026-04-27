import FileList from '@/components/FileList'

export default function Home() {
  return (
    <main className="h-screen flex flex-col bg-gray-950 text-gray-100 overflow-hidden">
      <header className="px-4 py-2 border-b border-gray-800 shrink-0">
        <span className="text-sm font-semibold tracking-wide text-gray-300">CX File Manager</span>
      </header>
      <div className="flex-1 min-h-0">
        <FileList />
      </div>
    </main>
  )
}
