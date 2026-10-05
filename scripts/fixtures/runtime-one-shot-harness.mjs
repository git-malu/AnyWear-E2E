import { runOwnedOneShot } from '../runtime-one-shot.mjs';
import { cleanupFixture, scopeFixture } from './runtime-evidence.mjs';
import { collectCleanupEvidence } from '../runtime-one-shot-logs.mjs';

export function oneShotHarness() {
  const request = { runScope: '123-1-aaaaaaaaaaaaaaaa', user: { sub: '123e4567-e89b-12d3-a456-426614174000',
    email: 'e2e-beta-123-1-aaaaaaaaaaaaaaaa-0-01234567@anywear.local' }, taskId: '123e4567-e89b-12d3-a456-426614174001',
    itemId: '123e4567-e89b-12d3-a456-426614174002', idempotencyKey: '123e4567-e89b-12d3-a456-426614174003' };
  const scope = { ...scopeFixture(request), stack: { cluster: 'beta-anywear', bucket: 'bucket', userPoolId: 'ap-east-1_pool' }, items: [], resources: [],
    marker: 'beta-runtime-123-1', userPoolId: 'ap-east-1_pool', cognitoUsername: request.user.sub, config: { serviceUrl: 'https://service.example' } };
  Object.assign(scope.stack, { oneShotExecutionRoleArn: 'arn:aws:iam::650880818323:role/beta-oneshot-execution',
    verificationTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-verification', lifecycleTaskRoleArn: 'arn:aws:iam::650880818323:role/beta-lifecycle' });
  const calls = [];
  const definitions = new Map();
  const tasks = new Map();
  const logs = new Map();
  const snapshots = [];
  const io = {
    async saveRecovery(value) { snapshots.push(structuredClone(value)); },
    async sleep() {},
    async aws(args) {
      calls.push(args);
      const value = (flag) => args[args.indexOf(flag) + 1];
      if (args[0] === 'sts') return { Account: '650880818323' };
      if (args[0] === 'cloudformation') return { Stacks: [{ Outputs: [
        { OutputKey: 'EcsClusterName', OutputValue: scope.stack.cluster }, { OutputKey: 'WardrobeBucketName', OutputValue: scope.stack.bucket },
        { OutputKey: 'UserPoolId', OutputValue: scope.userPoolId },
        { OutputKey: 'OneShotExecutionRoleArn', OutputValue: scope.stack.oneShotExecutionRoleArn },
        { OutputKey: 'VerificationTaskRoleArn', OutputValue: scope.stack.verificationTaskRoleArn },
        { OutputKey: 'LifecycleTaskRoleArn', OutputValue: scope.stack.lifecycleTaskRoleArn } ] }] };
      if (args[1] === 'describe-task-definition') return structuredClone(definitions.get(value('--task-definition')));
      if (args[1] === 'describe-tasks') return { tasks: args.slice(args.indexOf('--tasks') + 1).map((arn) => structuredClone(tasks.get(arn))) };
      if (args[1] === 'list-task-definitions') return { taskDefinitionArns: [...definitions.entries()].filter(([, response]) => response.taskDefinition.status === 'ACTIVE').map(([arn]) => arn) };
      if (args[1] === 'list-tasks') return { taskArns: value('--desired-status') === 'STOPPED' ? [...tasks.keys()] : [] };
      if (args[1] === 'deregister-task-definition') { definitions.get(value('--task-definition')).taskDefinition.status = 'INACTIVE'; return {}; }
      if (args[1] === 'get-log-events') return { events: (logs.get(value('--log-stream-name')) ?? []).map((event) => ({ message: JSON.stringify(event) })) };
      if (args[1] === 'delete-object') return {};
      if (args[1] === 'head-object') throw new Error('Not Found');
      throw new Error(`Unexpected mock operation: ${args[0]} ${args[1]}`);
    },
    async cognitoSend(command) {
      calls.push([command.constructor.name]);
      return { Username: scope.cognitoUsername, UserAttributes: [{ Name: 'sub', Value: scope.subject }, { Name: 'email', Value: scope.email }] };
    },
  };
  const runner = async ({ scope: owned, purpose, action, payload, onLine }) => {
    const number = definitions.size + 1;
    const taskArn = `arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/${number.toString(16).padStart(32, '0')}`;
    const definitionArn = `arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:${number}`;
    const command = purpose === 'lifecycle' ? ['node', 'dist/ops/beta-lifecycle.js', action, ...(action === 'configure-testers' ? [payload] : [])]
      : ['node', `dist/ops/beta-${purpose === 'task-audit' ? 'task-audit' : 'tester-cleanup'}.js`, payload];
    definitions.set(definitionArn, { taskDefinition: { taskDefinitionArn: definitionArn, family: `beta-anywear-${purpose}`, status: 'ACTIVE',
      executionRoleArn: owned.stack.oneShotExecutionRoleArn,
      taskRoleArn: purpose === 'task-audit' ? owned.stack.verificationTaskRoleArn : owned.stack.lifecycleTaskRoleArn,
      containerDefinitions: [{ name: 'OneShot', image: `650880818323.dkr.ecr.ap-east-1.amazonaws.com/anywear@${owned.deployment.service.image_digest}`,
        command, environment: Object.entries({ SERVICE_COMMIT_SHA: owned.deployment.service.source_commit, IMAGE_DIGEST: owned.deployment.service.image_digest,
          STAGE: 'beta', NODE_ENV: 'production', AWS_REGION: 'ap-east-1', S3_BUCKET_NAME: owned.stack.bucket, TASK_TRANSPORT: 'sqs' }).map(([name, value]) => ({ name, value })) }] },
    tags: [{ key: 'anywear-runtime-run-scope', value: owned.runScope }] });
    tasks.set(taskArn, { taskArn, taskDefinitionArn: definitionArn, lastStatus: 'STOPPED',
      containers: [{ name: 'OneShot', exitCode: 0, imageDigest: owned.deployment.service.image_digest }] });
    const lines = [`Task definition: ${definitionArn}`, `Task ARN: ${taskArn}`, 'Task log group: /anywear/beta/one-shot',
      `Task log stream: beta-anywear-${purpose}/OneShot/${taskArn.split('/').at(-1)}`];
    for (const line of lines) await onLine(line);
    return { stdout: lines.join('\n') };
  };
  io.runOneShotCleanup = async ({ scope: owned, payload }) => {
    const { operation } = await runOwnedOneShot(io, owned, 'tester-cleanup', '', payload, runner);
    const evidence = cleanupFixture(owned);
    if (owned.knownDLQDeletionEvidence) {
      delete evidence.deletion;
      delete evidence.committed.dlq.known_message;
      evidence.committed.dlq.deleted = 0;
    }
    logs.set(operation.proof.log_stream, [evidence.committed, ...(evidence.deletion ? [evidence.deletion] : [])]);
    return collectCleanupEvidence(io, owned, operation);
  };
  return { request, scope, io, runner, definitions, tasks, logs, calls, snapshots };
}
