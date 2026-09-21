import ReleasesAdmin from '@/components/ReleasesAdmin'

export const metadata = { title: 'Wydania — CX File Manager' }

// Widok zawsze renderujemy na zadanie: zalezy od ciasteczka sesji.
export const dynamic = 'force-dynamic'

export default function ReleasesPage() {
  return <ReleasesAdmin />
}
