// The deployed system serves two CloudFront distributions. The Client SPA
// origin rewrites 403 and 404 to `/index.html` with status 200 so client-side
// deep links keep working, while the Service origin answers the real API. A
// response predicate that only matches on pathname therefore also matches the
// SPA's document navigation for the same route, and parsing that body as JSON
// throws on `<!doctype html>`.
//
// Every predicate that observes a Service API response must scope to the
// Service origin, exclude document navigations, and require a JSON content
// type, so an SPA fallback can never satisfy the race.

export function serviceOriginOf(serviceUrl) {
  return new URL(serviceUrl).origin;
}

export function isServiceJsonResponse(response, serviceOrigin) {
  const request = response.request();
  // A document navigation to the SPA origin serves the fallback index.html.
  if (request.resourceType() === 'document') return false;
  const url = new URL(response.url());
  if (url.origin !== serviceOrigin) return false;
  return isJsonContentType(response.headers()['content-type']);
}

export function isJsonContentType(contentType) {
  if (typeof contentType !== 'string') return false;
  // Strip parameters such as `; charset=utf-8` and compare the media type.
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

export function serviceResponseMatcher(serviceOrigin, { method, path } = {}) {
  return (response) => {
    const request = response.request();
    if (method && request.method() !== method) return false;
    if (path !== undefined && new URL(response.url()).pathname !== path) return false;
    return isServiceJsonResponse(response, serviceOrigin);
  };
}

// `waitForResponse` hands the caller a response whose body it is about to parse.
// Asserting the contract first turns a wrong-origin or HTML body into a legible
// failure instead of a JSON parse error that hides the real cause.
export async function readServiceJson(response) {
  const contentType = response.headers()['content-type'];
  if (!isJsonContentType(contentType)) {
    throw new Error(
      `Expected a Service JSON response for ${response.url()} but received content-type ${String(contentType)}`,
    );
  }
  return response.json();
}

// A Service error body is `{ error: <CODE>, message, requestId }`. The code is
// the only field that can be copied into a test result: it is a fixed vocabulary
// identifier, never a value derived from the request. Anything else — a missing
// field, a message, an HTML body, an unreadable body — reports `undefined`
// rather than being echoed, so a diagnostic can never leak a body or a token.
const SERVICE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export async function sanitizedServiceErrorCode(response) {
  try {
    const body = await response.json();
    const code = body?.error;
    return typeof code === 'string' && SERVICE_ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
