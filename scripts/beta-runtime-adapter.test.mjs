import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeDrillAdapter } from './beta-runtime-adapter.mjs';
import { auditFixture } from './fixtures/runtime-evidence.mjs';

const environment = {
  AWS_REGION: 'ap-east-1',
  RUNTIME_DRILL_RUN_SCOPE: '123-1-aaaaaaaaaaaaaaaa',
  RUNTIME_DRILL_SERVICE_SHA: 'b'.repeat(40),
  E2E_SERVICE_CHECKOUT: 'AnyWear-Service',
};
const subject = '123e4567-e89b-12d3-a456-426614174000';
const email = 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local';

function identity(address = email) {
  return { Username: subject, UserAttributes: [{ Name: 'email', Value: address }, { Name: 'sub', Value: subject }] };
}

function cleanupScope() {
  return {
    runScope: environment.RUNTIME_DRILL_RUN_SCOPE, email, subject, cognitoUsername: subject,
    accessToken: 'token', userPoolId: 'pool', config: { serviceUrl: 'https://service.example' },
    deployment: { service_source_commit: 'b'.repeat(40), service_image_digest: `sha256:${'c'.repeat(64)}` },
    items: ['item'], resources: [],
  };
}

function response(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(body); } };
}

test('runtime adapter exposes every protected hook without making calls at construction', () => {
  const calls = [];
  const adapter = createRuntimeDrillAdapter({
    async aws(args) { calls.push(['aws', args]); return {}; },
    async fetch() { calls.push(['fetch']); return response(200); },
    async sleep() {},
    async cognitoSend() { calls.push(['cognito']); return {}; },
    async runOneShotCleanup() { calls.push(['cleanup']); },
  }, environment);
  assert.deepEqual(Object.keys(adapter).sort(), [
    'captureReplicaAttribution', 'cleanupOwnedResources', 'collectRetryEvidence',
    'createSyntheticAccount', 'replaceAndRestoreEcs', 'runProviderFailureFixture',
    'runWardrobeApiFlow', 'prepareNonPaidRuntime', 'restoreNonPaidRuntime',
    'pauseRuntimeWindow', 'restoreRuntimeWindow', 'recoverOwnedRuntime',
  ].sort());
  assert.deepEqual(calls, []);
});

