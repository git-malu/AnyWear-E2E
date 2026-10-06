import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { oneShotHarness } from './fixtures/runtime-one-shot-harness.mjs';
import { cleanupFixture } from './fixtures/runtime-evidence.mjs';
import { cleanupPayload } from './runtime-one-shot-logs.mjs';
import { runOwnedOneShot } from './runtime-one-shot.mjs';
import { parseRuntimeRecovery, recoverRuntimeRecord } from './runtime-recovery.mjs';
import { validateRecoveryArtifactBinding } from './runtime-recovery-artifact.mjs';
import { assertRuntimeRecoveryExecutionEnvironment } from './runtime-drill.mjs';

function recordFor(h) {
  const scope = h.scope;
  return { schema_version: 2, record_type: 'anywear_beta_runtime_recovery', stage: 'beta', aws_account_id: '650880818323', aws_region: 'ap-east-1',
    run_scope: scope.runScope, marker: scope.marker, user_pool_id: scope.userPoolId,
    users: [{ sub: scope.subject, email: scope.email, username: scope.cognitoUsername }], items: scope.items, resources: scope.resources,
    one_shots: scope.oneShots ?? [], stack: scope.stack, service_url: scope.config.serviceUrl, deployment: scope.deployment,
    known_dlq_message: scope.knownDLQMessageId, database_cleanup_completed: false, owned_cleanup_completed: false };
}

const environment = { RUNTIME_DRILL_SERVICE_SHA: 'b'.repeat(40), RUNTIME_DRILL_RUN_SCOPE: '123-1-aaaaaaaaaaaaaaaa' };

test('recovery parser refuses foreign controls, identity, object, credentials, and oversized manifests', () => {
  const h = oneShotHarness();
  assert.equal(parseRuntimeRecovery(JSON.stringify(recordFor(h))).run_scope, h.scope.runScope);
  for (const mutate of [
    (record) => { record.runtime_control = { run_scope: 'foreign' }; },
    (record) => { record.users[0].email = 'foreign@example.com'; },
    (record) => { record.resources = [{ bucket: 'bucket', key: 'foreign/key' }]; },
    (record) => { record.deployment.password = 'credential'; },
    (record) => { record.cognito_deletion_intent = { sub: 'foreign' }; },
  ]) {
    const record = structuredClone(recordFor(h));
    mutate(record);
    assert.throws(() => parseRuntimeRecovery(JSON.stringify(record)));
  }
  assert.throws(() => parseRuntimeRecovery(' '.repeat(262_145)), /bounded/);
});

test('commit-before-save and already absent Cognito reconstruct exact original helper proof without rerunning DB cleanup', async () => {
  const h = oneShotHarness();
  h.scope.knownDLQMessageId = { taskId: h.request.taskId, messageId: h.request.itemId };
  const { operation } = await runOwnedOneShot(h.io, h.scope, 'tester-cleanup', '', cleanupPayload(h.scope), h.runner);
  const proof = cleanupFixture(h.scope);
  h.logs.set(operation.proof.log_stream, [proof.deletion, proof.committed]);
  h.io.cognitoSend = async () => { throw Object.assign(new Error('absent'), { name: 'UserNotFoundException' }); };
  h.io.runOneShotCleanup = async () => { throw new Error('Committed helper must not run twice'); };
  const record = parseRuntimeRecovery(JSON.stringify(recordFor(h)));
  assert.equal((await recoverRuntimeRecord(record, h.io, environment, async () => {})).recovered, true);
  assert.ok(h.snapshots.some((scope) => scope.databaseCleanupCompleted && scope.cleanupEvidence?.committed.transaction_committed));
  assert.equal(h.snapshots.at(-1).oneShots[0].deregistered, true);
});

