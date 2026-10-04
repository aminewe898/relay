import assert from 'node:assert/strict';
import test from 'node:test';
import { authorized, mode,localObserver } from '../lib/auth';
import { fixtureSnapshot } from './fixtures';
import { bindSql,pageOptions,uuid } from '../lib/api/sql';
import { actionQueue, emptySnapshot, searchRecords } from '../lib/model';
import { readSnapshot, reads, type QueryClient } from '../lib/reader';

test('critical incidents lead the queue; operator decisions remain separate and precede ordinary work', () => {
  const data = fixtureSnapshot();
  const queue = actionQueue(data);
  assert.equal(queue[0].tag, 'Critical');
  assert.equal(queue[1].id, 'test-interaction');
  assert.equal(queue.filter(a => a.rank >= 3).length, 3);
  assert.equal(queue.some(a => a.id === 'test-ticket-4'), false);
});
test('uncertain delivery requests verification instead of resending', () => {
  const data = fixtureSnapshot();
  data.deliveries[0].status = 'uncertain';
  const action = actionQueue(data).find(a => a.id === 'test-delivery')!;
  assert.match(action.reason, /Verify delivery/);
  assert.equal(action.action, 'Inspect delivery');
  assert.equal(action.rank, 1);
});
test('equal priorities use oldest ticket first', () => {
  const data = fixtureSnapshot();
  data.interactions = [];
  data.tickets = data.tickets.slice(0, 2).map((t, i) => ({ ...t, priority: 'normal', createdAt: `2026-10-0${2 - i}T10:00:00Z` }));
  assert.equal(actionQueue(data)[0].id, data.tickets[1].id);
});
test('search resolves contact email to its customer and ticket number to workspace', () => {
  const data = fixtureSnapshot();
  assert.equal(searchRecords(data, 'unit@example.invalid')[0].href, '/customers/test-client');
  assert.equal(searchRecords(data, 'Test issue 1')[0].href, '/tickets/test-ticket-1');
  assert.equal(searchRecords(data, 'no such record').length, 0);
});
test('mock/demo modes cannot supply runtime records', () => {
  assert.equal(mode({}), 'disconnected');
  assert.equal(mode({ SERVICE_DESK_MODE: 'production' }), 'disconnected');
  assert.equal(mode({ SERVICE_DESK_MODE: 'demo' }), 'disconnected');
  assert.equal(emptySnapshot('unavailable', 'failed').tickets.length, 0);
});
test('local observer denies remote hosts, cross-origin and forwarded access',()=>{
  const env={SERVICE_DESK_MODE:'live',SERVICE_DESK_TRANSPORT:'local-docker'};
  const h=new Headers({host:'127.0.0.1:3100','sec-fetch-site':'same-origin'});
  assert.equal(localObserver(h,env),true);
  assert.equal(localObserver(h,{}),false);
  for(const [key,value] of [['host','example.com'],['sec-fetch-site','cross-site'],['origin','https://example.com'],['x-forwarded-for','10.0.0.2']]){const bad=new Headers(h);bad.set(key,value);assert.equal(localObserver(bad,env),false);}
});
test('SQL binding escapes input and accepts only values; pagination is bounded',()=>{
  assert.equal(bindSql('SELECT $1 AS q, $2::uuid AS id',["quote'; SELECT unsafe; --",null]),"SELECT 'quote''; SELECT unsafe; --' AS q, NULL::uuid AS id");
  assert.throws(()=>bindSql('SELECT $1',[{}]));
  assert.throws(()=>pageOptions(new URLSearchParams('limit=10000')));
  assert.throws(()=>pageOptions(new URLSearchParams('page=-1')));
  assert.equal(pageOptions(new URLSearchParams('page=2&limit=20')).offset,20);
  assert.equal(uuid("';DROP TABLE tickets;--"),false);
});
test('live authentication fails closed for absent configuration, wrong passwords and malformed headers', () => {
  const env = { SERVICE_DESK_AUTH_USER: 'test-user', SERVICE_DESK_AUTH_PASSWORD: 'fake-test-password' };
  const valid = `Basic ${Buffer.from('test-user:fake-test-password').toString('base64')}`;
  assert.equal(authorized(valid, env), true);
  assert.equal(authorized(valid, {}), false);
  assert.equal(authorized(null, env), false);
  assert.equal(authorized('Bearer anything', env), false);
  assert.equal(authorized('Basic !!!', env), false);
  assert.equal(authorized(`Basic ${Buffer.from('test-user:wrong').toString('base64')}`, env), false);
});
test('reader uses one read-only transaction, commits and flags bounded results', async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql);
    return { rows: sql === reads[1][1] ? Array.from({ length: 201 }, (_, i) => ({ id: String(i), name: `Customer ${i}` })) : [] };
  } } as unknown as QueryClient;
  const data = await readSnapshot(client);
  assert.match(calls[0], /REPEATABLE READ READ ONLY/);
  assert.equal(calls.at(-1), 'COMMIT');
  assert.equal(data.customers.length, 200);
  assert.equal(data.truncated, true);
  assert.equal(data.source, 'live');
});
test('reader rolls back on schema/connection failure and does not return demo fixtures', async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => { calls.push(sql); if (sql === reads[0][1]) throw new Error('fake schema failure'); return { rows: [] }; } } as unknown as QueryClient;
  await assert.rejects(() => readSnapshot(client), /fake schema failure/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(calls.includes('COMMIT'), false);
});
test('browser projection excludes worker secrets, raw provider payloads and Telegram identifiers', () => {
  for (const [, sql] of reads) {
    assert.doesNotMatch(sql, /SELECT\s+\*|lease_token|lease_owner|operator_chat_id|bot_id|audio_bytes|policy_snapshot|structured_data|last_error_summary|response_value|payload|transcription_metadata|extraction_metadata/i);
  }
  assert.match(reads[3][1], /extraction_validated_at IS NOT NULL/);
});