test('synthetic account creation is bound to the current run scope and returned Cognito subject', async () => {
  const commands = [];
  let createdEmail;
  const adapter = createRuntimeDrillAdapter({
    async auditOwnedTask() {},
    async cognitoSend(command) {
      commands.push(command.constructor.name);
      if (command.constructor.name !== 'AdminCreateUserCommand' && command.input.Username) {
        assert.equal(command.input.Username, subject);
      }
      if (command.constructor.name === 'AdminCreateUserCommand') {
        createdEmail = command.input.Username;
        return { User: { Username: subject, Attributes: identity(createdEmail).UserAttributes } };
      }
      if (command.constructor.name === 'AdminGetUserCommand') {
        return { Username: subject, UserAttributes: [
          { Name: 'email', Value: createdEmail },
          { Name: 'sub', Value: '123e4567-e89b-12d3-a456-426614174000' },
        ] };
      }
      if (command.constructor.name === 'InitiateAuthCommand') return { AuthenticationResult: { AccessToken: 'token' } };
      return {};
    },
  }, environment);
  const scope = await adapter.createSyntheticAccount({
    config: { serviceUrl: 'https://service.example' }, marker: 'beta-runtime-1',
    stack: { userPoolId: 'pool', userPoolClientId: 'client', bucket: 'bucket' },
  });
  assert.match(scope.email, /^e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-[a-f0-9]{8}@anywear\.local$/);
  assert.equal(scope.subject, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(scope.accessToken, 'token');
  assert.deepEqual(commands, [
    'AdminCreateUserCommand', 'AdminSetUserPasswordCommand', 'AdminConfirmSignUpCommand',
    'AdminGetUserCommand', 'InitiateAuthCommand',
  ]);
});

test('synthetic account setup compensates a Cognito user when authentication setup fails', async () => {
  const commands = [];
  const adapter = createRuntimeDrillAdapter({
    async auditOwnedTask() {},
    async cognitoSend(command) {
      commands.push(command.constructor.name);
      if (command.constructor.name === 'AdminCreateUserCommand') {
        this.email = command.input.Username;
        return { User: { Username: subject, Attributes: identity(this.email).UserAttributes } };
      }
      if (command.constructor.name === 'AdminGetUserCommand') return identity(this.email);
      if (command.constructor.name === 'InitiateAuthCommand') throw new Error('auth unavailable');
      return {};
    },
  }, environment);
  await assert.rejects(adapter.createSyntheticAccount({
    config: { serviceUrl: 'https://service.example' }, marker: 'beta-runtime-1',
    stack: { userPoolId: 'pool', userPoolClientId: 'client', bucket: 'bucket' },
  }), /auth unavailable/);
  assert.equal(commands.at(-1), 'AdminDeleteUserCommand');
});

test('worker replacement passes the Beta cluster/service to stability waits and captures changed tasks', async () => {
  const oldApi = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
  const newApi = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'b'.repeat(32)}`;
  const oldWorker = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
  const newWorker = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'d'.repeat(32)}`;
  const waits = [];
  let replaced = false;
  let audits = 0;
  const io = {
    async auditOwnedTask({ request }) { return auditFixture(request, { after: audits++ > 0 }); },
    async sleep(ms) { assert.equal(ms, 440_000); },
    async aws(args) {
      if (args[0] === 'logs') return { events: [{
        logStreamName: `worker/WorkerContainer/${'c'.repeat(32)}`,
        message: JSON.stringify({ taskId: 'task', event: 'task_execution_started', taskType: 'auto-tagging', resourceId: 'item', executionToken: 1 }),
      }] };
      if (args[1] === 'describe-services') return { services: [{ desiredCount: 1 }] };
      if (args[1] === 'list-tasks') {
        const api = args[args.indexOf('--service-name') + 1] === 'api';
        return { taskArns: api ? [replaced ? newApi : oldApi, `${oldApi}e`] : [replaced ? newWorker : oldWorker] };
      }
      if (args[1] === 'stop-task') replaced = true;
      return {};
    },
    async awsWaitServicesStable(cluster, service) { waits.push([cluster, service]); },
    async fetch(url) {
      if (url.endsWith('/stream')) return new Response('event: status\ndata: {"tagging_status":"ready","state_version":3}\n\n');
      if (url.endsWith('/upload')) return response(202, { itemId: 'item', taggingStatus: 'processing' });
      return response(200, { id: 'item', taggingStatus: replaced ? 'ready' : 'processing', taggingStateVersion: replaced ? 3 : 2 });
    },
  };
  const result = await createRuntimeDrillAdapter(io, environment).replaceAndRestoreEcs({
    stack: { cluster: 'beta-anywear', apiService: 'api', workerService: 'worker' },
    scope: {
      marker: 'beta-runtime-1', accessToken: 'token', taskId: 'task', stateVersions: [1],
      config: { serviceUrl: 'https://service.example' },
      item: { itemId: 'item', idempotencyKey: 'key', accepted: { itemId: 'item', taggingStatus: 'processing' } },
    },
  });
  assert.ok(waits.some(([cluster, service]) => cluster === 'beta-anywear' && service === 'worker'));
  assert.equal(result.restart_evidence.worker_restart, true);
  assert.equal(result.restart_evidence.recovery_kind, 'graceful-drain');
  assert.ok(!('no_duplicate_terminal_effect' in result.restart_evidence));
  assert.equal(result.restart_evidence.terminal_snapshot_stable, true);
  assert.deepEqual(result.terminal_observers, [{ status: 'ready', version: 3 }, { status: 'ready', version: 3 }]);
});