test('Cognito absence is freshly checked and durably saved before helper teardown', async () => {
  const h = oneShotHarness();
  const cognito = h.io.cognitoSend;
  let authoritativeAbsence = false;
  h.io.cognitoSend = async (command) => {
    assert.deepEqual(command.input, { UserPoolId: h.scope.userPoolId, Username: h.scope.cognitoUsername });
    try { return await cognito(command); }
    catch (error) {
      if (error.name === 'UserNotFoundException') authoritativeAbsence = true;
      throw error;
    }
  };
  const save = h.io.saveRecovery;
  h.io.saveRecovery = async (scope) => {
    if (scope.ownedCleanupCompleted) assert.equal(authoritativeAbsence, true);
    return save(scope);
  };
  const aws = h.io.aws;
  h.io.aws = async (args) => {
    if (args[1] === 'deregister-task-definition') assert.equal(h.snapshots.at(-1).ownedCleanupCompleted, true);
    return aws(args);
  };
  assert.equal((await recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(recordFor(h))), h.io, environment, async () => {})).recovered, true);
  assert.deepEqual(h.calls.filter(([name]) => name.startsWith('Admin')).map(([name]) => name),
    ['AdminGetUserCommand', 'AdminDeleteUserCommand', 'AdminGetUserCommand']);
});

for (const response of ['retained', 'lookup-error', 'undefined', 'null', 'partial', 'delete-not-found']) {
  test(`Cognito post-delete ${response} withholds cleanup completion and retains exact intent`, async () => {
    const h = oneShotHarness();
    const cognito = h.io.cognitoSend;
    let deleted = false;
    h.io.cognitoSend = async (command) => {
      assert.deepEqual(command.input, { UserPoolId: h.scope.userPoolId, Username: h.scope.cognitoUsername });
      if (command.constructor.name === 'AdminDeleteUserCommand') {
        assert.deepEqual(h.snapshots.at(-1).cognitoDeletionIntent,
          { sub: h.scope.subject, email: h.scope.email, username: h.scope.cognitoUsername });
        deleted = true;
        if (response === 'delete-not-found') throw Object.assign(new Error('delete reports absent'), { name: 'UserNotFoundException' });
        return {};
      }
      if (!deleted || response === 'retained' || response === 'delete-not-found') return cognito(command);
      if (response === 'lookup-error') throw Object.assign(new Error('lookup unavailable'), { name: 'InternalErrorException' });
      return response === 'undefined' ? undefined : response === 'null' ? null : {};
    };
    await assert.rejects(recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(recordFor(h))), h.io, environment, async () => {}),
      /absence is not authoritative|lookup unavailable/);
    assert.equal(deleted, true);
    assert.equal(h.snapshots.at(-1).ownedCleanupCompleted, false);
    assert.equal(h.snapshots.at(-1).cognitoDeletionIntent.username, h.scope.cognitoUsername);
    assert.ok(!h.calls.some((args) => args[1] === 'deregister-task-definition'));
  });
}

for (const response of ['reappeared', 'lookup-error']) {
  test(`initial Cognito absence followed by ${response} cannot authorize restoration`, async () => {
    const h = oneShotHarness();
    const cognito = h.io.cognitoSend;
    let lookups = 0;
    h.io.cognitoSend = async (command) => {
      assert.equal(command.constructor.name, 'AdminGetUserCommand');
      assert.deepEqual(command.input, { UserPoolId: h.scope.userPoolId, Username: h.scope.cognitoUsername });
      if (++lookups === 1) throw Object.assign(new Error('initially absent'), { name: 'UserNotFoundException' });
      if (response === 'lookup-error') throw new Error('lookup unavailable');
      return cognito(command);
    };
    await assert.rejects(recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(recordFor(h))), h.io, environment, async () => {}),
      /absence is not authoritative|lookup unavailable/);
    assert.equal(lookups, 2);
    assert.equal(h.snapshots.at(-1).ownedCleanupCompleted, false);
    assert.equal(h.snapshots.at(-1).cognitoDeletionIntent.username, h.scope.cognitoUsername);
    assert.ok(!h.calls.some((args) => args[1] === 'deregister-task-definition'));
  });
}

