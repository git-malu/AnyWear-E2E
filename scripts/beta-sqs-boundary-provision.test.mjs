import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSourceOnlyProvisioningHarness, INITIAL_SIGNER_PROVISIONING_CONFIRMATION } from './beta-sqs-boundary-provision.mjs';
import { BOUNDARY_SIGNING_LOCATION, describeBoundaryPublicKey } from './beta-sqs-boundary-trust.mjs';

function fixture(changes = {}) {
  const keys = generateKeyPairSync('ed25519');
  const calls = []; let keyGenerations = 0; let lists = 0;
  const secretName = BOUNDARY_SIGNING_LOCATION.secretName;
  const environment = { name: 'beta', url: 'https://api.github.com/repos/git-malu/AnyWear-E2E/environments/beta',
    protection_rules: [], can_admins_bypass: true,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    const call = { file, args, options }; calls.push(call);
    child.kill = () => { call.killed = true; };
    child.stdin.end = (input) => { call.input = Buffer.from(input); queueMicrotask(() => {
      if (changes.stdinError) child.stdin.emit('error', new Error('private-error-sentinel'));
      child.emit('close', changes.setFailure ? 1 : 0);
    }); };
    if (args[0] === 'api') queueMicrotask(() => {
      if (changes.spawnError) { child.emit('error', new Error('private-error-sentinel')); return; }
      let response;
      if (args[1].includes('deployment-branch-policies')) response = changes.policies ?? policies;
      else if (args[1].includes('/secrets')) {
        lists += 1;
        const exists = changes.existing || (changes.race && lists === 2) || (lists >= 3 && !changes.missingReadback);
        response = changes.secrets ?? { total_count: exists ? 1 : 0, secrets: exists ? [{ name: secretName }] : [] };
      } else response = changes.environment ?? environment;
      child.stdout.emit('data', Buffer.from(changes.badJson ? 'private-error-sentinel' : JSON.stringify(response)));
      child.emit('close', 0);
    });
    return child;
  };
  const harness = createSourceOnlyProvisioningHarness({ spawnProcess, generateFixtureKeys: () => { keyGenerations += 1; return keys; } });
  return { harness, calls, keys, generations: () => keyGenerations };
}

test('fake provisioning uses fixed Beta gh argv and memory-only stdin, returning only public pin after storage metadata confirmation', async () => {
  const f = fixture(); const result = await f.harness.provision(INITIAL_SIGNER_PROVISIONING_CONFIRMATION);
  assert.equal(result.mode, 'source-only-fake-process');
  const set = f.calls.find((call) => call.args[0] === 'secret');
  assert.deepEqual(set.args, ['secret', 'set', BOUNDARY_SIGNING_LOCATION.secretName, '--repo', 'git-malu/AnyWear-E2E', '--env', 'beta']);
  assert.deepEqual(set.options, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const expected = Buffer.from(f.keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), 'ascii');
  assert.ok(set.input.equals(expected));
  assert.equal(f.generations(), 1);
  assert.equal(result.storageConfirmation, 'command-success-and-secret-name-readback');
  assert.equal(result.secretContentReadback, false);
  assert.equal(result.publicPin.spkiSha256, describeBoundaryPublicKey(f.keys.publicKey, 'fixture').spkiSha256);
  assert.equal(JSON.stringify(result).includes(set.input.toString()), false);
  assert.equal(JSON.stringify(f.calls.map((call) => call.args)).includes(set.input.toString()), false);
  set.input.fill(0); expected.fill(0);
});

test('existing secret, racing creation and incomplete lists never rotate or return a public pin', async () => {
  for (const changes of [{ existing: true }, { race: true }, { secrets: { total_count: 101, secrets: [] } },
    { secrets: { total_count: 1, secrets: [] } }]) {
    const f = fixture(changes);
    await assert.rejects(() => f.harness.provision(INITIAL_SIGNER_PROVISIONING_CONFIRMATION), /failed or is ambiguous/);
    assert.equal(f.calls.some((call) => call.args[0] === 'secret'), false);
    if (!changes.race) assert.equal(f.generations(), 0);
  }
});

test('current unprotected Beta policy and non-main-only policies fail before generating key material', async () => {
  for (const changes of [{ environment: { name: 'beta', deployment_branch_policy: null } },
    { policies: { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] } },
    { policies: { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] } },
    { policies: { total_count: 2, branch_policies: [{ name: 'main', type: 'branch' }, { name: 'other', type: 'branch' }] } }]) {
    const f = fixture(changes);
    await assert.rejects(() => f.harness.provision(INITIAL_SIGNER_PROVISIONING_CONFIRMATION), /ambiguous/);
    assert.equal(f.generations(), 0);
    assert.equal(f.calls.some((call) => call.args[0] === 'secret'), false);
  }
});

test('explicit initial confirmation is mandatory; no transport or key generation runs without it', async () => {
  const f = fixture();
  await assert.rejects(() => f.harness.provision('rotate-existing-key'), /ambiguous/);
  assert.equal(f.calls.length, 0); assert.equal(f.generations(), 0);
});

test('process, input, invalid metadata, failed set and missing readback errors are sanitized and never retried', async () => {
  for (const changes of [{ spawnError: true }, { badJson: true }, { setFailure: true }, { stdinError: true }, { missingReadback: true }]) {
    const f = fixture(changes);
    await assert.rejects(() => f.harness.provision(INITIAL_SIGNER_PROVISIONING_CONFIRMATION),
      (error) => error.message === 'Initial Beta signer provisioning failed or is ambiguous; do not retry or rotate automatically');
    assert.ok(f.calls.filter((call) => call.args[0] === 'secret').length <= 1);
    for (const call of f.calls) call.input?.fill(0);
  }
});

test('production provisioning has no import-time execution, disk write, PEM export, output, caller CLI configuration or secret argv', async () => {
  const source = await readFile(new URL('./beta-sqs-boundary-provision.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|console\.|process\.stdout|process\.stderr|format:\s*['"]pem|--body|execSync|shell:\s*true/);
  assert.doesNotMatch(source, /import\.meta\.url|process\.argv/);
});
