import { NextRequest, NextResponse } from 'next/server'
import { hasScope } from '@/lib/auth'

// Add-in wola to, zeby sprawdzic swoj token zapisu przed wyslaniem zgloszenia.
// Odpowiada tylko true/false — nie zdradza, na jakim poziomie token dziala.
export async function POST(req: NextRequest) {
  return NextResponse.json({ valid: hasScope(req, 'write') })
}
