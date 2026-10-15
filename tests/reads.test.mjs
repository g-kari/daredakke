import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, ReadTimeoutError, READ_TIMEOUT_MS } from '../src/lib/reads.ts';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

for (const stage of ['fetch', 'body']) test(`GET ${stage} deadline settles even when the reader ignores abort`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = deferred(), parent = new AbortController(); let child, calls = 0;
  const read = readJson('/synthetic', parent.signal, async (url, options) => {
    calls++; assert.equal(url, '/synthetic'); assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store'); child = options.signal;
    return stage === 'fetch' ? waiting.promise : { ok: true, json: () => waiting.promise };
  });
  const rejected = assert.rejects(read, ReadTimeoutError);
  await flush(); t.mock.timers.tick(READ_TIMEOUT_MS - 1); await flush(); assert.equal(child.aborted, false);
  t.mock.timers.tick(1); await rejected;
  assert.equal(child.aborted, true); assert.equal(parent.signal.aborted, false, 'deadline does not invalidate the caller generation');
  waiting.resolve(stage === 'fetch' ? Response.json({ late: true }) : { late: true }); await flush();
  t.mock.timers.tick(READ_TIMEOUT_MS * 10); assert.equal(calls, 1, 'GET is never retried automatically');
});
for (const stage of ['fetch', 'body']) test(`caller cancellation promptly settles an uncooperative ${stage} reader`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController(), waiting = deferred(); let child;
  const read = readJson('/synthetic', parent.signal, async (_, options) => { child = options.signal; return stage === 'fetch' ? waiting.promise : { ok: true, json: () => waiting.promise }; });
  const rejected = assert.rejects(read, { name: 'AbortError' }); await flush(); parent.abort(); await rejected;
  assert.equal(child.aborted, true); t.mock.timers.tick(READ_TIMEOUT_MS * 2);
  waiting.resolve(stage === 'fetch' ? Response.json({ late: true }) : { late: true }); await flush();
});
test('an already cancelled operation does not fetch or leave a deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController(); parent.abort(); let calls = 0;
  await assert.rejects(readJson('/synthetic', parent.signal, async () => { calls++; }), { name: 'AbortError' });
  t.mock.timers.tick(READ_TIMEOUT_MS * 2); assert.equal(calls, 0);
});
test('a completed GET clears deadline and abort subscription without changing its result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController(); let child;
  assert.deepEqual(await readJson('/synthetic', parent.signal, async (_, options) => { child = options.signal; return Response.json({ synthetic: true }); }), { synthetic: true });
  parent.abort(); t.mock.timers.tick(READ_TIMEOUT_MS * 2); assert.equal(child.aborted, false);
});
for (const status of [401, 403, 503]) test(`actual HTTP ${status} rejection does not wait for a stalled error body`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let parsed = false;
  await assert.rejects(readJson('/synthetic', new AbortController().signal, async () => ({ ok: false, status, json: () => { parsed = true; return new Promise(() => {}); } })), /ログイン/);
  assert.equal(parsed, false); t.mock.timers.tick(READ_TIMEOUT_MS * 2);
});
test('malformed successful JSON is an actual read failure, not a timeout', async () => {
  await assert.rejects(readJson('/synthetic', new AbortController().signal, async () => ({ ok: true, json: async () => { throw new SyntaxError('synthetic malformed body'); } })), SyntaxError);
});