test('cleanup deletes API-owned items before pinned Service cleanup, S3, and Cognito', async () => {
  const order = [];
  const io = {
    async fetch(url, options) {
      if (options.method === 'GET') return response(200, { id: url.split('/').at(-1), taggingStatus: 'ready', taggingStateVersion: 3 });
      order.push(`api:${url}`);
      return response(204);
    },
    async runOneShotCleanup() { order.push('service'); },
    async aws(args) {
      order.push(args[0]);
      if (args[0] === 's3api' && args[1] === 'head-object') throw new Error('Not Found');
      return {};
    },
    async cognitoSend(command) {
      order.push(command.constructor.name);
      if (command.constructor.name === 'AdminGetUserCommand') return { Username: subject, UserAttributes: [
        { Name: 'email', Value: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' },
        { Name: 'sub', Value: '123e4567-e89b-12d3-a456-426614174000' },
      ] };
      return {};
    },
  };
  const adapter = createRuntimeDrillAdapter(io, environment);
  await adapter.cleanupOwnedResources({
    scope: {
      runScope: '123-1-aaaaaaaaaaaaaaaa',
      email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local',
      subject: '123e4567-e89b-12d3-a456-426614174000',
      accessToken: 'token', userPoolId: 'pool', config: { serviceUrl: 'https://service.example' },
      deployment: { service_source_commit: 'b'.repeat(40), service_image_digest: `sha256:${'c'.repeat(64)}` },
      item: { itemId: 'item-a' }, failure: { itemId: 'item-b' },
      resources: [{ bucket: 'bucket', key: 'users/owned/item.png' }],
    },
    stack: { bucket: 'bucket' },
  });
  assert.equal(order[0], 'AdminGetUserCommand');
  assert.equal(order[1], 'api:https://service.example/wardrobe/items/item-a');
  assert.equal(order[2], 'api:https://service.example/wardrobe/items/item-b');
  assert.equal(order[3], 'service');
  assert.deepEqual(order.slice(-2), ['AdminGetUserCommand', 'AdminDeleteUserCommand']);
});

test('cleanup accepts already absent and unaccepted version-zero uploading items', async () => {
  for (const state of [undefined, { id: 'item', taggingStatus: 'uploading', taggingStateVersion: 0 }]) {
    const calls = [];
    await createRuntimeDrillAdapter({
      async fetch(_url, options) {
        calls.push(options.method);
        return options.method === 'GET' ? response(state ? 200 : 404, state) : response(404);
      },
      async cognitoSend(command) { calls.push(command.constructor.name); return identity(); },
      async runOneShotCleanup() { calls.push('service'); },
      async saveRecovery() { calls.push('recovery'); },
    }, environment).cleanupOwnedResources({ scope: cleanupScope(), stack: { bucket: 'bucket' } });
    assert.ok(calls.includes('service'));
    assert.equal(calls[0], 'recovery');
    assert.ok(calls.includes('AdminDeleteUserCommand'));
    assert.equal(calls.at(-1), 'recovery');
  }
});

test('cleanup refuses all deletion when active terminal observation fails and retains recovery', async () => {
  const calls = [];
  let gets = 0;
  const adapter = createRuntimeDrillAdapter({
    async fetch(_url, options) {
      calls.push(options.method);
      if (++gets === 2) throw new Error('active observation unavailable');
      return response(200, { id: 'item', taggingStatus: 'processing', taggingStateVersion: 1 });
    },
    async cognitoSend(command) { calls.push(command.constructor.name); return identity(); },
    async runOneShotCleanup() { calls.push('service'); },
    async saveRecovery() { calls.push('recovery'); },
  }, environment);
  await assert.rejects(adapter.cleanupOwnedResources({ scope: cleanupScope(), stack: { bucket: 'bucket' } }), /active observation/);
  assert.equal(calls[0], 'recovery');
  assert.ok(!calls.includes('DELETE') && !calls.includes('service') && !calls.includes('AdminDeleteUserCommand'));
});

test('cleanup delegates exact task DLQ cleanup to the pinned Service helper without observer deletion', async () => {
  const calls = [];
  const scope = cleanupScope();
  scope.failure = { taskId: 'task' };
  await createRuntimeDrillAdapter({
    async fetch(_url, options) { return options.method === 'GET'
      ? response(200, { id: 'item', taggingStatus: 'failed', taggingStateVersion: 3 }) : response(204); },
    async cognitoSend() { return identity(); },
    async runOneShotCleanup(args) { calls.push(args); },
    async aws() { throw new Error('E2E must not observe or delete queues during cleanup'); },
  }, environment).cleanupOwnedResources({ scope, stack: { bucket: 'bucket', queues: { autoTaggingDlq: 'owned-dlq' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].serviceCommit, scope.deployment.service_source_commit);
  assert.equal(calls[0].imageDigest, scope.deployment.service_image_digest);
  assert.deepEqual(JSON.parse(calls[0].payload), { runScope: scope.runScope, users: [{ sub: subject, email }] });
});

test('Cognito compensation refuses an identity whose immutable subject changed', async () => {
  const calls = [];
  let address;
  const adapter = createRuntimeDrillAdapter({
    async auditOwnedTask() {},
    async cognitoSend(command) {
      calls.push(command.constructor.name);
      if (command.constructor.name === 'AdminCreateUserCommand') {
        address = command.input.Username;
        return { User: { Username: subject, Attributes: identity(address).UserAttributes } };
      }
      if (command.constructor.name === 'AdminSetUserPasswordCommand') throw new Error('setup failed');
      if (command.constructor.name === 'AdminGetUserCommand') return { ...identity(address),
        UserAttributes: [{ Name: 'email', Value: address }, { Name: 'sub', Value: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }] };
    },
  }, environment);
  await assert.rejects(adapter.createSyntheticAccount({ config: {}, marker: 'drill',
    stack: { userPoolId: 'pool', userPoolClientId: 'client' } }), /setup and compensation failed/);
  assert.ok(!calls.includes('AdminDeleteUserCommand'));
});

function replacementHarness({ failSecondStream = false, failRestoration = false, foreignTask = false } = {}) {
  const apiArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'a'.repeat(32)}`;
  const workerArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${'c'.repeat(32)}`;
  const calls = [];
  let streamCount = 0;
  const io = {
    async aws(args) {
      calls.push(args[1]);
      if (args[0] === 'logs') return { events: [{ logStreamName: `worker/WorkerContainer/${'c'.repeat(32)}`,
        message: JSON.stringify({ taskId: foreignTask ? 'other-task' : 'task', event: 'task_execution_started',
          taskType: 'auto-tagging', resourceId: 'item', executionToken: 1, note: 'task' }) }] };
      if (args[1] === 'describe-services') return { services: [{ desiredCount: 1 }] };
      if (args[1] === 'list-tasks') return { taskArns: args.includes('api') ? [apiArn, `${apiArn}e`] : [workerArn] };
      if (args[1] === 'update-service') throw new Error('replacement failed');
      return {};
    },
    async awsWaitServicesStable() { if (failRestoration) throw new Error('restore failed'); },
    async fetch(url, options) {
      if (url.endsWith('/stream')) {
        if (++streamCount === 2 && failSecondStream) throw new Error('second stream failed');
        options.signal.addEventListener('abort', () => calls.push('abort'));
        return new Response(new ReadableStream({ cancel() { calls.push('cancel'); } }));
      }
      return response(200, { id: 'item', taggingStatus: 'processing', taggingStateVersion: 2 });
    },
  };
  return { calls, adapter: createRuntimeDrillAdapter(io, environment), args: {
    stack: { cluster: 'beta-anywear', apiService: 'api', workerService: 'worker' },
    scope: { marker: 'drill', taskId: 'task', accessToken: 'token', item: { itemId: 'item' },
      config: { serviceUrl: 'https://service.example' } },
  } };
}

test('partially opened SSE streams close before failed construction escapes without mutation', async () => {
  const { adapter, args, calls } = replacementHarness({ failSecondStream: true });
  await assert.rejects(adapter.replaceAndRestoreEcs(args), /second stream failed/);
  assert.ok(calls.includes('abort') && calls.includes('cancel'));
  assert.ok(!calls.includes('stop-task'));
});

test('replacement preserves operation failure and reports both restoration failures', async () => {
  const { adapter, args } = replacementHarness({ failRestoration: true });
  await assert.rejects(adapter.replaceAndRestoreEcs(args), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((entry) => entry.message), ['replacement failed', 'restore failed', 'restore failed']);
    return true;
  });
});

