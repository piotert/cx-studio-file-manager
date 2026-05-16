import ToolsNav from '@/components/ToolsNav'

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b border-gray-800 shrink-0 flex items-center gap-3">
        <span className="text-xs text-gray-500 uppercase tracking-widest shrink-0">Tools</span>
        <div className="h-3 w-px bg-gray-700 shrink-0" />
        <ToolsNav />
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  )
}
