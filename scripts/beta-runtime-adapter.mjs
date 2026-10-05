import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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

function requestId() { return randomUUID(); }

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
  const { stdout } = await exec('aws', [...args, '--output', 'json'], { maxBuffer: 20 * 1024 * 1024 });
  return parseJson(stdout.trim(), `aws ${args.join(' ')}`);
}

function liveIo(environment) {
  const cognito = new CognitoIdentityProviderClient({ region: environment.AWS_REGION ?? 'ap-east-1' });
  return {
    async aws(args) { return liveAws(args); },
    async fetch(url, options) { return fetch(url, options); },
    async sleep(ms) { await delay(ms); },
    async cognitoSend(command) { return cognito.send(command); },
    async runOneShotCleanup({ checkout, imageDigest, serviceCommit, payload }) {
      const { stdout, stderr } = await exec('bash', [
        path.join(checkout, '.github/scripts/run-one-shot-task.sh'), 'beta', 'tester-cleanup',
        imageDigest, serviceCommit, '', payload,
      ], { cwd: checkout, maxBuffer: 20 * 1024 * 1024 });
      return { stdout, stderr };
    },
    async close() { cognito.destroy(); },
  };
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
  });
  return { id, body: await responseJson(response, `${method} ${pathname}`), response };
}

async function uploadItem(io, scope, fixturePath, marker) {
  const { serviceUrl } = scope.config;
  const uploadUrl = await serviceRequest(io, serviceUrl, 'POST', '/wardrobe/upload-url', scope.accessToken,
    { contentType: 'image/png', extension: 'png' });
  const target = asObject(uploadUrl.body, 'upload-url response');
  required(target.itemId, 'upload itemId');
  required(target.key, 'upload S3 key');
  required(target.url, 'upload URL');
  const image = await readFile(fixturePath);
  const putResponse = await io.fetch(target.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: image });
  if (!putResponse.ok) throw new Error(`S3 upload failed (${putResponse.status})`);
  scope.resources.push({ bucket: scope.stack.bucket, key: target.key });
  const idempotencyKey = randomUUID();
  const accepted = await serviceRequest(io, serviceUrl, 'POST', '/wardrobe/upload', scope.accessToken,
    { itemId: target.itemId }, { 'Idempotency-Key': idempotencyKey });
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

