import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareNonPaidRuntime, restoreNonPaidRuntime, switchNonPaidMode } from './nonpaid-runtime-controls.mjs';
import { auditRequest, assertStableAudits, extractAuditLog, extractAuditTaskBinding,
  TERMINAL_STABILITY_MS, validateTaskAudit } from './runtime-task-audit.mjs';
import { cleanupOneShotDefinitions, runOwnedOneShot } from './runtime-one-shot.mjs';
import { pauseRuntimeWindow, restoreRuntimeWindow } from './runtime-window-controls.mjs';
import { recoverRuntimeRecord } from './runtime-recovery.mjs';
import { assertLiveRuntimeSourceReady } from './runtime-source-readiness.mjs';
import {
  AdminConfirmSignUpCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const exec = promisify(execFile);
const RUN_SCOPE_PATTERN = /^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$/;
const SUBJECT_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EMAIL_PATTERN = /^e2e-beta-([1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16})-0-([a-f0-9]{8})@anywear\.local$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TASK_ARN_PATTERN = /^arn:aws:ecs:[^:]+:\d+:task\/[^/]+\/[0-9a-f-]+$/;
const DEFAULT_PASSWORD = 'TestPassword123!';
const API_LOG_GROUP = '/anywear/beta/api';
const WORKER_LOG_GROUP = '/anywear/beta/worker';

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedRunScope(environment) {
  const value = required(environment.RUNTIME_DRILL_RUN_SCOPE, 'RUNTIME_DRILL_RUN_SCOPE');
  if (!RUN_SCOPE_PATTERN.test(value)) throw new Error('RUNTIME_DRILL_RUN_SCOPE is not bounded');
  return value;
}

function requestId(marker) { return marker ? `${marker}-${randomUUID()}` : randomUUID(); }

function jsonHeaders(token, request) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${required(token, 'access token')}`,
    'Content-Type': 'application/json',
    'X-Request-ID': request,
  };
}

function parseJson(text, label) {
  try { return text ? JSON.parse(text) : {}; }
  catch (error) { throw new Error(`${label} returned invalid JSON`, { cause: error }); }
}

async function responseJson(response, label) {
  const text = await response.text();
  const body = parseJson(text, label);
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 500)}`);
  return body;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function liveAws(args) {
  try {
    const { stdout } = await exec('aws', [...args, '--output', 'json'], { maxBuffer: 20 * 1024 * 1024 });
    return parseJson(stdout.trim(), `aws ${args[0]} ${args[1]}`);
  } catch (error) {
    if (args[0] === 's3api' && args[1] === 'head-object' && /Not Found|404/.test(error.stderr ?? '')) {
      // eslint-disable-next-line preserve-caught-error -- AWS errors may embed sensitive task-definition argv.
      throw new Error('Not Found');
    }
    // Task-definition input can contain baseline environment values; never print argv/stderr.
    // eslint-disable-next-line preserve-caught-error -- Do not retain unredacted AWS argv/stderr in recovery failures.
    throw new Error(`AWS operation failed: ${args[0]} ${args[1]}`);
  }
}

