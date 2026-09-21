import { NextRequest, NextResponse } from 'next/server'
import { requireScope } from '@/lib/auth'
import { deleteRelease, isValidVersion } from '@/lib/releases'

/**
 * Kasowanie wydania (S5, 21.09). Token admina - ten sam zakres co
 * DELETE /api/files/delete-all (osobnego DELETE_TOKEN nie ma w tym serwerze,
 * auth.ts zna dwa zakresy: write i admin).
 *
 * DELETE /api/releases/<version>
 *   204  skasowano plik + wiersz (dowolny status: pending albo published)
 *   404  nie ma takiej wersji
 *   409  wersja jest promowana (app_release wskazuje na nia) - najpierw
 *        promuj inna, inaczej /api/update wskazywalby paczke, ktorej nie ma
 *   401  bez tokenu / zly token
 *   400  numer wersji spoza x.y.z[.w]
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ version: string }> }
) {
  const denied = requireScope(req, 'admin')
  if (denied) return denied

  const version = (await params).version
  if (!isValidVersion(version)) {
    return NextResponse.json({ error: 'Invalid version' }, { status: 400 })
  }

  let outcome
  try {
    outcome = await deleteRelease(version)
  } catch (error) {
    console.error('[releases] delete failed', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  switch (outcome) {
    case 'deleted':
      return new NextResponse(null, { status: 204 })
    case 'not_found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    case 'promoted':
      return NextResponse.json(
        { error: 'Version is promoted in app_release - promote another version first' },
        { status: 409 }
      )
    default:
      return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
