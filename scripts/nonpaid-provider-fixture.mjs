import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FIXTURE_DELAY_MS = 45_000;
export const FIXTURE_KEY = 'anywear-nonpaid-loopback-only';
export const FIXTURE_PORTS = { success: 18765, failure: 18766 };

// Kept self-contained so the same reviewed source runs in the immutable worker image.
export function createFixtureServer({ createServer, mode, delayMs = 45_000, key = 'anywear-nonpaid-loopback-only' }) {
  if (!['success', 'failure'].includes(mode) || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 45_000) {
    throw new Error('Invalid non-paid fixture configuration');
  }
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end('ok');
      request.resume();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
      || request.headers.authorization !== `Bearer ${key}`) {
      request.resume();
      response.writeHead(403).end();
      return;
    }
    // Discard the body without parsing, retaining, forwarding, or logging it.
    request.resume();
    const timer = setTimeout(() => {
      if (response.destroyed) return;
      const body = mode === 'failure'
        ? { error: { message: 'Synthetic non-paid provider failure', type: 'fixture_error', code: 'fixture_500' } }
        : { id: 'fixture-nonpaid', object: 'chat.completion', created: 0, model: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
            category: 'Top', style_attributes: { color: 'Black', material: 'Cotton' },
            weather_tags: ['Warm'], name: 'Synthetic shirt', view: 'front',
          }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      response.writeHead(mode === 'failure' ? 500 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    }, delayMs);
    response.on('close', () => clearTimeout(timer));
    request.on('error', () => response.destroy());
  });
}

export function fixtureProcessSource() {
  return `import { createServer } from 'node:http';\n${createFixtureServer.toString()}\n`
    + `for (const [mode, port] of Object.entries(${JSON.stringify(FIXTURE_PORTS)})) {\n`
    + `createFixtureServer({createServer, mode}).listen(port, '127.0.0.1');\n}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [mode, port] of Object.entries(FIXTURE_PORTS)) {
    createFixtureServer({ createServer, mode }).listen(port, '127.0.0.1');
  }
}
