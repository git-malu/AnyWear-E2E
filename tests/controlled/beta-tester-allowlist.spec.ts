import {
  AdminConfirmSignUpCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BetaAllowlistSession, buildBetaRecoveryManifest } from '../support/beta-allowlist-session.js';
import { requireEnvironment } from '../support/account.js';

test('private Beta testers retain verification and lose only new-task access when revoked or suspended @full-stack', async ({ page }, testInfo) => {
  const cognito = new CognitoIdentityProviderClient({ region: 'ap-east-1' });
  const password = `Beta-${randomUUID()}Aa1!`;
  const clientId = requireEnvironment('VITE_COGNITO_CLIENT_ID');
  const poolId = requireEnvironment('USER_POOL_ID');
  const serviceUrl = requireEnvironment('E2E_SERVICE_URL');
  const fixture = await readFile(fileURLToPath(new URL('../fixtures/dummy.png', import.meta.url)));
  let session: BetaAllowlistSession | undefined;
  let authorization: string | undefined;
  let itemId: string | undefined;
  let basePhotoId: string | undefined;
  let executionError: unknown;
  let taskAccepted = false;
  let taskTerminal = false;
  const cleanupErrors: unknown[] = [];
  const evidence: Record<string, unknown> = {
    record_type: 'anywear_beta_allowlist_acceptance',
    service_commit: requireEnvironment('SERVICE_COMMIT_SHA'),
    client_commit: requireEnvironment('CLIENT_COMMIT_SHA'),
    email_confirmation: 'inbox delivery not exercised; synthetic administrator confirmation pending',
  };
  const recoveryPath = testInfo.outputPath('beta-allowlist-recovery.json');
  const saveRecovery = async () => {
    if (session) await writeFile(recoveryPath, `${JSON.stringify(buildBetaRecoveryManifest(session.state, poolId), null, 2)}\n`);
  };

  const signUp = async (email: string) => {
    const result = await cognito.send(new SignUpCommand({
      ClientId: clientId, Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }],
    }));
    if (session && result.UserSub) { await session.recordIdentity(email, result.UserSub); await saveRecovery(); }
    return result;
  };
  const profile = async (request: APIRequestContext) => {
    const response = await request.get(`${serviceUrl}/users/me`, { headers: { Authorization: authorization! } });
    expect(response.status()).toBe(200);
    return await response.json() as { id: string; email: string; dailyCredits: number };
  };

  try {
    session = await BetaAllowlistSession.start();
    await saveRecovery();
    const primary = session.state.identities[0].email;
    const probe = session.state.identities[1].email;
    evidence.run_scope = session.state.runScope;
    evidence.image_digest = session.state.imageDigest;
    await expect(signUp(`e2e-beta-allowlist-${session.state.runScope}-unlisted@anywear.local`))
      .rejects.toThrow(/Beta is temporarily closed/);
    evidence.unlisted_registration_denied = true;

    await page.goto('/register');
    await page.locator('input[type="email"]').fill(primary);
    await page.locator('input[type="password"]').fill(password);
    const registration = page.waitForResponse((response) => response.request().headers()['x-amz-target']?.endsWith('.SignUp') === true);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    const registered = await registration;
    expect(registered.status()).toBe(200);
    const identity = await registered.json() as { UserConfirmed: boolean; UserSub: string; CodeDeliveryDetails: { DeliveryMedium: string } };
    await session.recordIdentity(primary, identity.UserSub);
    await saveRecovery();
    evidence.synthetic_user_id = identity.UserSub;
    expect(identity.UserConfirmed).toBe(false);
    expect(identity.CodeDeliveryDetails.DeliveryMedium).toBe('EMAIL');
    await page.waitForURL(/\/verify\?/);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    evidence.signup_requires_email_confirmation = true;

    await page.locator('input[type="text"]').fill('invalid-code');
    const wrongCode = page.waitForResponse((response) => response.request().headers()['x-amz-target']?.endsWith('.ConfirmSignUp') === true);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    const rejectedCode = await wrongCode;
    expect(rejectedCode.status()).toBe(400);
    expect((await rejectedCode.json() as { __type: string }).__type).toMatch(/CodeMismatchException|ExpiredCodeException|InvalidParameterException/);
    await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(primary);
    await page.locator('input[type="password"]').fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/verify\?/);
    evidence.unconfirmed_login_denied = true;

    // Synthetic identities have no mailbox. Production confirmation stays unchanged.
    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: poolId, Username: primary, UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
    }));
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId: poolId, Username: primary }));
    evidence.email_confirmation = 'synthetic account explicitly verified and confirmed with Cognito admin commands; inbox delivery not exercised';
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(primary);
    await page.locator('input[type="password"]').fill(password);
    const loadedProfile = page.waitForResponse((response) => new URL(response.url()).pathname === '/users/me' && response.status() === 200);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL('/dashboard');
    const initialProfileResponse = await loadedProfile;
    authorization = await initialProfileResponse.request().headerValue('authorization') ?? undefined;
    expect(authorization).toBeTruthy();
    expect(await initialProfileResponse.json()).toMatchObject({ id: identity.UserSub, email: primary });
    evidence.verified_tester_ui_login = true;

    const headers = { Authorization: authorization! };
    const upload = await page.request.post(`${serviceUrl}/wardrobe/upload-url`, {
      headers, data: { contentType: 'image/png', extension: 'png' },
    });
    expect(upload.status()).toBe(200);
    const target = await upload.json() as { itemId: string; key: string; url: string };
    itemId = target.itemId;
    await session.recordObject(target.key);
    await saveRecovery();
    evidence.item_id = itemId;
    expect((await fetch(target.url, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(fixture), signal: AbortSignal.timeout(30_000),
    })).status).toBe(200);
    const accepted = await page.request.post(`${serviceUrl}/wardrobe/upload`, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: { itemId },
    });
    expect(accepted.status()).toBe(202);
    taskAccepted = true;
    evidence.auto_tag_task_accepted = true;
    await expect.poll(async () => {
      const result = await page.request.get(`${serviceUrl}/wardrobe/items/${itemId}`, { headers });
      expect(result.status()).toBe(200);
      const status = await result.json() as { taggingStatus: string; taggingStateVersion: number };
      evidence.auto_tag_last_status = status.taggingStatus;
      evidence.auto_tag_last_state_version = status.taggingStateVersion;
      return status.taggingStatus;
    }, { timeout: 180_000, intervals: [2_000, 5_000] }).toBe('ready');
    taskTerminal = true;
    await page.goto('/wardrobe');
    await expect(page.locator('main h3').first()).toBeVisible({ timeout: 15_000 });
    evidence.verified_tester_autotag_ready = true;

    const basePhoto = await page.request.post(`${serviceUrl}/vto/base-photos`, {
      headers, data: { contentType: 'image/png', extension: 'png' },
    });
    expect(basePhoto.status()).toBe(201);
    const photo = await basePhoto.json() as { id: string; key: string; uploadUrl: string };
    basePhotoId = photo.id;
    await session.recordObject(photo.key);
    await saveRecovery();
    evidence.base_photo_id = basePhotoId;
    expect((await fetch(photo.uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(fixture), signal: AbortSignal.timeout(30_000),
    })).status).toBe(200);

    const assertNoNewTasks = async () => {
      const before = await profile(page.request);
      const generationsBefore = await page.request.get(`${serviceUrl}/vto/generations`, { headers });
      expect(generationsBefore.status()).toBe(200);
      const retag = await page.request.post(`${serviceUrl}/wardrobe/items/${itemId}/retag`, {
        headers: { ...headers, 'Idempotency-Key': randomUUID() }, data: {},
      });
      expect(retag.status()).toBe(503);
      expect(await retag.json()).toMatchObject({ error: 'BETA_INTAKE_CLOSED' });
      const vto = await page.request.post(`${serviceUrl}/vto/generations`, {
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        data: { base_photo_id: basePhotoId, wearable_item_ids: [itemId] },
      });
      expect(vto.status()).toBe(503);
      expect(await vto.json()).toMatchObject({ error: 'BETA_INTAKE_CLOSED' });
      expect((await profile(page.request)).dailyCredits).toBe(before.dailyCredits);
      const generationsAfter = await page.request.get(`${serviceUrl}/vto/generations`, { headers });
      expect(await generationsAfter.json()).toEqual(await generationsBefore.json());
      const existing = await page.request.get(`${serviceUrl}/wardrobe/items/${itemId}`, { headers });
      expect(existing.status()).toBe(200);
      expect(await existing.json()).toMatchObject({ id: itemId, taggingStatus: 'ready' });
    };

    await session.configure(session.state.original.testerEmails);
    await expect(signUp(probe)).rejects.toThrow(/Beta is temporarily closed/);
    await assertNoNewTasks();
    await page.reload();
    await expect(page.locator('main h3').first()).toBeVisible({ timeout: 15_000 });
    evidence.revocation_blocks_registration_and_both_task_producers = true;
    evidence.revocation_preserves_profile_results_credits = true;

    await session.configure(session.state.original.testerEmails.concat(primary, probe));
    await session.suspend();
    await expect(signUp(probe)).rejects.toThrow(/Beta is temporarily closed/);
    await assertNoNewTasks();
    evidence.suspension_overrides_listed_testers = true;
    evidence.suspension_preserves_profile_results_credits = true;
  } catch (error) {
    executionError = error;
  } finally {
    if (taskAccepted && !taskTerminal && authorization) {
      try {
        await expect.poll(async () => {
          const response = await page.request.get(`${serviceUrl}/wardrobe/items/${itemId}`, { headers: { Authorization: authorization! } });
          expect(response.status()).toBe(200);
          return ['ready', 'failed'].includes((await response.json() as { taggingStatus: string }).taggingStatus);
        }, { timeout: 180_000, intervals: [5_000, 10_000] }).toBe(true);
      } catch (error) { cleanupErrors.push(error); }
    }
    try {
      session ??= await BetaAllowlistSession.resume();
      if (session) await session.restore();
    } catch (error) { cleanupErrors.push(error); }
    cognito.destroy();
    evidence.cleanup_passed = cleanupErrors.length === 0;
    await saveRecovery();
    const evidencePath = testInfo.outputPath('beta-allowlist-acceptance.json');
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    await testInfo.attach('beta-allowlist-acceptance.json', { path: evidencePath, contentType: 'application/json' });
  }
  const errors = [...(executionError ? [executionError] : []), ...cleanupErrors];
  if (errors.length > 0) throw new AggregateError(errors, 'Controlled Beta acceptance or cleanup failed');
});
