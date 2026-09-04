import FeedbackAdmin from '@/components/FeedbackAdmin'

export const metadata = { title: 'Zgłoszenia — CX File Manager' }

// Widok zawsze renderujemy na zadanie: zalezy od ciasteczka sesji.
export const dynamic = 'force-dynamic'

export default function FeedbackPage() {
  return <FeedbackAdmin />
}