test('foreign structured task logs cannot authorize worker replacement through a text match', async () => {
  const { adapter, args, calls } = replacementHarness({ foreignTask: true });
  await assert.rejects(adapter.replaceAndRestoreEcs(args), /not attributed/);
  assert.ok(!calls.includes('stop-task'));
});

test('missing authoritative audit capability prevents all cloud mutation', async () => {
  const calls = [];
  const adapter = createRuntimeDrillAdapter({ async cognitoSend() { calls.push('cognito'); } }, environment);
  await assert.rejects(adapter.createSyntheticAccount({ config: {}, marker: 'drill', stack: {} }), /before any cloud mutation/);
  assert.deepEqual(calls, []);
});

function retryHarness({ workerReceives = 3, retryable = true, audit = true } = {}) {
  const taskId = '123e4567-e89b-12d3-a456-426614174001';
  const scope = { ...cleanupScope(), stack: { queues: { autoTaggingDlq: 'owned-dlq' } } };
  const failure = { item_id: 'item', task_id: taskId };
  const calls = [];
  const events = [
    { event: 'task_execution_started', resourceId: 'item', executionToken: 3 },
    { event: 'task_sqs_message_received', receiveCount: workerReceives },
    { event: 'task_processing_failed', retryable },
    { event: 'task_db_lease_renewed', databaseLeaseRenewed: true, resourceId: 'item', executionToken: 3 },
    { event: 'task_sqs_visibility_renewed', sqsVisibilityExtended: true },
    { event: 'untrusted-side-effect-claim', noDuplicateSideEffects: true, creditSettlementCount: 0 },
  ];
  const io = {
    async fetch() { return response(200, { id: 'item', taggingStatus: 'failed', taggingStateVersion: 4 }); },
    async aws(args) {
      calls.push(args);
      if (args[0] === 'logs') return { events: events.map((entry) => ({
        timestamp: 1791158400000, logStreamName: `worker/WorkerContainer/${'c'.repeat(32)}`,
        message: JSON.stringify({ taskId, taskType: 'auto-tagging', ...entry }),
      })) };
      if (args[1] === 'get-queue-attributes') return { Attributes: { ApproximateNumberOfMessages: '1' } };
      if (args[1] === 'receive-message') return { Messages: [{ MessageId: 'owned-message',
        ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '99' }, Body: JSON.stringify({ task_id: taskId }) }] };
      return {};
    },
  };
  let audits = 0;
  io.sleep = async () => {};
  if (audit) io.auditOwnedTask = async ({ request }) => auditFixture(request,
    { status: 'failed', token: 3, version: 4, after: audits++ > 0 });
  return { adapter: createRuntimeDrillAdapter(io, environment), args: { scope, failure }, calls };
}

test('retry evidence uses canonical worker receipt counts, never observer DLQ counts', async () => {
  const { adapter, args, calls } = retryHarness({ workerReceives: 2 });
  await assert.rejects(adapter.collectRetryEvidence(args), /bounded retries/);
  assert.ok(calls.filter((entry) => entry[1] === 'receive-message').every((entry) => entry.includes('owned-dlq')));
});

test('retry evidence refuses non-retryable canonical failures and log-only settlement claims', async () => {
  const nonRetryable = retryHarness({ retryable: false });
  await assert.rejects(nonRetryable.adapter.collectRetryEvidence(nonRetryable.args), /bounded retries/);
  const noAudit = retryHarness({ audit: false });
  await assert.rejects(noAudit.adapter.collectRetryEvidence(noAudit.args), /authoritative run-owned durable task audit/);
});
