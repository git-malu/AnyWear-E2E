import { expect, test, type APIResponse } from '@playwright/test';
import { CLIENT_VERSION_HEADER, CLIENT_VERSION_HEADERS } from './support/client-version.js';

/**
 * The deployed Service's Client-version rejection contract (#256).
 *
 * The Service refuses any request below its release floor with HTTP 400 and the body code
 * `CLIENT_VERSION_UNSUPPORTED`, and it admits a Client at the floor. This scenario proves
 * both halves against the deployed Service, plus the exemption `/health` keeps. It creates
 * nothing: the bare Playwright `request` fixture issues four unauthenticated probes and two
 * health reads, so it owns no account, token, browser page or cleanup.
 *
 * The live floor is read from the Service's own `/health` inside the test body, never at
 * module scope: `playwright test --list` loads every spec with no E2E environment. The
 * fixture's `baseURL` is `E2E_CLIENT_URL`, so every probe uses the absolute Service URL.
 */

// The Service's client-version middleware exempts `/health`, `/healthz`, `/readyz`,
// `/openapi.json`, `/docs` and the `/cleanup-operations` prefix. `/users/me` is a
// non-exempt business route behind the bearer-auth middleware, so a request the version
// gate admits reaches auth and answers exactly 401 without a token; a 400 there would
// mean the gate refused a Client it should have admitted.
const NON_EXEMPT_BUSINESS_ROUTE = '/users/me';
const EXEMPT_HEALTH_ROUTE = '/health';

interface ServiceHealth {
  minimum_client_version?: unknown;
}

interface ServiceErrorBody {
  error?: unknown;
  details?: unknown;
}

function requireServiceOrigin(): string {
  const value = process.env.E2E_SERVICE_URL;
  if (!value) throw new Error('Missing required E2E environment variable: E2E_SERVICE_URL');
  return value;
}

function serviceUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

async function bodyOf(response: APIResponse): Promise<ServiceErrorBody> {
  return await response.json() as ServiceErrorBody;
}

test.describe('Client version rejection contract @regression', () => {
  test('refuses a Client below the live floor, admits one at it, and keeps /health exempt', async ({ request }) => {
    const origin = requireServiceOrigin();
    const probeUrl = serviceUrl(origin, NON_EXEMPT_BUSINESS_ROUTE);
    const healthUrl = serviceUrl(origin, EXEMPT_HEALTH_ROUTE);

    // The live floor is the Service's own statement, read here rather than at module scope.
    // A floor below 1 cannot derive a below-floor version, so the scenario fails closed with
    // a clear message instead of skipping a release gate.
    const health = await request.get(healthUrl);
    expect(health.status()).toBe(200);
    const observedFloor = (await health.json() as ServiceHealth).minimum_client_version;
    if (typeof observedFloor !== 'number' || !Number.isSafeInteger(observedFloor) || observedFloor < 1) {
      throw new Error(`The live Service minimum_client_version is ${JSON.stringify(observedFloor)}, but the rejection contract needs a floor of at least 1 to derive a below-floor request; deploy the Service floor this repository qualifies against`);
    }
    const floor = observedFloor;
    // The rest of the deployed suite presents the committed floor, so the live Service must
    // enforce that same version; the qualification preflight refuses a disagreement too.
    expect(CLIENT_VERSION_HEADERS[CLIENT_VERSION_HEADER]).toBe(String(floor));

    // Below the floor: refused with the typed code and the floor it observed.
    const belowFloor = await request.get(probeUrl, {
      headers: { [CLIENT_VERSION_HEADER]: String(floor - 1) },
    });
    expect(belowFloor.status()).toBe(400);
    const belowFloorBody = await bodyOf(belowFloor);
    expect(belowFloorBody.error).toBe('CLIENT_VERSION_UNSUPPORTED');
    expect(belowFloorBody.details).toEqual({
      minimum_client_version: floor,
      received_client_version: floor - 1,
    });

    // No header at all: the same refusal, with no received version to report.
    const headerless = await request.get(probeUrl);
    expect(headerless.status()).toBe(400);
    const headerlessBody = await bodyOf(headerless);
    expect(headerlessBody.error).toBe('CLIENT_VERSION_UNSUPPORTED');
    expect(headerlessBody.details).toEqual({
      minimum_client_version: floor,
      received_client_version: null,
    });

    // A malformed header is not a canonical version, so it reads as absent.
    const malformed = await request.get(probeUrl, {
      headers: { [CLIENT_VERSION_HEADER]: 'abc' },
    });
    expect(malformed.status()).toBe(400);
    const malformedBody = await bodyOf(malformed);
    expect(malformedBody.error).toBe('CLIENT_VERSION_UNSUPPORTED');
    expect(malformedBody.details).toEqual({
      minimum_client_version: floor,
      received_client_version: null,
    });

    // At the floor the request is admitted and reaches the authenticated route, which
    // answers exactly 401 for the missing token. A 400 here is the gate refusing a Client
    // at the floor, which is why the assertion is an exact status rather than a body code.
    const admitted = await request.get(probeUrl, {
      headers: { [CLIENT_VERSION_HEADER]: String(floor) },
    });
    expect(admitted.status()).toBe(401);

    // The exempt health path keeps serving below the floor and states that same floor.
    const exempt = await request.get(healthUrl, {
      headers: { [CLIENT_VERSION_HEADER]: String(floor - 1) },
    });
    expect(exempt.status()).toBe(200);
    expect((await exempt.json() as ServiceHealth).minimum_client_version).toBe(floor);
  });
});
