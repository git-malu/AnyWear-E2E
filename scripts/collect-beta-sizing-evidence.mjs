import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashBytes, S1_DIAGNOSTIC_PROBE, SIZING_ENVELOPE_MODE_WIDENING_CANDIDATE,
  SIZING_ENVELOPE_MODES } from './beta-sizing-workload.mjs';
import { correlateSizingTask, correlateSizingWorkload } from './beta-sizing-telemetry.mjs';
import { sizingAwsReader, sizingRuntimeSnapshot } from './beta-sizing-runtime.mjs';
import { assertEqual } from './evidence-contract.mjs';
import { validateSizingSource } from './beta-sizing-source.mjs';

export function collectSizingCloudEvidence({ workload, before, aws }) {
  if (workload.schema_version !== 1 || workload.issue !== 95 || workload.result !== 'passed' || !['S1', 'S2', 'S3'].includes(workload.stage)
    || !/^[a-f0-9]{40}$/.test(workload.e2e_sha) || !/^[1-9]\d*$/.test(workload.run_id)
    || !/^[1-9]\d*$/.test(workload.run_attempt)) throw new Error('Exact sizing run/source/stage binding required');
  const sourceBinding = { e2eSha: workload.e2e_sha, runId: workload.run_id,
    runAttempt: workload.run_attempt, compatibility: workload.deployment?.compatibility };
  validateSizingSource(workload.source_proof, sourceBinding);
  validateSizingSource(workload.source_proof_after, sourceBinding);
  validateSizingSource(before.source_proof, sourceBinding);
  assertEqual(workload.source_proof_after, workload.source_proof, 'After/workload complete source proof');
  assertEqual(before.source_proof, workload.source_proof, 'Before/workload complete source proof');
  const start = Date.parse(workload.started_at);
  const end = Date.parse(workload.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 2_700_000
    || Date.parse(before.observed_at) > start || Date.now() - start > 3_000_000) {
    throw new Error('Bounded workload and fresh before/runtime observations required; ECS stopped-task retention is limited');
  }
  const after = sizingRuntimeSnapshot(aws, workload.stage);
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
    if (observed.failures?.length) { gaps.push('Stopped task description incomplete'); oomCoverage = false; }
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
    if (!memory.length || processIds.size !== 1) { gaps.push(`Complete ${role} high-water/process coverage unavailable`); oomCoverage = false; }
    else {
      const highest = memory.reduce((a, b) => a.peakBytes > b.peakBytes ? a : b);
      peaks.push({ task_arn: task.taskArn, peak_mib: highest.peakBytes / 1048576, limit_mib: highest.limitBytes / 1048576 });
    }
  }
  const correlation = correlateSizingWorkload(workload.workload, events);
  gaps.push(...correlation.gaps);
  // The envelope mode is part of the record, never inferred: a candidate
  // measurement must carry the diagnostic probe and its verification, while a
  // demonstrated one must not carry a probe it never ran.
  const envelopeMode = workload.workload?.envelope_mode;
  if (!SIZING_ENVELOPE_MODES.includes(envelopeMode)) throw new Error('Sizing workload must record its reviewed envelope mode');
  const failures = [...correlation.failures];
  let failurePath = null;
  const diagnostic = workload.diagnostics?.failure_path;
  if (envelopeMode === SIZING_ENVELOPE_MODE_WIDENING_CANDIDATE) {
    if (!diagnostic) throw new Error('Widening-candidate measurement requires the diagnostic probe record');
    if (diagnostic.expected_failure_code !== S1_DIAGNOSTIC_PROBE.expected_failure_code
      || diagnostic.observed_failure_code !== S1_DIAGNOSTIC_PROBE.expected_failure_code) {
      throw new Error('Diagnostic probe must record the expected sanitized failure code');
    }
    if (typeof diagnostic.resource_id !== 'string' || !diagnostic.resource_id) {
      throw new Error('Diagnostic probe record must name the resource it observed');
    }
    const task = correlateSizingTask(diagnostic.resource_id, events, { failureCode: diagnostic.observed_failure_code });
    if (task.gap) throw new Error(`Diagnostic probe correlation is incomplete: ${task.gap}`);
    if (task.failure_code !== S1_DIAGNOSTIC_PROBE.expected_failure_code) {
      throw new Error(`Diagnostic probe failure code ${String(task.failure_code)} is not `
        + `${S1_DIAGNOSTIC_PROBE.expected_failure_code}`);
    }
    if (task.attempts !== S1_DIAGNOSTIC_PROBE.expected_executions) {
      throw new Error(`Diagnostic probe must settle in exactly ${S1_DIAGNOSTIC_PROBE.expected_executions} execution; `
        + `observed ${task.attempts}`);
    }
    if (task.provider_waits !== S1_DIAGNOSTIC_PROBE.expected_provider_calls) {
      throw new Error(`Diagnostic probe must make zero provider calls; observed ${task.provider_waits}`);
    }
    failures.push({ case_id: diagnostic.case_id, task_id: task.task_id, failure_code: task.failure_code,
      attempts: task.attempts, provider_waits: task.provider_waits });
    failurePath = { ...diagnostic, task_id: task.task_id, executions: task.attempts,
      provider_calls: task.provider_waits, expected_failure_verified: true,
      single_execution_verified: true, zero_provider_calls_verified: true };
  } else if (diagnostic) {
    throw new Error('The diagnostic probe is only submitted by the widening-candidate measurement');
  }
  if (failures.some(item => !item.failure_code)) gaps.push('A failed execution lacks its observed sanitized failure code');
  const failureCodes = {};
  for (const item of failures) {
    if (!item.failure_code) continue;
    failureCodes[item.failure_code] = (failureCodes[item.failure_code] ?? 0) + 1;
  }
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
    measured: { schema_version: 2, stage: workload.stage, source_proof: workload.source_proof,
      run_id: workload.run_id, run_attempt: workload.run_attempt,
      task_replacements: replacements + stoppedTasks.length,
      ...(oomCoverage ? { unexpected_oom: oomObserved + stoppedTasks.filter(task => task.containers.some(container => /outofmemory|oom/i.test(container.reason ?? ''))).length } : {}),
      binding: { fixture_manifest_sha256: workload.fixture_manifest_sha256,
        supported_input_envelope_sha256: workload.supported_input_envelope_sha256,
        provider_configuration_sha256: correlation.provider_configuration_sha256,
        deployment_record_sha256: workload.deployment.compatibility.deployment.record_sha256,
        client_sha: workload.deployment.client.source_commit, service_sha: workload.deployment.service.source_commit,
        infra_sha: workload.deployment.compatibility.infra.sha, e2e_sha: workload.e2e_sha,
        benchmark_source_sha256: workload.source_proof.benchmark_source_sha256,
        image_digest: workload.deployment.service.image_digest }, observed,
      workload: correlation.workload, provider_configuration: correlation.provider_configuration,
      // An observed failure is retained with the sanitized code the run reported and
      // the execution/provider-call counts telemetry shows; it is never counted as a
      // successful task timing.
      failure_codes: failureCodes,
      failure_path: failurePath,
      measurements: { started_at: new Date(alignedStart).toISOString(), finished_at: new Date(alignedEnd).toISOString(),
        peak_method: 'container-cgroup-high-water', peak_window_covered: peaks.length === 2 && replacements === 0 && stoppedTasks.length === 0,
        tasks: inventory, container_peaks: peaks, cpu_samples: cpu,
        route_samples_ms: workload.route_samples_ms,
        task_timings: [...correlation.task_timings, ...failures.map(item => ({ case_id: item.case_id,
          task_id: item.task_id, failure_code: item.failure_code, attempts: item.attempts,
          provider_waits: item.provider_waits }))] },
      evidence_gaps: gaps,
      remaining_acceptance: ['readiness, lease/queue/DLQ/backlog, duplicate/lost-work and notification evidence',
        'native completed-success exact run/artifact authentication and independent actual commit inventory reconstruction',
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
