import { NextResponse } from 'next/server';
import { ApiError } from '../data';
export async function response(fn: () => Promise<unknown>) {
  try { return NextResponse.json(await fn(), { headers: { 'Cache-Control':'no-store' } }); }
  catch (error) { return NextResponse.json({ error: error instanceof ApiError ? error.message : 'Backend unavailable', source: 'unavailable' }, { status: error instanceof ApiError ? error.status : 503, headers: { 'Cache-Control':'no-store' } }); }
}
