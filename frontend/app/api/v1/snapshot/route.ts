import { NextResponse } from 'next/server';
import { loadSnapshot } from '../../../../lib/data';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  const data = await loadSnapshot();
  return NextResponse.json(data, { status: data.source === 'live' ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
