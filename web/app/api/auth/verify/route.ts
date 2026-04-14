import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const valid = !!token && token === process.env.UPLOAD_BEARER_TOKEN
  return NextResponse.json({ valid })
}