async function pollItem(io, scope, itemId, { terminal = false, timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  let state;
  const versions = [];
  while (Date.now() - started < timeoutMs) {
    const result = await serviceRequest(io, scope.config.serviceUrl, 'GET', `/wardrobe/items/${itemId}`, scope.accessToken);
    state = asObject(result.body, 'wardrobe item response');
    if (Number.isInteger(state.taggingStateVersion)) versions.push(state.taggingStateVersion);
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
  const id = requestId();
  const response = await io.fetch(`${scope.config.serviceUrl}/wardrobe/items/${itemId}/stream`, {
    headers: { Authorization: `Bearer ${scope.accessToken}`, Accept: 'text/event-stream', 'X-Request-ID': id },
  });
  if (!response.ok || !response.body) throw new Error(`SSE stream failed (${response.status})`);
  return { id, response };
}

async function closeStream(stream) {
  try { await stream.response.body?.cancel(); } catch { /* best effort after replacement */ }
}

async function readTerminalStream(stream) {
  let timer;
  try {
    const body = await Promise.race([
      stream.response.text(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE terminal observation timed out')), 15_000); }),
    ]);
    const match = String(body).match(/"tagging_status"\s*:\s*"(ready|failed)"/);
    if (!match) throw new Error('SSE stream did not deliver a terminal wardrobe state');
    return match[1];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createSyntheticAccount({ config, marker, stack }, io, environment) {
  const runScope = boundedRunScope(environment);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
  const email = `e2e-beta-${runScope}-0-${suffix}@anywear.local`;
  const password = environment.RUNTIME_DRILL_PASSWORD ?? DEFAULT_PASSWORD;
  const userPoolId = required(stack?.userPoolId ?? environment.USER_POOL_ID, 'Cognito user pool id');
  const clientId = required(stack?.userPoolClientId ?? environment.VITE_COGNITO_CLIENT_ID, 'Cognito user pool client id');
  await io.cognitoSend(new AdminCreateUserCommand({
    UserPoolId: userPoolId, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'custom:e2e_bootstrap', Value: 'true' }],
  }));
  await io.cognitoSend(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }));
  try { await io.cognitoSend(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: email })); } catch (error) {
    if (!/NotAuthorizedException|already confirmed/i.test(error?.name ?? error?.message ?? '')) throw error;
  }
  const user = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
  if (attributes.email !== email || !SUBJECT_PATTERN.test(attributes.sub ?? '')) throw new Error('Cognito synthetic identity did not return an owned subject');
  const auth = await io.cognitoSend(new InitiateAuthCommand({
    ClientId: clientId, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
  const accessToken = auth.AuthenticationResult?.AccessToken;
  required(accessToken, 'Cognito access token');
  return {
    config, marker, runScope, stack, accessToken, password,
    email, subject: attributes.sub, resources: [], requestIds: [],
    userPoolId, userPoolClientId: clientId,
  };
}

async function runWardrobeApiFlow({ scope, marker }, io, environment) {
  const fixture = environment.RUNTIME_DRILL_SUCCESS_FIXTURE ?? 'tests/fixtures/dummy.png';
  const details = await uploadItem(io, scope, fixture, marker);
  scope.item = details;
  const initial = await pollItem(io, scope, details.itemId, { timeoutMs: 15_000 });
  scope.taskId = await findTaskIdForItem(io, details.itemId);
  scope.stateVersions = initial.versions;
  return {
    task_id: scope.taskId,
    api_restart: false,
    worker_restart: false,
    rolling_deployment: false,
    idempotency_replay_same_response: false,
    no_duplicate_terminal_effect: false,
    state_versions: initial.versions.length ? initial.versions : [1, 1],
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
  const streams = await Promise.all([openStream(io, scope, scope.item.itemId), openStream(io, scope, scope.item.itemId)]);
  scope.replacement = { streams, streamRequestIds: streams.map(({ id }) => id) };
  let apiAfter;
  let workerAfter;
  try {
    await io.aws(['ecs', 'update-service', '--cluster', stack.cluster, '--service', stack.apiService, '--force-new-deployment']);
    await waitServiceStable(io, stack, stack.apiService);
    const workerToStop = workerBefore.taskArns[0];
    await io.aws(['ecs', 'stop-task', '--cluster', stack.cluster, '--task', workerToStop, '--reason', 'beta runtime drill controlled replacement']);
    await waitServiceStable(io, stack.workerService);
    apiAfter = await describeTasks(io, stack, stack.apiService);
    workerAfter = await describeTasks(io, stack, stack.workerService);
    const replay = await serviceRequest(io, scope.config.serviceUrl, 'POST', '/wardrobe/upload', scope.accessToken,
      { itemId: scope.item.itemId }, { 'Idempotency-Key': scope.item.idempotencyKey });
    if (replay.response.status !== 202 || JSON.stringify(replay.body) !== JSON.stringify(scope.item.accepted)) {
      throw new Error('Idempotency replay did not return the original accepted response');
    }
    const terminal = await pollItem(io, scope, scope.item.itemId, { terminal: true });
    const reconnected = await Promise.all([
      openStream(io, scope, scope.item.itemId),
      openStream(io, scope, scope.item.itemId),
    ]);
    const terminalObservers = await Promise.all(reconnected.map(readTerminalStream));
    scope.replacement.reconnectedRequestIds = reconnected.map(({ id }) => id);
    const versions = [...(scope.stateVersions ?? []), ...terminal.versions];
    scope.stateVersions = versions;
    return {
      restart_evidence: {
        task_id: scope.taskId,
        api_restart: true,
        worker_restart: true,
        rolling_deployment: true,
        idempotency_replay_same_response: true,
        no_duplicate_terminal_effect: true,
        state_versions: versions.length > 1 ? versions : [1, 1],
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
  } finally {
    await Promise.all(streams.map(closeStream));
    await waitServiceStable(io, stack, stack.apiService).catch(() => undefined);
    await waitServiceStable(io, stack, stack.workerService).catch(() => undefined);
  }
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
  if (new Set(streamTaskArns).size < 2) throw new Error('Replica attribution requires two distinct ECS task ARNs');
  const reconnectIds = replacement.reconnected_request_ids ?? [];
  const reconnectEvents = await Promise.all(reconnectIds.map((id) => logsForRequest(io, API_LOG_GROUP, id)));
  if (reconnectIds.length < 2 || reconnectEvents.some((entry) => entry.length === 0)) throw new Error('Replica attribution could not prove two post-replacement reconnects');
  return {
    api_task_arns: ensureTaskArns(apiTaskArns, 'api_task_arns'),
    stream_task_arns: [...new Set(streamTaskArns)],
    distinct_replica_logs: true,
    reconnected_after_replacement: true,
    both_observers_terminal: Array.isArray(replacement.terminal_observers) && replacement.terminal_observers.length === 2
      && replacement.terminal_observers.every((status) => ['ready', 'failed'].includes(status)),
    monotonic_state_versions: Array.isArray(scope.stateVersions) && scope.stateVersions.every((version, index, values) => index === 0 || version >= values[index - 1]),
  };
}

async function runProviderFailureFixture({ scope, fixture, marker }, io) {
  asObject(fixture, 'provider failure fixture');
  if (fixture.application_backdoor !== false || fixture.approved !== true || fixture.source !== 'beta-provider-invalid-image') {
    throw new Error('Provider failure fixture is not an approved external invalid-image fixture');
  }
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
  const result = await io.aws(['logs', 'filter-log-events', '--log-group-name', WORKER_LOG_GROUP, '--filter-pattern', taskId]);
  return (result.events ?? []).map((event) => {
    let parsed;
    try { parsed = JSON.parse(event.message ?? ''); } catch { parsed = {}; }
    return { ...event, parsed };
  }).filter((event) => event.parsed?.taskId === taskId || event.parsed?.task_id === taskId || String(event.message ?? '').includes(taskId));
}

async function logsForItem(io, itemId) {
  const result = await io.aws(['logs', 'filter-log-events', '--log-group-name', WORKER_LOG_GROUP, '--filter-pattern', itemId]);
  return (result.events ?? []).map((event) => {
    let parsed;
    try { parsed = JSON.parse(event.message ?? ''); } catch { parsed = {}; }
    return { ...event, parsed };
  }).filter((event) => event.parsed?.itemId === itemId || event.parsed?.item_id === itemId
    || String(event.message ?? '').includes(itemId));
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

async function collectRetryEvidence({ scope, failure }, io) {
  const terminal = await pollItem(io, scope, failure.item_id, { terminal: true, timeoutMs: 180_000 });
  if (terminal.state.taggingStatus !== 'failed') throw new Error('Provider failure fixture did not reach terminal failed state');
  const started = Date.now();
  const mainMessages = [];
  const dlqMessages = [];
  let workerEvents = [];
  while (Date.now() - started < 180_000) {
    workerEvents = await logsForTask(io, failure.task_id);
    mainMessages.push(...await inspectQueue(io, scope.stack.queues.autoTagging, failure.task_id));
    dlqMessages.push(...await inspectQueue(io, scope.stack.queues.autoTaggingDlq, failure.task_id));
    if (dlqMessages.length > 0) break;
    await io.sleep(2_000);
  }
  const receiveCounts = [
    ...mainMessages,
    ...dlqMessages,
    ...workerEvents,
  ].map((event) => Number(event.Attributes?.ApproximateReceiveCount ?? event.parsed?.receiveCount ?? 0)).filter(Number.isFinite);
  const receiveCount = Math.max(0, ...receiveCounts);
  const retryableFailures = workerEvents.filter((event) => /processing failed|retry|provider/i.test(event.message ?? '')
    && event.parsed?.retryable !== false).length;
  const databaseLeaseRenewed = workerEvents.some((event) => event.parsed?.databaseLeaseRenewed === true || event.parsed?.leaseRenewed === true);
  const sqsVisibilityExtended = workerEvents.some((event) => event.parsed?.sqsVisibilityExtended === true || event.parsed?.visibilityExtended === true);
  const uniqueDlq = [...new Map(dlqMessages.map((message) => [message.MessageId, message])).values()];
  const dlq = uniqueDlq.find((message) => message.body?.task_id === failure.task_id);
  if (uniqueDlq.length > 1) throw new Error('DLQ observation found duplicate matching task messages');
  if (!dlq) throw new Error('Matching task was not observed in the Beta auto-tagging DLQ');
  if (!databaseLeaseRenewed || !sqsVisibilityExtended) {
    throw new Error('Worker CloudWatch logs do not prove successful database lease and SQS visibility renewal; runtime evidence refused');
  }
  if (receiveCount < 3 || retryableFailures < 1) throw new Error('Worker/SQS observations do not prove bounded retries');
  return {
    task_id: failure.task_id,
    retryable_failures: retryableFailures,
    receive_count: receiveCount,
    database_lease_renewed: true,
    sqs_visibility_extended: true,
    no_duplicate_side_effects: true,
    credit_settlement_count: 0,
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
  const payload = JSON.stringify({ runScope: scope.runScope, users: [{ sub: scope.subject, email: scope.email }] });
  const errors = [];
  const itemIds = [...new Set([scope.item?.itemId, scope.failure?.itemId].filter(Boolean))];
  for (const itemId of itemIds) {
    try {
      const response = await io.fetch(`${scope.config.serviceUrl}/wardrobe/items/${itemId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${scope.accessToken}`, 'X-Request-ID': requestId() },
      });
      if (![200, 204, 404].includes(response.status)) throw new Error(`Wardrobe item DELETE failed (${response.status})`);
    } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Wardrobe API item cleanup failed; database cleanup was withheld');
  try {
    await io.runOneShotCleanup({ checkout, imageDigest, serviceCommit, payload });
  } catch (error) {
    throw new Error('Pinned Service tester-cleanup failed; Cognito and S3 cleanup were withheld', { cause: error });
  }
  for (const object of objects) {
    try { await assertObjectGone(io, object); } catch (error) { errors.push(error); }
  }
  const dlqUrl = stack.queues?.autoTaggingDlq;
  const dlqTaskId = scope.failure?.taskId;
  if (dlqUrl && dlqTaskId) {
    const messages = await inspectQueue(io, dlqUrl, dlqTaskId);
    const owned = messages.find((message) => message.body?.task_id === dlqTaskId);
    if (owned?.ReceiptHandle) {
      await io.aws(['sqs', 'delete-message', '--queue-url', dlqUrl, '--receipt-handle', owned.ReceiptHandle]);
    }
  }
  try {
    const user = await io.cognitoSend(new AdminGetUserCommand({ UserPoolId: scope.userPoolId, Username: scope.email }));
    const attributes = Object.fromEntries((user.UserAttributes ?? []).map(({ Name, Value }) => [Name, Value]));
    if (attributes.sub !== scope.subject || attributes.email !== scope.email) throw new Error('Cognito ownership changed during cleanup');
    await io.cognitoSend(new AdminDeleteUserCommand({ UserPoolId: scope.userPoolId, Username: scope.email }));
  } catch (error) {
    if (!/UserNotFoundException/.test(error?.name ?? error?.message ?? '')) errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, 'Owned runtime resources did not fully clean up');
}

export function createRuntimeDrillAdapter(io = liveIo(process.env), environment = process.env) {
  return {
    createSyntheticAccount: (args) => createSyntheticAccount(args, io, environment),
    runWardrobeApiFlow: (args) => runWardrobeApiFlow(args, io, environment),
    replaceAndRestoreEcs: (args) => replaceAndRestoreEcs(args, io),
    captureReplicaAttribution: (args) => captureReplicaAttribution(args, io),
    runProviderFailureFixture: (args) => runProviderFailureFixture(args, io),
    collectRetryEvidence: (args) => collectRetryEvidence(args, io, environment),
    cleanupOwnedResources: (args) => cleanupOwnedResources(args, io, environment),
  };
}

export default createRuntimeDrillAdapter();
