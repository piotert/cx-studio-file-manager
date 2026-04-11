import FileList from '@/components/FileList'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <h1 className="text-2xl font-bold mb-6">File Manager</h1>
      <FileList />
    </main>
  )
}
