import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashBytes } from './beta-sizing-workload.mjs';
import { correlateSizingWorkload } from './beta-sizing-telemetry.mjs';
import { sizingAwsReader, sizingRuntimeSnapshot } from './beta-sizing-runtime.mjs';

export function collectSizingCloudEvidence({ workload, before, aws }) {
  if (workload.schema_version !== 1 || workload.issue !== 95 || !['S1', 'S2', 'S3'].includes(workload.stage)
    || !/^[a-f0-9]{40}$/.test(workload.e2e_sha) || !/^[1-9]\d*$/.test(workload.run_id)
    || !/^[1-9]\d*$/.test(workload.run_attempt)) throw new Error('Exact sizing run/source/stage binding required');
  const start = Date.parse(workload.started_at);
  const end = Date.parse(workload.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 2_700_000
    || Date.parse(before.observed_at) > start || Date.now() - end > 3_000_000) {
    throw new Error('Bounded workload and fresh before/runtime observations required; ECS stopped-task retention is limited');
  }
  const after = sizingRuntimeSnapshot(aws);
  if (before.e2e_sha !== workload.e2e_sha || before.run_id !== workload.run_id
    || before.run_attempt !== workload.run_attempt || before.stage !== workload.stage) throw new Error('Before snapshot belongs to another workload run/source');
  const taskIds = snapshot => snapshot.tasks.map(task => task.taskArn).sort();
  const gaps = [];
  const replacements = JSON.stringify(taskIds(before)) === JSON.stringify(taskIds(after)) ? 0 : 1;
  let oomObserved = 0;
  let oomCoverage = true;
  const stopped = aws(['ecs', 'list-tasks', '--cluster', 'beta-anywear', '--desired-status', 'STOPPED']);
  const stoppedTasks = [];
  for (let i = 0; i < stopped.taskArns.length; i += 100) {
    const observed = aws(['ecs', 'describe-tasks', '--cluster', 'beta-anywear', '--tasks', ...stopped.taskArns.slice(i, i + 100)]);
    if (observed.failures?.length) gaps.push('Stopped task description incomplete');
    stoppedTasks.push(...observed.tasks.filter(task => ['service:beta-anywear-api', 'service:beta-anywear-worker'].includes(task.group)
      && Date.parse(task.stoppedAt) >= start && Date.parse(task.stoppedAt) <= end));
  }
  const alignedStart = Math.floor(start / 60000) * 60000;
  const alignedEnd = Math.ceil(end / 60000) * 60000;
  const cpu = [];
  const metrics = [];
  const events = [];
  const inventory = [];
  const peaks = [];
  for (const role of ['api', 'worker']) {
    const service = after.services.find(item => item.serviceName === `beta-anywear-${role}`);
    const task = after.tasks.find(item => item.group === `service:${service.serviceName}`);
    const definition = after.definitions.find(item => item.taskDefinitionArn === task?.taskDefinitionArn);
    if (!task || !definition) throw new Error('Exact task definition inventory unavailable');
    if (task.containers.length !== 1 || task.containers[0].imageDigest !== workload.deployment.service.image_digest) {
      throw new Error('Actual sizing task image does not match workload tuple');
    }
    inventory.push({ service: role, task_arn: task.taskArn, task_definition_arn: definition.taskDefinitionArn });
    const values = aws(['cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/ECS', '--metric-name', 'CPUUtilization',
      '--dimensions', 'Name=ClusterName,Value=beta-anywear', `Name=ServiceName,Value=${service.serviceName}`,
      '--start-time', new Date(alignedStart).toISOString(), '--end-time', new Date(alignedEnd).toISOString(),
      '--period', '60', '--statistics', 'Maximum']);
    metrics.push({ role, ...values });
    for (const point of values.Datapoints) cpu.push({ service: role, minute_utc: new Date(point.Timestamp).toISOString(), percent: point.Maximum });
    const logGroup = definition.containerDefinitions[0].logConfiguration?.options?.['awslogs-group'];
    const prefix = definition.containerDefinitions[0].logConfiguration?.options?.['awslogs-stream-prefix'];
    const stream = `${prefix}/${definition.containerDefinitions[0].name}/${task.taskArn.split('/').at(-1)}`;
    if (logGroup !== `/anywear/beta/${role}` || !prefix) throw new Error('Unreviewed telemetry log path');
    const logged = aws(['logs', 'filter-log-events', '--log-group-name', logGroup, '--log-stream-names', stream,
      '--start-time', String(start - 60000), '--end-time', String(Date.now()), '--filter-pattern', '"Beta sizing observation"']);
    for (const event of logged.events) {
      try {
        const record = JSON.parse(event.message);
        if (record.msg === 'Beta sizing observation') events.push({ ...record, workerTaskArn: task.taskArn,
          log_event_id: event.eventId, log_stream: event.logStreamName, ingestion_time: event.ingestionTime });
      } catch { gaps.push(`Non-JSON sizing event in ${role}`); }
    }
    const memory = events.filter(event => event.workerTaskArn === task.taskArn && event.event === 'container_memory_high_water'
      && event.status === 'available' && Date.parse(event.observedAt) >= end && event.serviceSha === workload.deployment.service.source_commit);
    const processIds = new Set(events.filter(event => event.workerTaskArn === task.taskArn).map(event => event.processInstance));
    if (!memory.length || memory.some(event => !Number.isInteger(event.oomEvents) || !Number.isInteger(event.oomKillEvents))) oomCoverage = false;
    else oomObserved += Math.max(...memory.map(event => Math.max(event.oomEvents, event.oomKillEvents)));
    if (!memory.length || processIds.size !== 1) gaps.push(`Complete ${role} high-water/process coverage unavailable`);
    else {
      const highest = memory.reduce((a, b) => a.peakBytes > b.peakBytes ? a : b);
      peaks.push({ task_arn: task.taskArn, peak_mib: highest.peakBytes / 1048576, limit_mib: highest.limitBytes / 1048576 });
    }
  }
  const correlation = correlateSizingWorkload(workload.workload, events);
  gaps.push(...correlation.gaps);
  const limits = aws(['application-autoscaling', 'describe-scalable-targets', '--service-namespace', 'ecs']);
  const observed = Object.fromEntries(['api', 'worker'].map(role => {
    const service = after.services.find(item => item.serviceName === `beta-anywear-${role}`);
    const definition = after.definitions.find(item => item.taskDefinitionArn === service.taskDefinition);
    const scaling = limits.ScalableTargets.find(item => item.ResourceId === `service/beta-anywear/${service.serviceName}`);
    return [role, { desired: service.desiredCount, minimum: scaling?.MinCapacity ?? null,
      cpu: Number(definition.cpu), memoryMiB: Number(definition.memory) }];
  }));
  return { schema_version: 1, collected_at: new Date().toISOString(), workload,
    before, after, stopped_tasks: stoppedTasks, metrics, telemetry_events: events, scaling_targets: limits,
    measured: { schema_version: 2, stage: workload.stage,
      task_replacements: replacements + stoppedTasks.length,
      ...(oomCoverage ? { unexpected_oom: oomObserved + stoppedTasks.filter(task => task.containers.some(container => /outofmemory|oom/i.test(container.reason ?? ''))).length } : {}),
      binding: { fixture_manifest_sha256: workload.fixture_manifest_sha256,
        supported_input_envelope_sha256: workload.supported_input_envelope_sha256,
        provider_configuration_sha256: correlation.provider_configuration_sha256,
        deployment_record_sha256: workload.deployment.compatibility.deployment.record_sha256,
        client_sha: workload.deployment.client.source_commit, service_sha: workload.deployment.service.source_commit,
        infra_sha: workload.deployment.compatibility.infra.sha, e2e_sha: workload.e2e_sha,
        image_digest: workload.deployment.service.image_digest }, observed,
      workload: correlation.workload, provider_configuration: correlation.provider_configuration,
      measurements: { started_at: new Date(alignedStart).toISOString(), finished_at: new Date(alignedEnd).toISOString(),
        peak_method: 'container-cgroup-high-water', peak_window_covered: peaks.length === 2 && replacements === 0 && stoppedTasks.length === 0,
        tasks: inventory, container_peaks: peaks, cpu_samples: cpu,
        route_samples_ms: workload.route_samples_ms, task_timings: correlation.task_timings },
      evidence_gaps: gaps,
      remaining_acceptance: ['readiness, lease/queue/DLQ/backlog, duplicate/lost-work and notification evidence',
        'authenticated raw artifact references', 'final profile interruption/recovery and qualification cleanup'] } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { workload: { type: 'string' }, before: { type: 'string' },
    'workload-sha256': { type: 'string' }, 'before-sha256': { type: 'string' },
    profile: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false });
  const parseBound = async (file, hash) => {
    if (!file || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Exact downloaded input path/SHA-256 required');
    const bytes = await readFile(file);
    if (hashBytes(bytes) !== hash) throw new Error('Downloaded sizing input bytes changed');
    return JSON.parse(bytes);
  };
  if (!values.profile || !values.output) throw new Error('Explicit verified AWS profile and evidence output required');
  const workload = await parseBound(values.workload, values['workload-sha256']);
  const before = await parseBound(values.before, values['before-sha256']);
  if (workload.runtime_before_sha256 !== values['before-sha256']) throw new Error('Workload did not capture these runtime-before bytes');
  const record = collectSizingCloudEvidence({ workload, before, aws: sizingAwsReader(values.profile) });
  await writeFile(values.output, `${JSON.stringify(record, null, 2)}\n`);
  console.log('Retained read-only CPU, task, peak and causal evidence; separate acceptance gates remain required.');
}
