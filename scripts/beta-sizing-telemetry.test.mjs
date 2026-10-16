import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { correlateSizingTask } from './beta-sizing-telemetry.mjs';
import { hashBytes, loadSizingFixtures, sizingUploadCases, sizingVtoCases, orderedSizingGarments,
  vtoAggregateSubmittedBytes } from './beta-sizing-workload.mjs';
import { SIZING_WORKLOAD } from './beta-sizing-benchmark.mjs';
import { S1_INPUT_BYTES_MAX, S1_INPUT_ENVELOPE, S1_INPUT_EXCLUDED_FIXTURES, S1_DEFERRED_VTO_SHAPE,
  S1_VTO_SHAPE_NAMING, assertCaseInputsWithinEnvelope, assertSizingInputEnvelope } from './beta-sizing-envelope.mjs';

function logs() {
  const common = { taskId: 'task', workerTaskArn: 'worker', processInstance: 'process', serviceSha: 'b'.repeat(40),
    observedAt: '2026-10-10T00:01:00Z', monotonicMs: 800, workerId: 'worker-process' };
  return [
    { ...common, event: 'task_acceptance_precommit', resourceId: 'resource', workerTaskArn: 'api', processInstance: 'api' },
    { ...common, event: 'outbox_causal_snapshot', taskId: undefined, startedMonotonicMs: 100, complete: true,
      cap: 256, statementTimeoutMs: 200, ids: ['existing'], querySemantics: 'unfiltered-immutable-outbox-ids-read-committed' },
    { ...common, event: 'task_outbox_send_started', outboxId: 'outbox', attemptCount: 1,
      absentSnapshotStartedMonotonicMs: 100, monotonicMs: 600 },
    { ...common, event: 'task_outbox_send_acknowledged', outboxId: 'outbox', awsRequestId: 'request', awsSdkAttempts: 1, monotonicMs: 900 },
    { ...common, event: 'task_execution_started', executionToken: 1, startedMonotonicMs: 750, monotonicMs: 750 },
    { ...common, event: 'provider_configuration', model: 'model', provider: 'tagging' },
    { ...common, event: 'task_processing_timing', executionToken: 1, outcome: 'completed', localProcessingMs: 100, providerMs: 1000 },
  ];
}

test('correlates first execution on one Worker clock even when it starts before SQS ACK', () => {
  const result = correlateSizingTask('resource', logs());
  assert.equal(result.gap, undefined);
  assert.equal(result.timing.queue.kind, 'same-worker-causal-bounds');
  assert.equal(result.timing.queue.first_execution_started_ms, 750);
  assert.equal(result.timing.queue.send_acknowledged_ms, 900);
  assert.match(result.timing.queue.clock_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.timing.queue.send_sdk_attempts, 1);
});

test('successful SQS ACK after SDK resend or without attempts metadata cannot prove first publication', () => {
  for (const attempts of [2, 0, undefined, null, '1']) {
    const events = logs(); events[3].awsSdkAttempts = attempts;
    assert.ok(correlateSizingTask('resource', events).gap);
  }
});

test('missing/truncated absence proof, re-publication, retries and process changes stay unavailable', () => {
  for (const alter of [events => { events[1].complete = false; },
    events => { events[1].ids.push('outbox'); }, events => { events[2].attemptCount = 2; },
    events => { events[4].processInstance = 'other'; }, events => { events.push(events[3]); },
    events => { events[4].startedMonotonicMs = 500; }, events => { events.splice(1, 1); }]) {
    const events = logs(); alter(events);
    assert.ok(correlateSizingTask('resource', events).gap);
  }
});

test('freezes valid representative image bytes and exactly 12 uploads / eight VTO cases', async () => {
  const frozen = await loadSizingFixtures(new URL('../tests/fixtures/beta-sizing/', import.meta.url));
  const uploads = sizingUploadCases();
  assert.equal(uploads.length, 12);
  assert.equal(uploads.length, SIZING_WORKLOAD.upload_tagging_cases);
  assert.equal(new Set(uploads.map(item => item.case_id)).size, 12);
  for (const item of uploads) assert.ok(frozen.fixtures.has(item.fixture));
  for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
    for (const size of SIZING_WORKLOAD.size_classes) {
      for (const mode of SIZING_WORKLOAD.submission_modes) {
        const cases = uploads.filter(item => item.size_class === size && item.submission === mode
          && frozen.fixtures.get(item.fixture).mime === mime);
        assert.equal(cases.length, 2);
      }
    }
  }
  const vto = sizingVtoCases();
  assert.equal(vto.length, 8);
  assert.equal(vto.length, SIZING_WORKLOAD.vto_generations);
  for (const shape of SIZING_WORKLOAD.vto_shapes) {
    assert.equal(vto.filter(item => item.shape === shape).length, 2);
  }
  // The five-garment shape that carried the representative larger 4K output is
  // deferred to #140, not silently dropped.
  assert.equal(vto.length, SIZING_WORKLOAD.vto_shapes.length * 2);
  assert.ok(vto.every(item => item.advanced_settings === undefined));
});