function liveIo(environment) {
  const cognito = new CognitoIdentityProviderClient({ region: environment.AWS_REGION ?? 'ap-east-1' });
  let snapshotNumber = 0;
  const runner = async ({ scope, purpose, action, payload, onLine }) => {
    assertLiveRuntimeSourceReady();
    const checkout = required(environment.E2E_SERVICE_CHECKOUT, 'E2E_SERVICE_CHECKOUT');
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['.github/scripts/run-one-shot-task.sh', 'beta', purpose,
        scope.deployment.service.image_digest, scope.deployment.service.source_commit, action, payload],
      { cwd: path.resolve(checkout), env: { ...environment, RUNTIME_DRILL_RUN_SCOPE: scope.runScope }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let buffered = '';
      let lines = Promise.resolve();
      const timer = setTimeout(() => child.kill(), 600_000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        buffered += chunk.toString();
        const complete = buffered.split(/\r?\n/);
        buffered = complete.pop();
        for (const line of complete) lines = lines.then(() => onLine(line));
        if (stdout.length > 2 * 1024 * 1024) child.kill();
      });
      child.stderr.resume();
      child.on('error', () => { clearTimeout(timer); reject(new Error(`One-shot ${purpose} could not start`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        lines.then(() => code === 0 ? resolve({ stdout }) : reject(new Error(`One-shot ${purpose} failed; owned recovery metadata retained`)), reject);
      });
    });
  };
  const io = {
    async aws(args) {
      if (['register-task-definition', 'deregister-task-definition', 'update-service', 'stop-task',
        'receive-message', 'change-message-visibility', 'delete-object'].includes(args[1])) assertLiveRuntimeSourceReady();
      return liveAws(args);
    },
    async fetch(url, options) { return fetch(url, options); },
    async sleep(ms) { await delay(ms); },
    async cognitoSend(command) { assertLiveRuntimeSourceReady(); return cognito.send(command); },
    async saveRecovery(scope) {
      const recoveryPath = environment.RUNTIME_DRILL_RECOVERY_PATH ?? 'runtime-drill-recovery.json';
      await writeFile(recoveryPath, `${JSON.stringify({
        schema_version: 2, record_type: 'anywear_beta_runtime_recovery', stage: 'beta',
        aws_account_id: '650880818323', aws_region: 'ap-east-1',
        run_scope: scope.runScope, marker: scope.marker, user_pool_id: scope.userPoolId,
        users: [{ email: scope.email, sub: scope.subject, username: scope.cognitoUsername }],
        items: scope.items ?? [], resources: scope.resources ?? [],
        runtime_control: scope.runtimeControl, known_dlq_message: scope.knownDLQMessageId,
        owned_cleanup_completed: scope.ownedCleanupCompleted === true,
        runtime_window: scope.runtimeWindow, one_shots: scope.oneShots ?? [],
        stack: scope.stack, service_url: scope.config.serviceUrl, deployment: scope.deployment,
        database_cleanup_completed: scope.databaseCleanupCompleted === true, cleanup_evidence: scope.cleanupEvidence,
      }, null, 2)}\n`, { mode: 0o600 });
      if (environment.GITHUB_ACTIONS === 'true') {
        if (++snapshotNumber > 150) throw new Error('Runtime recovery snapshot budget exhausted');
        const { DefaultArtifactClient } = await import('@actions/artifact');
        await new DefaultArtifactClient().uploadArtifact(
          `beta-runtime-recovery-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-${String(snapshotNumber).padStart(3, '0')}`,
          [path.resolve(recoveryPath)], path.dirname(path.resolve(recoveryPath)), { retentionDays: 90 });
      }
    },
    async runOneShotCleanup({ scope, payload }) {
      return runOwnedOneShot(io, scope, 'tester-cleanup', '', payload, runner);
    },
    async runLifecycle({ scope, action, payload }) {
      return runOwnedOneShot(io, scope, 'lifecycle', action, payload, runner);
    },
    async auditRuntimeWindow(args) {
      return io.auditOwnedTask(args);
    },
    async auditOwnedTask({ scope, request }) {
      const { stdout } = await runOwnedOneShot(io, scope, 'task-audit', '', JSON.stringify(request), runner);
      const binding = extractAuditTaskBinding(stdout);
      const events = [];
      let token;
      for (let page = 0; page < 20; page += 1) {
        const response = await liveAws(['logs', 'get-log-events', '--log-group-name', binding.logGroup,
          '--log-stream-name', binding.logStream, '--start-from-head', ...(token ? ['--next-token', token] : [])]);
        events.push(...(response.events ?? []));
        if (response.nextForwardToken === token || !response.nextForwardToken) {
          const data = request.mode === 'window-preflight' ? events.flatMap((event) => {
            try { const parsed = JSON.parse(event.message); return parsed.source === 'durable-runtime-window-audit' ? [parsed] : []; }
            catch { return []; }
          }) : [extractAuditLog(events, request)];
          if (data.length !== 1) throw new Error('Exact one-shot stream did not contain one window audit');
          return { ...data[0], extraction: { task_arn: binding.taskArn,
            log_group: binding.logGroup, log_stream: binding.logStream, exit_code: 0 } };
        }
        token = response.nextForwardToken;
      }
      throw new Error('One-shot audit log pagination was incomplete');
    },
    async close() { cognito.destroy(); },
  };
  return io;
}

function ensureTaskArns(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((arn) => !TASK_ARN_PATTERN.test(arn))) {
    throw new Error(`${label} must contain ECS task ARNs`);
  }
  return [...new Set(value)];
}

function assertOwnedIdentity(identity, runScope) {
  const match = EMAIL_PATTERN.exec(identity?.email ?? '');
  if (!match || match[1] !== runScope || !SUBJECT_PATTERN.test(identity?.subject ?? '')) {
    throw new Error('Runtime cleanup refused an identity outside the current run scope');
  }
}

function assertExactObject(object, bucket) {
  if (!object || object.bucket !== bucket || typeof object.key !== 'string' || object.key.length === 0
    || object.key.startsWith('/') || object.key.includes('..') || object.key.includes('\\')) {
    throw new Error('Runtime cleanup requires an exact owned S3 object key');
  }
}

async function serviceRequest(io, baseUrl, method, pathname, token, body, headers = {}) {
  const id = headers['X-Request-ID'] ?? requestId();
  const response = await io.fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { ...jsonHeaders(token, id), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { id, body: await responseJson(response, `${method} ${pathname}`), response };
}

async function uploadItem(io, scope, fixturePath, marker) {
  const { serviceUrl } = scope.config;
  const uploadUrl = await serviceRequest(io, serviceUrl, 'POST', '/wardrobe/upload-url', scope.accessToken,
    { contentType: 'image/png', extension: 'png' }, { 'X-Request-ID': requestId(marker) });
  const target = asObject(uploadUrl.body, 'upload-url response');
  required(target.itemId, 'upload itemId');
  required(target.key, 'upload S3 key');
  required(target.url, 'upload URL');
  if (!/^[0-9a-f-]{36}$/i.test(target.itemId) || !target.key.includes(scope.subject)) {
    throw new Error('Upload response does not expose an exact owned item/object');
  }
  scope.items ??= [];
  scope.items.push(target.itemId);
  scope.resources.push({ bucket: scope.stack.bucket, key: target.key });
  if (io.saveRecovery) await io.saveRecovery(scope);
  const image = await readFile(fixturePath);
  const putResponse = await io.fetch(target.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: image,
    signal: AbortSignal.timeout(30_000) });
  if (!putResponse.ok) throw new Error(`S3 upload failed (${putResponse.status})`);
  const idempotencyKey = randomUUID();
  const accepted = await serviceRequest(io, serviceUrl, 'POST', '/wardrobe/upload', scope.accessToken,
    { itemId: target.itemId }, { 'Idempotency-Key': idempotencyKey, 'X-Request-ID': requestId(marker) });
  if (accepted.response.status !== 202 || accepted.body.itemId !== target.itemId) {
    throw new Error('Wardrobe upload did not return the expected accepted task');
  }
  return {
    itemId: target.itemId,
    key: target.key,
    idempotencyKey,
    accepted: accepted.body,
    requestIds: { uploadUrl: uploadUrl.id, accepted: accepted.id },
    marker,
  };
}

