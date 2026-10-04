import 'server-only';
import { headers } from 'next/headers';
import { Pool } from 'pg';
import { canRead, mode } from './auth';
import { emptySnapshot, type Snapshot } from './model';
import { reads, readSnapshot } from './reader';
import { localRead } from './api/docker-reader';
import { rowsJson, statsSelect } from './api/projections';

const globalPool = globalThis as typeof globalThis & { serviceDeskPool?: Pool; deskSnapshot?: { at: number; pending: Promise<Snapshot> } };
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
async function assertReadAccess() {
  if (mode() !== 'live') throw new ApiError(503, 'Backend unavailable: connection not configured.');
  const requestHeaders = await headers();
  if (!canRead(requestHeaders)) throw new ApiError(401, 'Authentication required.');
  if (process.env.SERVICE_DESK_TRANSPORT === 'local-docker') {
    if (!canRead(requestHeaders, { SERVICE_DESK_MODE: 'live', SERVICE_DESK_TRANSPORT: 'local-docker' })) throw new ApiError(403, 'Local workspace access required.');
  } else if (!process.env.SERVICE_DESK_DATABASE_URL) throw new ApiError(503, 'Backend unavailable: database connection not configured.');
}
function pool() {
  if (!globalPool.serviceDeskPool) {
    globalPool.serviceDeskPool = new Pool({ connectionString: process.env.SERVICE_DESK_DATABASE_URL, max: 3, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000 });
    globalPool.serviceDeskPool.on('error', () => {});
  }
  return globalPool.serviceDeskPool;
}
export async function readJson<T>(select: string, parameters: readonly unknown[] = []): Promise<T> {
  await assertReadAccess();
  try {
    if (process.env.SERVICE_DESK_TRANSPORT === 'local-docker') return await localRead<T>(select, parameters);
    const client = await pool().connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='5000ms'");
      const result = await client.query(select, [...parameters]);
      await client.query('COMMIT');
      return result.rows[0]?.value as T;
    } catch { await client.query('ROLLBACK'); throw new Error('Backend unavailable'); }
    finally { client.release(); }
  } catch { throw new ApiError(503, 'Backend unavailable'); }
}
async function snapshotRead(): Promise<Snapshot> {
  if (process.env.SERVICE_DESK_TRANSPORT === 'local-docker') {
    const fields = reads.map(([name, select]) => `'${name}',${rowsJson(select)}`).join(',');
    const data = await localRead<Record<string, unknown>>(`SELECT jsonb_build_object(${fields},'stats',(${statsSelect}))`);
    const snapshot = { ...emptySnapshot('live', null), ...data } as Snapshot;
    for (const [key] of reads) {
      const rows = snapshot[key] as unknown[];
      snapshot.truncated ||= rows.length > 200;
      (snapshot[key] as unknown[]) = rows.slice(0, 200);
    }
    snapshot.intakes = snapshot.intakes.map(i => ({ ...i, missingInformation: Array.isArray(i.missingInformation) ? i.missingInformation.filter(v => typeof v === 'string') : [] }));
    return snapshot;
  }
  const client = await pool().connect();
  try { return await readSnapshot(client); } finally { client.release(); }
}
export async function loadSnapshot(): Promise<Snapshot> {
  if (mode() !== 'live') return emptySnapshot('disconnected', 'Backend unavailable: connection not configured.');
  try {
    await assertReadAccess();
    if (!globalPool.deskSnapshot || Date.now() - globalPool.deskSnapshot.at > 2000) globalPool.deskSnapshot = { at: Date.now(), pending: snapshotRead() };
    return await globalPool.deskSnapshot.pending;
  } catch { globalPool.deskSnapshot = undefined; return emptySnapshot('unavailable', 'Backend unavailable. Retry the connection.'); }
}