test('keeps every sizing case input inside the demonstrated S1 envelope', async () => {
  const frozen = await loadSizingFixtures(new URL('../tests/fixtures/beta-sizing/', import.meta.url));
  assert.equal(S1_INPUT_BYTES_MAX, 697_437);
  assert.equal(S1_INPUT_ENVELOPE.largest_served_case_id, 'sequential-ordinary-jpg-1');
  assert.deepEqual(S1_INPUT_ENVELOPE.measured_inputs.map(item => [item.case_id, item.bytes, item.terminal_state]), [
    ['sequential-ordinary-jpg-0', 441_913, 'ready'],
    ['sequential-ordinary-jpg-1', 697_437, 'ready'],
    ['sequential-ordinary-png-0', 3_742_711, 'failed'],
  ]);
  // The measured inputs are the run's historical figures, not the shipped bytes.
  assert.match(S1_INPUT_ENVELOPE.measured_inputs_basis, /historical run evidence/);
  assert.equal(frozen.fixtures.get('trousers-ordinary.jpg').bytes, 388_182);
  assert.equal(frozen.fixtures.get('jacket-ordinary.jpg').bytes, 664_453);
  // The bound is per submitted input, and says so.
  assert.match(S1_INPUT_ENVELOPE.input_bytes_max_basis, /per submitted input/);
  assert.match(S1_INPUT_ENVELOPE.vto_aggregate_limit, /not per aggregate/);
  // The bound is the largest input a passing case submitted, not a hopeful limit.
  const served = S1_INPUT_ENVELOPE.measured_inputs.filter(item => item.terminal_state === 'ready');
  assert.equal(Math.max(...served.map(item => item.bytes)), S1_INPUT_BYTES_MAX);
  const caseInputs = [...new Set([...sizingUploadCases(), ...sizingVtoCases()]
    .flatMap(entry => [entry.fixture, entry.base_fixture, ...(entry.garment_fixtures ?? [])].filter(Boolean)))];
  for (const id of caseInputs) {
    const fixture = frozen.fixtures.get(id);
    assert.ok(fixture, `${id} must be a frozen fixture`);
    assert.ok(fixture.bytes <= S1_INPUT_BYTES_MAX, `${id} exceeds the S1 input envelope`);
  }
  // A previously oversized fixture may not return as a submittable case, and the
  // excluded record must keep naming it at its original size.
  for (const excluded of S1_INPUT_EXCLUDED_FIXTURES) {
    assert.ok(excluded.bytes > S1_INPUT_BYTES_MAX);
    assert.equal(frozen.fixtures.has(excluded.id), false);
    assert.ok(caseInputs.every(id => id !== excluded.id));
  }
});

test('orders VTO garments smallest-first and reports the aggregate the per-input bound does not cover', async () => {
  const frozen = await loadSizingFixtures(new URL('../tests/fixtures/beta-sizing/', import.meta.url));
  const cases = sizingVtoCases();
  for (const entry of cases) {
    const bytes = entry.garment_fixtures.map(id => frozen.fixtures.get(id).bytes);
    assert.deepEqual(bytes, [...bytes].sort((left, right) => left - right),
      `${entry.case_id} must submit its garments smallest-first`);
    assert.equal(entry.garment_fixtures.length, entry.garment_count);
    // The aggregate is reported for every observation and exceeds the single-input
    // bound, which is exactly why it is a separate, unproven quantity.
    const aggregate = vtoAggregateSubmittedBytes(frozen.fixtures, entry.base_fixture, entry.garment_fixtures);
    assert.ok(Number.isInteger(aggregate) && aggregate > S1_INPUT_BYTES_MAX);
    assert.ok(entry.garment_fixtures.every(id => frozen.fixtures.get(id).bytes <= S1_INPUT_BYTES_MAX));
  }
  assert.equal(orderedSizingGarments(frozen.fixtures, 1)[0].id, 'bag-ordinary.jpg');
  assert.equal(orderedSizingGarments(frozen.fixtures, 3).map(item => item.id).join(),
    'bag-ordinary.jpg,shoes-ordinary.jpg,trousers-ordinary.jpg');
  assert.throws(() => orderedSizingGarments(frozen.fixtures, 6), /between 1 and 5 garments/);
});