test('successful empty Cognito lookup is not an absence proof and refuses deletion', async () => {
  for (const response of [undefined, null, {}]) {
    const h = oneShotHarness();
    let calls = 0;
    h.io.cognitoSend = async (command) => { calls++; assert.equal(command.constructor.name, 'AdminGetUserCommand'); return response; };
    await assert.rejects(recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(recordFor(h))), h.io, environment, async () => {}), /identity drift/);
    assert.equal(calls, 1);
    assert.ok(!h.snapshots.some((scope) => scope.ownedCleanupCompleted));
  }
});

test('delete-before-rollback only omits the known message after exact original helper deletion proof', async () => {
  const h = oneShotHarness();
  h.scope.knownDLQMessageId = { taskId: h.request.taskId, messageId: h.request.itemId };
  const { operation } = await runOwnedOneShot(h.io, h.scope, 'tester-cleanup', '', cleanupPayload(h.scope), h.runner);
  h.tasks.get(operation.task_arn).containers[0].exitCode = 1;
  h.logs.set(operation.proof.log_stream, [cleanupFixture(h.scope).deletion]);
  const cleanup = h.io.runOneShotCleanup;
  const payloads = [];
  h.io.runOneShotCleanup = async (args) => { payloads.push(JSON.parse(args.payload)); return cleanup(args); };
  assert.equal((await recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(recordFor(h))), h.io, environment, async () => {})).recovered, true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].knownDLQMessageId, undefined);
  const final = h.snapshots.at(-1);
  assert.equal(final.cleanupEvidence.committed.transaction_committed, true);
  assert.equal(final.cleanupEvidence.preceding_deletion.deletion.known_message.messageId, h.request.itemId);
  assert.equal(final.cleanupEvidence.preceding_deletion.extraction.exit_code, 1);
});

test('absent/foreign deletion markers and saved completion flags cannot authorize cleanup or restoration', async () => {
  for (const foreign of [false, true]) {
    const h = oneShotHarness();
    h.scope.knownDLQMessageId = { taskId: h.request.taskId, messageId: h.request.itemId };
    const { operation } = await runOwnedOneShot(h.io, h.scope, 'tester-cleanup', '', cleanupPayload(h.scope), h.runner);
    h.tasks.get(operation.task_arn).containers[0].exitCode = 1;
    const marker = cleanupFixture(h.scope).deletion;
    marker.known_message.taskId = 'foreign';
    h.logs.set(operation.proof.log_stream, foreign ? [marker] : []);
    let mutations = 0;
    h.io.runOneShotCleanup = async () => { mutations += 1; };
    const record = recordFor(h);
    record.database_cleanup_completed = true;
    record.owned_cleanup_completed = true;
    await assert.rejects(recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(record)), h.io, environment, async () => {}), /foreign|authoritative/);
    assert.equal(mutations, 0);
    assert.ok(!h.calls.some((args) => args[0] === 'AdminDeleteUserCommand' || args[1] === 'delete-object'));
  }
});

test('Cognito-delete-before-save is replayable, and intent is retained before deletion', async () => {
  const h = oneShotHarness();
  let absent = false;
  const cognito = h.io.cognitoSend;
  h.io.cognitoSend = async (command) => {
    if (absent) throw Object.assign(new Error('absent'), { name: 'UserNotFoundException' });
    if (command.constructor.name === 'AdminDeleteUserCommand') {
      assert.equal(h.snapshots.at(-1).cognitoDeletionIntent.sub, h.scope.subject);
      absent = true;
    }
    return cognito(command);
  };
  const save = h.io.saveRecovery;
  h.io.saveRecovery = async (scope) => {
    if (scope.ownedCleanupCompleted) throw new Error('runner lost before completion snapshot');
    return save(scope);
  };
  await assert.rejects(recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(recordFor(h))), h.io, environment, async () => {}), /runner lost/);
  const snapshot = h.snapshots.at(-1);
  h.scope.oneShots = snapshot.oneShots;
  const retry = { ...recordFor(h), cognito_deletion_intent: snapshot.cognitoDeletionIntent };
  h.io.saveRecovery = save;
  h.io.runOneShotCleanup = async () => { throw new Error('Already committed DB cleanup'); };
  assert.equal((await recoverRuntimeRecord(parseRuntimeRecovery(JSON.stringify(retry)), h.io, environment, async () => {})).recovered, true);
});

