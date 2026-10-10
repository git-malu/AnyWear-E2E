import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertE2EExecution } from './execution-guard.mjs';

export function sizingAwsReader(profile) {
  return args => JSON.parse(execFileSync('aws', [...args, '--region', 'ap-east-1',
    ...(profile ? ['--profile', profile] : []), '--output', 'json'], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  }));
}

export function sizingRuntimeSnapshot(aws) {
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== '650880818323') throw new Error('Sizing evidence requires reviewed Beta account');
  const services = aws(['ecs', 'describe-services', '--cluster', 'beta-anywear',
    '--services', 'beta-anywear-api', 'beta-anywear-worker']);
  if (services.failures?.length || services.services?.length !== 2) throw new Error('Both reviewed services are required');
  const definitions = [];
  const tasks = [];
  for (const service of services.services) {
    if (!service.serviceName?.match(/^beta-anywear-(api|worker)$/) || service.desiredCount !== 1
      || service.runningCount !== 1 || service.pendingCount !== 0
      || service.deployments?.length !== 1 || service.deployments[0].rolloutState !== 'COMPLETED') {
      throw new Error('Sizing snapshot requires active, stable one-replica Beta');
    }
    const listed = aws(['ecs', 'list-tasks', '--cluster', 'beta-anywear', '--service-name', service.serviceName]);
    if (listed.taskArns?.length !== 1) throw new Error('Each sizing service must have one active task');
    const observed = aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', ...listed.taskArns]);
    if (observed.failures?.length || observed.tasks?.length !== 1 || observed.tasks[0].lastStatus !== 'RUNNING') throw new Error('Active task observation failed');
    tasks.push(...observed.tasks);
    definitions.push(aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition]).taskDefinition);
  }
  return { schema_version: 1, observed_at: new Date().toISOString(), identity,
    services: services.services, tasks, definitions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Snapshot does not accept options');
  assertE2EExecution();
  if (!['S1', 'S2', 'S3'].includes(process.env.BETA_SIZING_STAGE)) throw new Error('Manager-selected sizing stage required');
  const deploymentBytes = await readFile('deployment-evidence-before.json');
  const snapshot = sizingRuntimeSnapshot(sizingAwsReader());
  const expected = JSON.parse(deploymentBytes).service;
  if (snapshot.tasks.some(task => task.containers?.length !== 1 || task.containers[0].imageDigest !== expected.image_digest)) {
    throw new Error('Sizing task image differs from authenticated qualification tuple');
  }
  Object.assign(snapshot, { e2e_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT, stage: process.env.BETA_SIZING_STAGE });
  const output = '.qualification-inputs/beta-sizing-runtime-before.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`);
}