async function pollItem(io, scope, itemId, { terminal = false, timeoutMs = 180_000, cleanup = false } = {}) {
  const started = Date.now();
  let state;
  const versions = [];
  while (Date.now() - started < timeoutMs) {
    const id = requestId(scope.marker);
    const response = await io.fetch(`${scope.config.serviceUrl}/wardrobe/items/${itemId}`, {
      method: 'GET', headers: jsonHeaders(scope.accessToken, id), signal: AbortSignal.timeout(30_000),
    });
    if (cleanup && response.status === 404) return { absent: true, versions, requestId: id };
    const result = { id, body: await responseJson(response, `GET /wardrobe/items/${itemId}`) };
    state = asObject(result.body, 'wardrobe item response');
    const minimumVersion = cleanup && state.taggingStatus === 'uploading' ? 0 : 1;
    if (state.id !== itemId || !Number.isInteger(state.taggingStateVersion) || state.taggingStateVersion < minimumVersion
      || !['uploading', 'processing', 'ready', 'failed'].includes(state.taggingStatus)) {
      throw new Error('Wardrobe response does not match the item/state-version contract');
    }
    versions.push(state.taggingStateVersion);
    if (!terminal || ['ready', 'failed'].includes(state.taggingStatus)) {
      return { state, versions, requestId: result.id };
    }
    await io.sleep(2_000);
  }
  throw new Error(`Wardrobe item ${itemId} did not reach a terminal state within ${timeoutMs}ms`);
}

async function describeTasks(io, stack, service, desired) {
  const serviceResult = await io.aws(['ecs', 'describe-services', '--cluster', stack.cluster, '--services', service]);
  const record = serviceResult.services?.[0];
  if (!record) throw new Error(`ECS service ${service} was not found`);
  if (desired !== undefined && record.desiredCount !== desired) {
    throw new Error(`ECS service ${service} desired count changed unexpectedly`);
  }
  const listed = await io.aws(['ecs', 'list-tasks', '--cluster', stack.cluster, '--service-name', service, '--desired-status', 'RUNNING']);
  return { desiredCount: record.desiredCount, taskArns: ensureTaskArns(listed.taskArns ?? [], `${service} running tasks`) };
}

async function waitServiceStable(io, stack, service) {
  if (io.awsWaitServicesStable) return io.awsWaitServicesStable(stack.cluster, service);
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const result = await io.aws(['ecs', 'describe-services', '--cluster', stack.cluster, '--services', service]);
    const record = result.services?.[0];
    if (record && record.runningCount === record.desiredCount && record.pendingCount === 0
      && record.deployments?.every((deployment) => deployment.rolloutState === undefined || deployment.rolloutState === 'COMPLETED')) return record;
    await io.sleep(5_000);
  }
  throw new Error(`ECS service ${service} did not become stable`);
}