test('records the deferred five-garment 4K VTO shape rather than dropping it', () => {
  const deferred = S1_DEFERRED_VTO_SHAPE;
  assert.equal(deferred.garment_count, 5);
  assert.equal(deferred.advanced_settings.size, '4K');
  assert.equal(deferred.reason, 'deferred_to_140');
  assert.equal(deferred.garment_only_bytes, 2_408_024);
  assert.equal(deferred.aggregate_submitted_bytes, 2_953_744);
  assert.ok(deferred.aggregate_submitted_bytes > S1_INPUT_BYTES_MAX);
  // It is about 79% of the single input whose base64 payload exhausted the budget.
  assert.ok(deferred.garment_only_bytes / 3_742_711 > 0.6);
  // No submitted case may be the deferred shape.
  assert.ok(sizingVtoCases().every(item => item.shape !== deferred.shape));
  assert.ok(!SIZING_WORKLOAD.vto_shapes.includes(deferred.shape));
});

// The reviewed shape identifiers keep their historical names, so the note saying so
// has to travel with them or `large-base-*` reads as a large base photo.
test('states that the large-base shape names are historical, not descriptive', async () => {
  const frozen = await loadSizingFixtures(new URL('../tests/fixtures/beta-sizing/', import.meta.url));
  assert.match(S1_VTO_SHAPE_NAMING, /historical names retained for binding stability/);
  assert.match(S1_VTO_SHAPE_NAMING, /base-photo-ordinary\.jpg/);
  assert.match(S1_VTO_SHAPE_NAMING, /deferred five-garment/);
  assert.ok(sizingVtoCases().every(item => item.base_fixture === 'base-photo-ordinary.jpg'));
  assert.ok(SIZING_WORKLOAD.vto_shapes.some(shape => shape.startsWith('large-base-')));
  // The note is carried by the manifest too, and the loader refuses a manifest
  // that drops it.
  const manifest = JSON.parse(await readFile(new URL('../tests/fixtures/beta-sizing/fixture-manifest.json',
    import.meta.url)));
  assert.equal(manifest.s1_input_envelope.vto_shape_naming, S1_VTO_SHAPE_NAMING);
  assert.ok(frozen.fixtures.has('base-photo-ordinary.jpg'));
  assert.equal(frozen.fixtures.has('base-photo-large.jpg'), false);
});