test('restore-only workflow binds immutable source main/run/artifact pins and uses distinct confirmation', async () => {
  const h = oneShotHarness();
  const record = recordFor(h);
  const compatibility = { client: { sha: 'a'.repeat(40) }, service: { sha: 'b'.repeat(40) } };
  const input = { SOURCE_RUN_ID: '123', SOURCE_RUN_ATTEMPT: '1', SOURCE_SNAPSHOT: '001', ORIGINAL_RUN_SCOPE: record.run_scope };
  const metadata = { id: 123, run_attempt: 1, path: '.github/workflows/runtime-drill.yml', event: 'workflow_dispatch',
    head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', repository: { full_name: 'git-malu/AnyWear-E2E' } };
  assert.equal(validateRecoveryArtifactBinding(metadata, record, input, compatibility), record);
  for (const mutate of [
    (value) => { value.head_branch = 'foreign'; }, (value) => { value.path = '.github/workflows/beta-qualification.yml'; },
    (value) => { value.head_sha = 'c'.repeat(40); }, (value) => { value.run_attempt = 2; },
    (value) => { value.status = 'in_progress'; }, (value) => { delete value.status; },
  ]) { const foreign = structuredClone(metadata); mutate(foreign); assert.throws(() => validateRecoveryArtifactBinding(foreign, record, input, compatibility)); }
  const controls = { E2E_STAGE: 'beta', AWS_ACCOUNT_ID: '650880818323', AWS_REGION: 'ap-east-1', E2E_CLIENT_URL: 'https://client.example',
    E2E_SERVICE_URL: 'https://service.example', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'a'.repeat(40),
    RUNTIME_DRILL_E2E_SHA: 'a'.repeat(40), RUNTIME_DRILL_CLIENT_SHA: 'a'.repeat(40), RUNTIME_DRILL_SERVICE_SHA: 'b'.repeat(40),
    RUNTIME_DRILL_RUN_SCOPE: record.run_scope, RUNTIME_DRILL_ID: record.marker, RUNTIME_DRILL_CONCURRENCY: 'anywear-beta-runtime',
    RUNTIME_DRILL_EXCLUSIVE_WINDOW: 'beta-exclusive-runtime', RUNTIME_DRILL_CONFIRM: 'beta-runtime-recovery' };
  assert.doesNotThrow(() => assertRuntimeRecoveryExecutionEnvironment(controls, compatibility, record));
  assert.throws(() => assertRuntimeRecoveryExecutionEnvironment({ ...controls, RUNTIME_DRILL_CONFIRM: 'beta-runtime-drill' }, compatibility, record));
  const workflow = await readFile(new URL('../.github/workflows/runtime-recovery.yml', import.meta.url), 'utf8');
  assert.match(workflow, /group: anywear-beta-runtime/);
  assert.match(workflow, /environment: beta/);
  assert.match(workflow, /name: Restore captured resources and original private policy only\r?\n\s+env:\r?\n\s+RUNTIME_RECOVERY_SKIP_SNAPSHOT_UPLOAD: 'true'\r?\n\s+run: pnpm exec node scripts\/runtime-drill\.mjs --recover recovery-source\/runtime-drill-recovery\.json/);
  assert.match(workflow, /RUNTIME_RECOVERY_SOURCE_COMPLETED=\$\(jq -r '\.source_completed' recovery-binding.json\)/);
  assert.ok(!workflow.includes('--execute'));
  assert.ok(workflow.indexOf('assertLiveRuntimeSourceReady();') < workflow.indexOf('aws-actions/configure-aws-credentials'));
});