async function openStream(io, scope, itemId) {
  const id = requestId(scope.marker);
  const controller = new AbortController();
  let response;
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    response = await io.fetch(`${scope.config.serviceUrl}/wardrobe/items/${itemId}/stream`, {
      headers: { Authorization: `Bearer ${scope.accessToken}`, Accept: 'text/event-stream', 'X-Request-ID': id },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE stream failed (${response.status})`);
    return { id, response, controller };
  } catch (error) {
    controller.abort();
    if (response?.body) await closeStream({ response, controller });
    throw error;
  } finally { clearTimeout(timer); }
}

async function closeStream(stream) {
  stream.controller?.abort();
  try { await stream.response.body?.cancel(); } catch { /* best effort after replacement */ }
}

async function readTerminalStream(stream) {
  let timer;
  try {
    const body = await Promise.race([
      stream.response.text(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE terminal observation timed out')), 15_000); }),
    ]);
    const snapshots = String(body).split(/\r?\n\r?\n/).flatMap((frame) => {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    const terminal = snapshots.find((snapshot) => ['ready', 'failed'].includes(snapshot.tagging_status)
      && Number.isInteger(snapshot.state_version) && snapshot.state_version > 0);
    if (!terminal) throw new Error('SSE stream did not deliver a terminal wardrobe snapshot');
    return { status: terminal.tagging_status, version: terminal.state_version };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createSyntheticAccount({ config, marker, stack }, io, environment) {
  if (typeof io.auditOwnedTask !== 'function') {
    throw new Error('Runtime execution requires a reviewed authoritative task audit before any cloud mutation');
  }
  const runScope = boundedRunScope(environment);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const email = `e2e-beta-${runScope}-0-${suffix}@anywear.local`;
  const password = environment.RUNTIME_DRILL_PASSWORD ?? DEFAULT_PASSWORD;
  const userPoolId = required(stack?.userPoolId ?? environment.USER_POOL_ID, 'Cognito user pool id');
  const clientId = required(stack?.userPoolClientId ?? environment.VITE_COGNITO_CLIENT_ID, 'Cognito user pool client id');
  let created = false;
  let capturedSubject;
  let capturedUsername;
  try {
    const createdUser = await io.cognitoSend(new AdminCreateUserCommand({
      UserPoolId: userPoolId, Username: email, MessageAction: 'SUPPRESS',
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'custom:e2e_bootstrap', Value: 'true' }],
    }));
    created = true;
    const createdAttributes = Object.fromEntries((createdUser.User?.Attributes ?? []).map(({ Name, Value }) => [Name, Value]));
    capturedSubject = createdAttributes.sub;
    capturedUsername = createdUser.User?.Username;
    if (io.saveRecovery) await io.saveRecovery({ config, marker, runScope, stack, email,
      subject: capturedSubject, cognitoUsername: capturedUsername, userPoolId });
    if (createdAttributes.email !== email || !SUBJECT_PATTERN.test(capturedSubject ?? '') || !capturedUsername) {
      throw new Error('Cognito creation did not capture an immutable owned identity');
    }
    await io.cognitoSend(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: capturedUsername, Password: password, Permanent: true }));
    try { await io.cognitoSend(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: capturedUsername })); } catch (error) {
      if (!/NotAuthorizedException|already confirmed/i.test(error?.name ?? error?.message ?? '')) throw error;
    }
    const user = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: capturedUsername }));
    const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (attributes.email !== email || attributes.sub !== capturedSubject || user.Username !== capturedUsername) {
      throw new Error('Cognito synthetic identity changed after creation');
    }
    const auth = await io.cognitoSend(new InitiateAuthCommand({
      ClientId: clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: capturedUsername, PASSWORD: password },
    }));
    const accessToken = auth.AuthenticationResult?.AccessToken;
    required(accessToken, 'Cognito access token');
    const scope = {
      config, marker, runScope, stack, accessToken, password,
      email, subject: attributes.sub, cognitoUsername: capturedUsername, resources: [], requestIds: [],
      userPoolId, userPoolClientId: clientId,
    };
    if (io.saveRecovery) await io.saveRecovery(scope);
    return scope;
  } catch (error) {
    if (created) {
      try {
        if (!capturedSubject || !capturedUsername) throw new Error('Cognito compensation has no captured immutable identity', { cause: error });
        const user = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: capturedUsername }));
        const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
        if (attributes.email !== email || attributes.sub !== capturedSubject || user.Username !== capturedUsername) {
          throw new Error('Cognito compensation ownership check failed', { cause: error });
        }
        await io.cognitoSend(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: capturedUsername }));
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Synthetic Cognito account setup and compensation failed', { cause: cleanupError });
      }
    }
    throw error;
  }
}

async function runWardrobeApiFlow({ scope, marker }, io, environment) {
  const profile = await serviceRequest(io, scope.config.serviceUrl, 'GET', '/users/me', scope.accessToken, undefined,
    { 'X-Request-ID': requestId(marker) });
  if (profile.body?.id !== scope.subject || profile.body?.email !== scope.email) {
    throw new Error('Service profile bootstrap did not return the captured Cognito subject');
  }
  const fixture = environment.RUNTIME_DRILL_SUCCESS_FIXTURE ?? 'tests/fixtures/dummy.png';
  const details = await uploadItem(io, scope, fixture, marker);
  scope.item = details;
  const initial = await pollItem(io, scope, details.itemId, { timeoutMs: 15_000 });
  if (initial.state.taggingStatus !== 'processing') {
    throw new Error(`Accepted wardrobe task reached ${initial.state.taggingStatus} before replacement; restart evidence refused`);
  }
  scope.taskId = await findTaskIdForItem(io, details.itemId);
  const execution = await exactExecution(io, scope.taskId, details.itemId);
  scope.initialExecutionToken = execution.parsed.executionToken;
  scope.stateVersions = initial.versions;
  return {
    task_id: scope.taskId,
    api_restart: false,
    worker_restart: false,
    rolling_deployment: false,
    idempotency_replay_same_response: false,
    state_versions: initial.versions,
    api_task_arns: [],
    worker_task_arns: [],
    terminal_status: initial.state.taggingStatus,
    accepted: details.accepted,
    request_ids: details.requestIds,
  };
}

async function replaceAndRestoreEcs({ stack, scope }, io) {
  const apiBefore = await describeTasks(io, stack, stack.apiService);
  const workerBefore = await describeTasks(io, stack, stack.workerService);
  if (apiBefore.taskArns.length < 2) throw new Error('Runtime drill requires at least two API replicas before SSE observation');
  const executionLogs = await logsForTask(io, scope.taskId);
  const executionStreams = executionLogs.filter((entry) => entry.parsed?.event === 'task_execution_started'
    && entry.parsed?.taskType === 'auto-tagging' && entry.parsed?.resourceId === scope.item.itemId
    && Number.isInteger(entry.parsed.executionToken) && entry.parsed.executionToken > 0);
  const workerToStop = workerBefore.taskArns.find((arn) => executionStreams.some((entry) =>
    entry.logStreamName?.endsWith(`/${arn.split('/').at(-1)}`)));
  if (!workerToStop) throw new Error('Active task is not attributed to a current worker ECS task; mutation refused');
  const beforeToken = Math.max(...executionStreams.map((entry) => entry.parsed.executionToken));
  scope.initialExecutionToken = beforeToken;
  const active = await pollItem(io, scope, scope.item.itemId, { timeoutMs: 15_000 });
  if (active.state.taggingStatus !== 'processing') throw new Error('Task is no longer processing; ECS mutation refused');
  const streams = [];
  try {
    streams.push(await openStream(io, scope, scope.item.itemId));
    streams.push(await openStream(io, scope, scope.item.itemId));
  } catch (error) {
    await Promise.all(streams.map(closeStream));
    throw error;
  }
  scope.replacement = { streams, streamRequestIds: streams.map(({ id }) => id) };
  let apiAfter;
  let workerAfter;
  let reconnected = [];
  let operationError;
  let restorationErrors;
  let result;
  try {
    await io.aws(['ecs', 'stop-task', '--cluster', stack.cluster, '--task', workerToStop, '--reason', 'beta runtime drill controlled replacement']);
    await io.aws(['ecs', 'update-service', '--cluster', stack.cluster, '--service', stack.apiService, '--force-new-deployment']);
    await waitServiceStable(io, stack, stack.apiService);
    await waitServiceStable(io, stack, stack.workerService);
    apiAfter = await describeTasks(io, stack, stack.apiService);
    workerAfter = await describeTasks(io, stack, stack.workerService);
    const apiChanged = apiAfter.taskArns.some((arn) => !apiBefore.taskArns.includes(arn));
    const workerChanged = workerAfter.taskArns.some((arn) => !workerBefore.taskArns.includes(arn));
    if (!apiChanged || !workerChanged) throw new Error('ECS replacement did not produce a changed API and worker task set');
    const replay = await serviceRequest(io, scope.config.serviceUrl, 'POST', '/wardrobe/upload', scope.accessToken,
      { itemId: scope.item.itemId }, { 'Idempotency-Key': scope.item.idempotencyKey, 'X-Request-ID': requestId(scope.marker) });
    if (replay.response.status !== 202 || JSON.stringify(replay.body) !== JSON.stringify(scope.item.accepted)) {
      throw new Error('Idempotency replay did not return the original accepted response');
    }
    const terminal = await pollItem(io, scope, scope.item.itemId, { terminal: true });
    if (terminal.state.taggingStatus !== 'ready') throw new Error('Non-paid success fixture did not reach ready');
    const stable = await observeTerminalStability(io, scope, scope.item, scope.taskId, terminal.state);
    const finalToken = stable.after.task.execution_token;
    if (finalToken < beforeToken) throw new Error('Final task execution token regressed');
    const completionLogs = await logsForTask(io, scope.taskId);
    if (!completionLogs.some((entry) => entry.parsed.event === 'task_execution_started'
      && entry.parsed.resourceId === scope.item.itemId && entry.parsed.executionToken === finalToken)) {
      throw new Error('Final execution token has no exact canonical worker claim event');
    }
    reconnected.push(await openStream(io, scope, scope.item.itemId));
    reconnected.push(await openStream(io, scope, scope.item.itemId));
    const terminalObservers = await Promise.all(reconnected.map(readTerminalStream));
    if (terminalObservers.some((observer) => observer.status !== terminal.state.taggingStatus
      || observer.version !== terminal.state.taggingStateVersion)) {
      throw new Error('SSE observers did not deliver the same terminal state/version as the database snapshot');
    }
    scope.replacement.reconnectedRequestIds = reconnected.map(({ id }) => id);
    const versions = [...(scope.stateVersions ?? []), ...terminal.versions];
    scope.stateVersions = versions;
    result = {
      restart_evidence: {
        task_id: scope.taskId,
        api_restart: apiChanged,
        worker_restart: workerChanged,
        rolling_deployment: apiChanged && workerChanged,
        idempotency_replay_same_response: true,
        terminal_snapshot_stable: true,
        execution_token_before: beforeToken,
        execution_token_after: finalToken,
        recovery_kind: finalToken === beforeToken ? 'graceful-drain' : 'takeover',
        terminal_audit: stable,
        credit: { applicability: 'not-applicable', reason: 'auto-tagging' },
        state_versions: versions,
        api_task_arns: [...new Set([...apiBefore.taskArns, ...apiAfter.taskArns])],
        worker_task_arns: [...new Set([...workerBefore.taskArns, ...workerAfter.taskArns])],
        terminal_status: terminal.state.taggingStatus,
      },
      api_task_arns_before: apiBefore.taskArns,
      api_task_arns_after: apiAfter.taskArns,
      worker_task_arns_before: workerBefore.taskArns,
      worker_task_arns_after: workerAfter.taskArns,
      stream_request_ids: scope.replacement.streamRequestIds,
      reconnected_request_ids: scope.replacement.reconnectedRequestIds,
      terminal_observers: terminalObservers,
    };
  } catch (error) {
    operationError = error;
  } finally {
    await Promise.all(streams.map(closeStream));
    await Promise.all(reconnected.map(closeStream));
    const restored = await Promise.allSettled([
      waitServiceStable(io, stack, stack.apiService), waitServiceStable(io, stack, stack.workerService),
    ]);
    restorationErrors = restored.filter((result) => result.status === 'rejected').map((result) => result.reason);
  }
  if (restorationErrors.length) throw new AggregateError([...(operationError ? [operationError] : []), ...restorationErrors],
    'Runtime replacement restoration did not reach stable API and worker services');
  if (operationError) throw operationError;
  return result;
}

async function logsForRequest(io, group, request) {
  const result = await io.aws(['logs', 'filter-log-events', '--log-group-name', group, '--filter-pattern', request]);
  return (result.events ?? []).map((event) => {
    try { return { ...event, parsed: JSON.parse(event.message ?? '') }; } catch { return { ...event, parsed: undefined }; }
  })
    .filter((event) => event.parsed?.reqId === request || event.parsed?.requestId === request);
}

async function captureReplicaAttribution({ scope, replacement }, io) {
  const requestIds = [
    ...(replacement?.stream_request_ids ?? replacement?.streamRequestIds ?? []),
    ...(replacement?.reconnected_request_ids ?? []),
  ];
  if (!Array.isArray(requestIds) || requestIds.length < 4 || new Set(requestIds).size < 4) throw new Error('Replica attribution requires four unique SSE request IDs across replacement phases');
  const events = await Promise.all(requestIds.map((id) => logsForRequest(io, API_LOG_GROUP, id)));
  if (events.some((entry) => entry.length === 0)) throw new Error('Replica attribution found no exact request-id API log event');
  const streamTaskArns = [];
  for (const requestEvents of events) {
    const stream = requestEvents.map((event) => event.logStreamName).find(Boolean);
    const taskId = stream?.match(/(?:^|\/)([0-9a-f]{32})$/)?.[1];
    if (!taskId) throw new Error('Replica attribution could not derive a task id from the API log stream');
    const described = await io.aws(['ecs', 'describe-tasks', '--cluster', scope.stack.cluster, '--tasks', taskId]);
    const task = described.tasks?.[0];
    if (!task?.taskArn) throw new Error('Replica attribution task lookup was not exact');
    streamTaskArns.push(task.taskArn);
  }
  const apiTaskArns = [...new Set([...(replacement.api_task_arns_before ?? []), ...(replacement.api_task_arns_after ?? []), ...streamTaskArns])];
  ensureTaskArns(streamTaskArns, 'stream_task_arns');
  const reconnectTaskArns = streamTaskArns.slice(requestIds.length - (replacement.reconnected_request_ids ?? []).length);
  if (new Set(reconnectTaskArns).size < 2) throw new Error('Replica attribution requires two distinct ECS task ARNs in the post-replacement observer phase');
  const reconnectIds = replacement.reconnected_request_ids ?? [];
  const reconnectEvents = await Promise.all(reconnectIds.map((id) => logsForRequest(io, API_LOG_GROUP, id)));
  if (reconnectIds.length < 2 || reconnectEvents.some((entry) => entry.length === 0)) throw new Error('Replica attribution could not prove two post-replacement reconnects');
  return {
    api_task_arns: ensureTaskArns(apiTaskArns, 'api_task_arns'),
    stream_task_arns: [...new Set(streamTaskArns)],
    request_attribution: requestIds.map((id, index) => ({ request_id: id, task_arn: streamTaskArns[index] })),
    terminal_observers: replacement.terminal_observers,
    distinct_replica_logs: true,
    reconnected_after_replacement: true,
    both_observers_terminal: Array.isArray(replacement.terminal_observers) && replacement.terminal_observers.length === 2
      && replacement.terminal_observers.every((observer) => ['ready', 'failed'].includes(observer.status)
        && Number.isInteger(observer.version) && observer.version > 0),
    monotonic_state_versions: Array.isArray(scope.stateVersions) && scope.stateVersions.every((version, index, values) => index === 0 || version >= values[index - 1]),
  };
}

async function runProviderFailureFixture({ scope, fixture, marker }, io) {
  asObject(fixture, 'provider failure fixture');
  if (fixture.application_backdoor !== false || fixture.approved !== true || fixture.source !== 'beta-provider-nonpaid-loopback') {
    throw new Error('Provider failure fixture is not the approved non-paid loopback fixture');
  }
  await switchNonPaidMode(scope, 'failure', io, waitServiceStable);
  if (!fixture.image_path.startsWith('tests/fixtures/') || fixture.image_path.includes('..')) throw new Error('Provider failure fixture image path is not checked in');
  await stat(fixture.image_path);
  const details = await uploadItem(io, scope, fixture.image_path, marker);
  details.taskId = await findTaskIdForItem(io, details.itemId);
  scope.failure = details;
  return { item_id: details.itemId, task_id: details.taskId, key: details.key, request_ids: details.requestIds, idempotency_key: details.idempotencyKey };
}

async function inspectQueue(io, queueUrl, taskId) {
  if (!queueUrl) throw new Error('Retry evidence requires both main and DLQ queue URLs');
  const result = await io.aws(['sqs', 'receive-message', '--queue-url', queueUrl, '--max-number-of-messages', '10', '--visibility-timeout', '1', '--attribute-names', 'All', '--message-attribute-names', 'All']);
  const messages = result.Messages ?? [];
  const matches = [];
  for (const message of messages) {
    let body;
    try { body = JSON.parse(message.Body ?? ''); } catch { body = undefined; }
    const bodyTaskId = body?.task_id ?? body?.taskId ?? body?.payload?.task_id;
    if (bodyTaskId === taskId) matches.push({ ...message, body });
    else if (message.ReceiptHandle) {
      await io.aws(['sqs', 'change-message-visibility', '--queue-url', queueUrl,
        '--receipt-handle', message.ReceiptHandle, '--visibility-timeout', '0']);
    }
  }
  return matches;
}

async function logsForTask(io, taskId) {
  const events = [];
  let token;
  for (let page = 0; page < 20; page += 1) {
    const result = await io.aws(['logs', 'filter-log-events', '--log-group-name', WORKER_LOG_GROUP, '--filter-pattern', taskId,
      ...(token ? ['--next-token', token] : [])]);
    events.push(...(result.events ?? []));
    if (!result.nextToken) break;
    if (page === 19 || result.nextToken === token) throw new Error('Canonical worker log pagination incomplete');
    token = result.nextToken;
  }
  return events.map((event) => {
    let parsed;
    try { parsed = JSON.parse(event.message ?? ''); } catch { parsed = {}; }
    return { ...event, parsed };
  }).filter((event) => event.parsed?.taskId === taskId && event.parsed?.taskType === 'auto-tagging');
}

async function logsForItem(io, itemId) {
  const result = await io.aws(['logs', 'filter-log-events', '--log-group-name', WORKER_LOG_GROUP, '--filter-pattern', itemId]);
  return (result.events ?? []).map((event) => {
    let parsed;
    try { parsed = JSON.parse(event.message ?? ''); } catch { parsed = {}; }
    return { ...event, parsed };
  }).filter((event) => event.parsed?.event === 'task_execution_started'
    && event.parsed?.taskType === 'auto-tagging' && event.parsed?.resourceId === itemId);
}

async function findTaskIdForItem(io, itemId, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const events = await logsForItem(io, itemId);
    const taskIds = [...new Set(events.flatMap((event) => {
      const value = event.parsed?.taskId ?? event.parsed?.task_id;
      return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? [value] : [];
    }))];
    if (taskIds.length === 1) return taskIds[0];
    await io.sleep(2_000);
  }
  throw new Error(`Worker CloudWatch logs did not expose an exact task id for item ${itemId}`);
}

async function exactExecution(io, taskId, itemId) {
  const entries = (await logsForTask(io, taskId)).filter((entry) => entry.parsed.event === 'task_execution_started'
    && entry.parsed.resourceId === itemId && Number.isInteger(entry.parsed.executionToken) && entry.parsed.executionToken > 0);
  if (!entries.length) throw new Error('Canonical worker logs did not expose an exact task/resource/execution token');
  return entries.sort((a, b) => b.parsed.executionToken - a.parsed.executionToken)[0];
}

async function observeTerminalStability(io, scope, details, taskId, state) {
  if (typeof io.auditOwnedTask !== 'function') throw new Error('Runtime evidence requires an authoritative run-owned durable task audit');
  const request = auditRequest(scope, details, taskId);
  const before = validateTaskAudit(await io.auditOwnedTask({ scope, request }), request, state.taggingStatus);
  if (before.resource.state_version !== state.taggingStateVersion) throw new Error('API/audit state versions disagree');
  await io.sleep(TERMINAL_STABILITY_MS);
  const after = validateTaskAudit(await io.auditOwnedTask({ scope, request }), request, state.taggingStatus);
  return assertStableAudits(before, after);
}

async function collectRetryEvidence({ scope, failure }, io) {
  const terminal = await pollItem(io, scope, failure.item_id, { terminal: true, timeoutMs: 600_000 });
  if (terminal.state.taggingStatus !== 'failed') throw new Error('Provider failure fixture did not reach terminal failed state');
  const started = Date.now();
  let visible = false;
  while (Date.now() - started < 600_000) {
    const queue = await io.aws(['sqs', 'get-queue-attributes', '--queue-url', scope.stack.queues.autoTaggingDlq,
      '--attribute-names', 'ApproximateNumberOfMessages']);
    if (Number(queue.Attributes?.ApproximateNumberOfMessages) > 0) { visible = true; break; }
    await io.sleep(2_000);
  }
  if (!visible) throw new Error('No visible Beta auto-tagging DLQ payload appeared within the evidence window');
  const workerEvents = await logsForTask(io, failure.task_id);
  const dlqMessages = await inspectQueue(io, scope.stack.queues.autoTaggingDlq, failure.task_id);
  const receiveCounts = workerEvents.filter((event) => event.parsed?.event === 'task_sqs_message_received')
    .map((event) => Number(event.parsed.receiveCount)).filter((count) => Number.isInteger(count) && count >= 1);
  const receiveCount = Math.max(0, ...receiveCounts);
  const retryableFailures = workerEvents.filter((event) => event.parsed?.event === 'task_processing_failed'
    && event.parsed?.retryable === true).length;
  const claims = workerEvents.filter((entry) => entry.parsed.event === 'task_execution_started'
    && entry.parsed.resourceId === failure.item_id && Number.isInteger(entry.parsed.executionToken)
    && entry.parsed.executionToken > 0 && /^[^\n]+\/[a-f0-9]{32}$/.test(entry.logStreamName ?? '')
    && Number.isFinite(entry.timestamp));
  const databaseLeaseRenewed = workerEvents.some((event) => event.parsed?.event === 'task_db_lease_renewed'
    && event.parsed?.databaseLeaseRenewed === true && event.parsed.resourceId === failure.item_id
    && claims.some((claim) => claim.parsed.executionToken === event.parsed.executionToken
      && claim.logStreamName === event.logStreamName && event.timestamp >= claim.timestamp));
  const sqsVisibilityExtended = workerEvents.some((event) => event.parsed?.event === 'task_sqs_visibility_renewed'
    && event.parsed?.sqsVisibilityExtended === true && claims.some((claim) => claim.logStreamName === event.logStreamName
      && event.timestamp >= claim.timestamp));
  const uniqueDlq = [...new Map(dlqMessages.map((message) => [message.MessageId, message])).values()];
  const dlq = uniqueDlq.find((message) => message.body?.task_id === failure.task_id);
  if (uniqueDlq.length > 1) throw new Error('DLQ observation found duplicate matching task messages');
  if (!dlq) throw new Error('Matching task was not observed in the Beta auto-tagging DLQ');
  scope.knownDLQMessageId = { taskId: failure.task_id, messageId: dlq.MessageId };
  if (io.saveRecovery) await io.saveRecovery(scope);
  if (!databaseLeaseRenewed || !sqsVisibilityExtended) {
    throw new Error('Worker CloudWatch logs do not prove successful database lease and SQS visibility renewal; runtime evidence refused');
  }
  if (receiveCount < 3 || retryableFailures < 1) throw new Error('Worker/SQS observations do not prove bounded retries');
  const details = scope.failure ?? { itemId: failure.item_id, idempotencyKey: failure.idempotency_key };
  const audit = await observeTerminalStability(io, scope, details, failure.task_id, terminal.state);
  const token = audit.after.task.execution_token;
  if (!workerEvents.some((entry) => entry.parsed.event === 'task_execution_started'
    && entry.parsed.resourceId === failure.item_id && entry.parsed.executionToken === token)) {
    throw new Error('Terminal failure token lacks an exact canonical worker execution event');
  }
  return {
    task_id: failure.task_id,
    retryable_failures: retryableFailures,
    receive_count: receiveCount,
    database_lease_renewed: true,
    sqs_visibility_extended: true,
    terminal_audit: audit,
    credit: { applicability: 'not-applicable', reason: 'auto-tagging' },
    execution_token: token,
    dlq_message_id: dlq.MessageId,
    terminal_status: 'failed',
    item_id: failure.item_id,
  };
}

async function assertObjectGone(io, object) {
  try { await io.aws(['s3api', 'head-object', '--bucket', object.bucket, '--key', object.key]); }
  catch (error) { if (/Not Found|404/.test(error?.message ?? '')) return; throw error; }
  throw new Error(`Owned S3 object still exists after API cleanup: ${object.key}`);
}

async function cleanupOwnedResources({ scope, stack }, io, environment) {
  if (io.saveRecovery) await io.saveRecovery(scope);
  assertOwnedIdentity(scope, scope.runScope);
  const bucket = required(stack.bucket, 'Wardrobe bucket');
  const objects = [...(scope.resources ?? [])];
  objects.forEach((object) => assertExactObject(object, bucket));
  const serviceCommit = required(scope.deployment?.service_source_commit
    ?? scope.deployment?.service?.source_commit
    ?? environment.RUNTIME_DRILL_SERVICE_SHA, 'Service commit');
  const imageDigest = required(scope.deployment?.service_image_digest
    ?? scope.deployment?.service?.image_digest
    ?? environment.SERVICE_IMAGE_DIGEST, 'Service image digest');
  if (!DIGEST_PATTERN.test(imageDigest)) throw new Error('Cleanup requires an immutable Service image digest');
  const checkout = required(environment.E2E_SERVICE_CHECKOUT, 'E2E_SERVICE_CHECKOUT');
  const payload = JSON.stringify({ runScope: scope.runScope, users: [{ sub: scope.subject, email: scope.email }],
    ...(scope.knownDLQMessageId ? { knownDLQMessageId: scope.knownDLQMessageId } : {}) });
  const errors = [];
  const capturedUser = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId,
    Username: scope.cognitoUsername ?? scope.subject }));
  const capturedAttributes = Object.fromEntries((capturedUser.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
  if (capturedAttributes.sub !== scope.subject || capturedAttributes.email !== scope.email
    || capturedUser.Username !== (scope.cognitoUsername ?? scope.subject)) {
    throw new Error('Cognito ownership changed before resource cleanup; all deletions refused');
  }
  const itemIds = [...new Set([...(scope.items ?? []), scope.item?.itemId, scope.failure?.itemId].filter(Boolean))];
  for (const itemId of itemIds) {
    const observed = await pollItem(io, scope, itemId, { timeoutMs: 15_000, cleanup: true });
    if (observed.absent) continue;
    if (observed.state.taggingStatus === 'processing') {
      await pollItem(io, scope, itemId, { terminal: true });
    }
  }
  for (const itemId of itemIds) {
    try {
      const response = await io.fetch(`${scope.config.serviceUrl}/wardrobe/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${scope.accessToken}`, 'X-Request-ID': requestId(scope.marker) },
        signal: AbortSignal.timeout(30_000),
      });
      if (![200, 204, 404].includes(response.status)) throw new Error(`Wardrobe item DELETE failed (${response.status})`);
    } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Wardrobe API item cleanup failed; database cleanup was withheld');
  try {
    await io.runOneShotCleanup({ checkout, imageDigest, serviceCommit, payload, scope });
    scope.databaseCleanupCompleted = true;
    if (io.saveRecovery) await io.saveRecovery(scope);
  } catch (error) {
    throw new Error('Pinned Service tester-cleanup failed; Cognito and S3 cleanup were withheld', { cause: error });
  }
  for (const object of objects) {
    try { await assertObjectGone(io, object); } catch (error) { errors.push(error); }
  }
  // The pinned Service helper sweeps exact database-proven task IDs transactionally;
  // a single observer receive cannot establish that all owned DLQ work is gone.
  try {
    const user = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId,
      Username: scope.cognitoUsername ?? scope.subject }));
    const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (attributes.sub !== scope.subject || attributes.email !== scope.email
      || user.Username !== (scope.cognitoUsername ?? scope.subject)) throw new Error('Cognito ownership changed during cleanup');
    await io.cognitoSend(new AdminDeleteUserCommand({ UserPoolId: scope.userPoolId, Username: user.Username }));
  } catch (error) {
    if (!/UserNotFoundException/.test(error?.name ?? error?.message ?? '')) errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'Owned runtime resources did not fully clean up');
  scope.ownedCleanupCompleted = true;
  if (io.saveRecovery) await io.saveRecovery(scope);
}

export function createRuntimeDrillAdapter(io, environment = process.env) {
  io ??= liveIo(environment);
  return {
    createSyntheticAccount: (args) => createSyntheticAccount(args, io, environment),
    prepareNonPaidRuntime: (args) => prepareNonPaidRuntime(args, io, environment, waitServiceStable),
    restoreNonPaidRuntime: (args) => restoreNonPaidRuntime(args, io, waitServiceStable),
    pauseRuntimeWindow: ({ scope }) => pauseRuntimeWindow(io, scope),
    restoreRuntimeWindow: async ({ scope }) => {
      await restoreRuntimeWindow(io, scope);
      await cleanupOneShotDefinitions(io, scope);
    },
    recoverOwnedRuntime: (record) => recoverRuntimeRecord(record, io, environment, waitServiceStable),
    runWardrobeApiFlow: (args) => runWardrobeApiFlow(args, io, environment),
    replaceAndRestoreEcs: (args) => replaceAndRestoreEcs(args, io),
    captureReplicaAttribution: (args) => captureReplicaAttribution(args, io),
    runProviderFailureFixture: (args) => runProviderFailureFixture(args, io),
    collectRetryEvidence: (args) => collectRetryEvidence(args, io, environment),
    cleanupOwnedResources: (args) => cleanupOwnedResources(args, io, environment),
  };
}

export default createRuntimeDrillAdapter();