// The manifest is the only place a future fixture size can enter the workload, so
// the loader itself must refuse an over-bound input rather than trusting the set.
test('refuses a manifest fixture or case input above the demonstrated envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sizing-envelope-'));
  try {
    const accepted = await loadSizingFixtures(new URL('../tests/fixtures/beta-sizing/', import.meta.url));
    const shape = id => ({ id, file: id, mime: accepted.fixtures.get(id).mime, size_class: 'ordinary',
      width: 879, height: 761 });
    // Mirrors the reviewed exclusion record's shape, with a synthetic id and byte
    // count so this test can place any fixture in the excluded list.
    const excludedRecord = (id, bytes) => ({ id, bytes, sha256: 'b'.repeat(64), reason: 'input_bytes_above_envelope' });
    const frozenEntry = (id, bytes) => ({ ...shape(id), bytes: bytes.length, sha256: hashBytes(bytes) });
    const writeFixture = async (id, bytes) => {
      await writeFile(join(directory, id), bytes);
      return frozenEntry(id, bytes);
    };
    const manifest = (fixtures, excluded) => ({ schema_version: 1, fixtures,
      s1_input_envelope: { reference: S1_INPUT_ENVELOPE.reference, run_url: S1_INPUT_ENVELOPE.run_url,
        stage: S1_INPUT_ENVELOPE.stage, e2e_sha: S1_INPUT_ENVELOPE.e2e_sha,
        input_bytes_max: S1_INPUT_BYTES_MAX, largest_served_bytes: S1_INPUT_BYTES_MAX,
        input_bytes_max_basis: S1_INPUT_ENVELOPE.input_bytes_max_basis,
        measured_inputs_basis: S1_INPUT_ENVELOPE.measured_inputs_basis,
        vto_aggregate_limit: S1_INPUT_ENVELOPE.vto_aggregate_limit,
        vto_shape_naming: S1_INPUT_ENVELOPE.vto_shape_naming,
        deferred_vto_shape: S1_DEFERRED_VTO_SHAPE,
        measured_inputs: S1_INPUT_ENVELOPE.measured_inputs,
        excluded_fixtures: excluded ?? S1_INPUT_EXCLUDED_FIXTURES.map(item => excludedRecord(item.id, item.bytes)) } });
    // The frozen manifest is strict JSON with no byte-order mark; write the same here.
    const write = value => writeFile(join(directory, 'fixture-manifest.json'),
      Buffer.from(JSON.stringify(value), 'utf8'));
    // A directory URL must keep its trailing separator, or the manifest URL would
    // resolve against the parent directory instead of this fixture directory.
    const directoryUrl = pathToFileURL(`${directory}/`);

    const inEnvelope = [];
    for (const id of accepted.fixtures.keys()) {
      if (id === 'fixture-manifest.json') continue;
      inEnvelope.push(await writeFixture(id, Buffer.alloc(1_000, 7)));
    }
    assert.equal(inEnvelope.length, accepted.fixtures.size);
    await write(manifest(inEnvelope));
    assert.equal((await loadSizingFixtures(directoryUrl)).fixtures.size, inEnvelope.length);

    // A frozen fixture above the bound is refused, even though the manifest and the
    // file bytes agree with each other.
    // Named replacement, so the over-bound entry is the same slot the case set uses.
    const replace = entry => inEnvelope.map(item => item.id === entry.id ? entry : item);
    const oversize = await writeFixture('sweater-ordinary.png', Buffer.alloc(S1_INPUT_BYTES_MAX + 1, 7));
    await write(manifest(replace(oversize)));
    await assert.rejects(() => loadSizingFixtures(directoryUrl), /above the demonstrated S1 input envelope/);

    // A declared exclusion that disagrees with the reviewed one is refused: the
    // manifest may not quietly re-label, resize or re-order an excluded fixture.
    const stated = S1_INPUT_EXCLUDED_FIXTURES.map(item => excludedRecord(item.id, item.bytes));
    await write(manifest(inEnvelope, [{ ...stated[0], bytes: 1_000 }, ...stated.slice(1)]));
    await assert.rejects(() => loadSizingFixtures(directoryUrl), /Declared excluded sizing fixture/);

    // A case input, not just the frozen set, is checked against the bound — including
    // a VTO case, whose base photo and every garment reference is a payload input.
    assert.throws(() => assertSizingInputEnvelope(S1_INPUT_BYTES_MAX + 1, 'case input'),
      /above the demonstrated S1 input envelope/);
    assert.doesNotThrow(() => assertSizingInputEnvelope(S1_INPUT_BYTES_MAX, 'case input'));
    const oversized = new Map(accepted.fixtures);
    oversized.set('sweater-ordinary.png', { bytes: S1_INPUT_BYTES_MAX + 1 });
    assert.throws(() => assertCaseInputsWithinEnvelope(oversized, [{ fixture: 'sweater-ordinary.png' }]),
      /above the demonstrated S1 input envelope/);
    assert.throws(() => assertCaseInputsWithinEnvelope(oversized, [{ base_fixture: 'sweater-ordinary.png' }]),
      /above the demonstrated S1 input envelope/);
    assert.throws(() => assertCaseInputsWithinEnvelope(oversized,
      [{ base_fixture: 'base-photo-ordinary.jpg', garment_fixtures: ['bag-ordinary.jpg', 'sweater-ordinary.png'] }]),
    /above the demonstrated S1 input envelope/);
    assert.throws(() => assertCaseInputsWithinEnvelope(accepted.fixtures, [{ fixture: 'sweater-large.png' }]),
      /excluded from the demonstrated S1 envelope/);
    assert.throws(() => assertCaseInputsWithinEnvelope(accepted.fixtures, [{ base_fixture: 'base-photo-large.jpg' }]),
      /excluded from the demonstrated S1 envelope/);
    assert.doesNotThrow(() => assertCaseInputsWithinEnvelope(accepted.fixtures,
      [...sizingUploadCases(), ...sizingVtoCases()]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
