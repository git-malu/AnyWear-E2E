import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isJsonContentType,
  isServiceJsonResponse,
  readServiceJson,
  sanitizedServiceErrorCode,
  serviceOriginOf,
  serviceResponseMatcher,
} from '../tests/support/service-json-response.mjs';

const SERVICE_ORIGIN = 'https://d1pfqujqt29n11.cloudfront.net';
const SPA_ORIGIN = 'https://d2rztl7o0y7rf8.cloudfront.net';

function response({ url, contentType, resourceType = 'xhr', method = 'GET', body = '{}' }) {
  return {
    url: () => url,
    headers: () => (contentType === undefined ? {} : { 'content-type': contentType }),
    request: () => ({ resourceType: () => resourceType, method: () => method }),
    json: async () => JSON.parse(body),
  };
}

// The SPA distribution answers an unknown path with the client shell at status
// 200. This is the response that previously won the waitForResponse race and
// then failed `.json()`. Any Service-scoped predicate must reject it.
const spaFallbackDocument = () => response({
  url: `${SPA_ORIGIN}/wardrobe`,
  contentType: 'text/html',
  resourceType: 'document',
});

test('serviceOriginOf reduces a Service URL to its origin', () => {
  assert.equal(serviceOriginOf(`${SERVICE_ORIGIN}/base/wardrobe?x=1`), SERVICE_ORIGIN);
});

test('rejects the SPA fallback document navigation for the same path', () => {
  const spa = spaFallbackDocument();
  assert.equal(isServiceJsonResponse(spa, SERVICE_ORIGIN), false);
  // Both scoping rules independently exclude it: wrong origin, and a document.
  assert.equal(isServiceJsonResponse(
    response({ url: `${SERVICE_ORIGIN}/wardrobe`, contentType: 'text/html', resourceType: 'document' }),
    SERVICE_ORIGIN,
  ), false);
  assert.equal(serviceResponseMatcher(SERVICE_ORIGIN, { method: 'GET', path: '/wardrobe' })(spa), false);
});

test('accepts a Service JSON XHR response', () => {
  const api = response({ url: `${SERVICE_ORIGIN}/wardrobe`, contentType: 'application/json; charset=utf-8' });
  assert.equal(isServiceJsonResponse(api, SERVICE_ORIGIN), true);
  assert.equal(serviceResponseMatcher(SERVICE_ORIGIN, { method: 'GET', path: '/wardrobe' })(api), true);
});

test('matcher honours method and path criteria', () => {
  const api = response({ url: `${SERVICE_ORIGIN}/wardrobe/upload`, contentType: 'application/json', method: 'POST' });
  const match = serviceResponseMatcher(SERVICE_ORIGIN, { method: 'POST', path: '/wardrobe/upload' });
  assert.equal(match(api), true);
  assert.equal(serviceResponseMatcher(SERVICE_ORIGIN, { method: 'GET', path: '/wardrobe/upload' })(api), false);
  assert.equal(serviceResponseMatcher(SERVICE_ORIGIN, { method: 'POST', path: '/wardrobe' })(api), false);
});

test('rejects a Service-origin response that is not JSON', () => {
  const html = response({ url: `${SERVICE_ORIGIN}/wardrobe`, contentType: 'text/html' });
  assert.equal(isServiceJsonResponse(html, SERVICE_ORIGIN), false);
});

test('isJsonContentType ignores parameters and casing', () => {
  assert.equal(isJsonContentType('application/json'), true);
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType('  Application/JSON '), true);
  assert.equal(isJsonContentType('text/html'), false);
  assert.equal(isJsonContentType('text/html; charset=utf-8'), false);
  assert.equal(isJsonContentType(undefined), false);
});

test('readServiceJson parses a JSON body and names the offending content type', async () => {
  const api = response({ url: `${SERVICE_ORIGIN}/wardrobe`, contentType: 'application/json', body: '[{"id":"a"}]' });
  assert.deepEqual(await readServiceJson(api), [{ id: 'a' }]);

  await assert.rejects(
    () => readServiceJson(spaFallbackDocument()),
    /Expected a Service JSON response .*content-type text\/html/,
  );
});

test('sanitizedServiceErrorCode reports only the Service error vocabulary code', async () => {
  const errorBody = (body) => response({ url: `${SERVICE_ORIGIN}/users/me`, contentType: 'application/json', body });
  // The shape the Service returns for a refused profile sync (issue #129).
  assert.equal(await sanitizedServiceErrorCode(errorBody(
    JSON.stringify({ error: 'CONFLICT', message: 'Email is already provisioned to a different Cognito user', requestId: 'r' }),
  )), 'CONFLICT');
  assert.equal(await sanitizedServiceErrorCode(errorBody('{"error":"DATABASE_ERROR"}')), 'DATABASE_ERROR');
  // Anything that is not that vocabulary is omitted rather than echoed.
  for (const body of ['{}', '{"error":42}', '{"error":""}', '{"error":"a lower case code"}',
    '{"error":"<script>"}', '{"message":"Conflict"}', 'null', '[]', `{"error":"${'A'.repeat(65)}"}`]) {
    assert.equal(await sanitizedServiceErrorCode(errorBody(body)), undefined, body);
  }
  // An unreadable or non-JSON body is omitted too, never surfaced as a message.
  const html = response({ url: `${SERVICE_ORIGIN}/users/me`, contentType: 'text/html', body: '<!doctype html>' });
  assert.equal(await sanitizedServiceErrorCode(html), undefined);
  const unreadable = response({ url: `${SERVICE_ORIGIN}/users/me`, contentType: 'application/json' });
  unreadable.json = async () => { throw new Error('body unavailable'); };
  assert.equal(await sanitizedServiceErrorCode(unreadable), undefined);
});
