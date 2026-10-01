export default function verifyDeployedEnvironment(): void {
  if (!['beta', 'prod'].includes(process.env.E2E_STAGE ?? '')) {
    throw new Error('E2E_STAGE must be beta or prod; system E2E does not run in dev');
  }
  if (process.env.E2E_EXTERNAL_SERVERS !== 'true') {
    throw new Error('E2E_EXTERNAL_SERVERS must be true for deployed Beta verification');
  }
  for (const name of ['E2E_CLIENT_URL', 'E2E_SERVICE_URL']) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required E2E environment variable: ${name}`);
    if (new URL(value).protocol !== 'https:') {
      throw new Error(`${name} must use HTTPS for deployed Beta verification`);
    }
  }
}
