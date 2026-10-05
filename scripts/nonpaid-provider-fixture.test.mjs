import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createFixtureServer, FIXTURE_DELAY_MS, FIXTURE_KEY, fixtureProcessSource } from './nonpaid-provider-fixture.mjs';

async function withFixture(mode, body) {
  const server = createFixtureServer({ createServer, mode, delayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await body(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('non-paid fixture consumes no payload data and returns deterministic OpenAI completion', async () => {
  await withFixture('success', async (url) => {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${FIXTURE_KEY}` }, body: 'not JSON: this is never parsed or forwarded' });
    assert.equal(response.status, 200);
    const completion = await response.json();
    assert.equal(completion.object, 'chat.completion');
    assert.equal(JSON.parse(completion.choices[0].message.content).style_attributes.color, 'Black');
    assert.deepEqual(completion.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

test('non-paid failure returns HTTP500 while arbitrary keys and routes fail closed', async () => {
  await withFixture('failure', async (url) => {
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${FIXTURE_KEY}` }, body: 'discard' });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, 'fixture_500');
    assert.equal((await fetch(`${url}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: 'Bearer real-provider-key' } })).status, 403);
    assert.equal((await fetch(`${url}/unknown`)).status, 403);
  });
});

test('reviewed sidecar process has fixed loopback ports/delay and no outbound/log/auth retention code', () => {
  const source = fixtureProcessSource();
  assert.equal(FIXTURE_DELAY_MS, 45_000);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /18765/);
  assert.match(source, /18766/);
  assert.doesNotMatch(source, /fetch\(|console\.|request\.on\('data'|process\.env|https:|http:\/\//);
  assert.throws(() => createFixtureServer({ createServer, mode: 'paid' }), /Invalid/);
});
