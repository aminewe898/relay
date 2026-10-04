import { NextResponse, type NextRequest } from 'next/server';
import { canRead, mode } from './lib/auth';
export function proxy(request: NextRequest) {
  if (mode() !== 'live') return NextResponse.next();
  if (!canRead(request.headers)) {
    return new NextResponse('This read-only workspace requires configured authentication.', {
      status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Service desk observer", charset="UTF-8"', 'Cache-Control': 'no-store' },
    });
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
