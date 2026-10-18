// The narrowest loopback allowance the oldest-supported-Client qualification leg needs.
// It is deliberately not a general "HTTP is allowed in Beta" switch: the stage must be
// beta, the caller must opt in explicitly, the URL must be a bare loopback origin with an
// explicit port, and the Service URL is never allowed to leave HTTPS.
function isLoopbackClientUrl(value: string): boolean {
  if (process.env.E2E_STAGE !== 'beta' || process.env.E2E_ALLOW_LOOPBACK_CLIENT !== 'true') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    && /^[1-9][0-9]{0,4}$/.test(url.port)
    && Number(url.port) <= 65_535
    && url.username === ''
    && url.password === ''
    && url.pathname === '/'
    && url.search === ''
    && url.hash === '';
}

export default function verifyDeployedEnvironment(): void {
  if (!['beta', 'prod'].includes(process.env.E2E_STAGE ?? '')) {
    throw new Error('E2E_STAGE must be beta or prod; system E2E does not run in dev');
  }
  if (process.env.E2E_EXTERNAL_SERVERS !== 'true') {
    throw new Error('E2E_EXTERNAL_SERVERS must be true for deployed Beta verification');
  }
  const clientUrl = process.env.E2E_CLIENT_URL;
  if (!clientUrl) throw new Error('Missing required E2E environment variable: E2E_CLIENT_URL');
  const serviceUrl = process.env.E2E_SERVICE_URL;
  if (!serviceUrl) throw new Error('Missing required E2E environment variable: E2E_SERVICE_URL');
  if (!isLoopbackClientUrl(clientUrl) && new URL(clientUrl).protocol !== 'https:') {
    throw new Error('E2E_CLIENT_URL must use HTTPS for deployed Beta verification unless E2E_ALLOW_LOOPBACK_CLIENT=true in the beta stage');
  }
  if (new URL(serviceUrl).protocol !== 'https:') {
    throw new Error('E2E_SERVICE_URL must use HTTPS for deployed Beta verification');
  }
}
