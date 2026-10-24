import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { contentHash } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { DRIFT_OUTPUT_KEYS, RUNS_BOUND, verifySmokeDrift } from './verify-smoke-drift.mjs';

// A minimal valid ZIP builder (the same structure `artifact-zip.test.mjs` exercises with
// hostile inputs; here it only needs to be valid).
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const bytes = Buffer.from(data);
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const makeRun = (id, { attempt = 1, headSha = 'e'.repeat(40), created = '2026-10-01T00:00:00Z' } = {}) => ({
  id, run_attempt: attempt, head_sha: headSha, status: 'completed', conclusion: 'success',
  event: 'workflow_dispatch', head_branch: 'main', created_at: created,
});
const makeArtifact = (run, { id, expired = false, created = '2026-10-07T13:00:00Z', name } = {}) => ({
  id, name: name ?? `tested-revisions-${run.id}-${run.run_attempt}`, size_in_bytes: 2048,
  expired, created_at: created, expires_at: '2026-12-01T00:00:00Z',
  workflow_run: { id: run.id, head_sha: run.head_sha },
});

// The injectable seam standing in for `ghApi`: answers the runs enumeration, the per-run
// artifact lists, the gated binary artifact zip downloads, and (for --verify-recorded)
// the artifact/run metadata reads.
function fakeApi({ runs = [], artifacts = {}, zips = {}, artifactMeta = {}, runMeta = {}, calls = [] } = {}) {
  return (path, binary) => {
    calls.push(path);
    if (/\/actions\/workflows\/beta-qualification\.yml\/runs/.test(path)) {
      return JSON.stringify({ total_count: runs.length, workflow_runs: runs });
    }
    const artifactsMatch = /^repos\/git-malu\/AnyWear-E2E\/actions\/runs\/(\d+)\/artifacts/.exec(path);
    if (artifactsMatch) {
      const list = artifacts[artifactsMatch[1]] ?? [];
      return JSON.stringify({ total_count: list.length, artifacts: list });
    }
    const zipMatch = /^repos\/git-malu\/AnyWear-E2E\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
    if (zipMatch) {
      assert.equal(binary, true, 'artifact downloads must go through the gated binary path');
      return zips[zipMatch[1]];
    }
    const artifactMatch = /^repos\/git-malu\/AnyWear-E2E\/actions\/artifacts\/(\d+)$/.exec(path);
    if (artifactMatch) return JSON.stringify(artifactMeta[artifactMatch[1]]);
    const runMatch = /^repos\/git-malu\/AnyWear-E2E\/actions\/runs\/(\d+)$/.exec(path);
    if (runMatch) return JSON.stringify(runMeta[runMatch[1]]);
    throw new Error(`unexpected api path ${path}`);
  };
}

async function setup({ mutateSmoke, mutateBaseline, smokeAt = '2026-10-07T12:00:00.000Z', zipFor } = {}) {
  const f = qualificationFixture();
  const baseline = structuredClone(f.evidence.before);
  mutateBaseline?.(baseline);
  const smoke = structuredClone(f.evidence.before);
  smoke.collected_at = smokeAt;
  mutateSmoke?.(smoke);
  const directory = await mkdtemp(join(tmpdir(), 'smoke-drift-'));
  const baselinePath = join(directory, 'deployment-evidence-before.json');
  const outputPath = join(directory, 'smoke-drift.json');
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  const zip = zipFor ?? buildZip([{ name: 'deployment-evidence.json', data: `${JSON.stringify(smoke, null, 2)}\n` }]);
  return { f, baseline, smoke, directory, baselinePath, outputPath, zip };
}

const expectedRefusal = /run a smoke for this release, then re-run full/;
const describeIdentity = (f) => `Service ${f.serviceSha} \\(${f.image}\\) with Client ${f.clientSha}`;

test('the acceptance case: the matching smoke observation agrees and the drift file is written', async () => {
  const { f, smoke, directory, baselinePath, outputPath, zip } = await setup();
  const run = makeRun(900, { created: '2026-10-07T13:00:00Z' });
  const artifact = makeArtifact(run, { id: 70 });
  const api = fakeApi({
    runs: [run],
    artifacts: { [run.id]: [artifact] },
    zips: { [artifact.id]: zip },
  });
  const drift = await verifySmokeDrift({ baselinePath, outputPath, api, now: () => new Date('2026-10-08T00:05:00.000Z') });
  assert.deepEqual(Object.keys(drift).sort(), [...DRIFT_OUTPUT_KEYS].sort());
  assert.equal(drift.smoke_run_id, 900);
  assert.equal(drift.smoke_run_attempt, 1);
  assert.equal(drift.smoke_run_head_sha, 'e'.repeat(40));
  assert.equal(drift.smoke_artifact_id, 70);
  assert.equal(drift.smoke_created_at, artifact.created_at);
  assert.equal(drift.matched_service_commit, smoke.service.service_commit);
  assert.equal(drift.matched_image_digest, smoke.service.image_digest);
  assert.equal(drift.matched_client_commit, smoke.client.source_commit);
  assert.equal(drift.result, 'matched');
  assert.equal(drift.checked_at, '2026-10-08T00:05:00.000Z');
  const written = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(written, drift);
  await rm(directory, { recursive: true, force: true });
  void f;
});

test('several smoke runs match the same release: the newest run wins and only its zip is downloaded', async () => {
  const { directory, baselinePath, outputPath, zip } = await setup();
  const older = makeRun(800, { created: '2026-10-06T13:00:00Z' });
  const newer = makeRun(900, { created: '2026-10-07T13:00:00Z' });
  const olderArtifact = makeArtifact(older, { id: 60, created: '2026-10-06T13:05:00Z' });
  const newerArtifact = makeArtifact(newer, { id: 70, created: '2026-10-07T13:05:00Z' });
  const calls = [];
  const api = fakeApi({
    runs: [newer, older],
    artifacts: { [older.id]: [olderArtifact], [newer.id]: [newerArtifact] },
    zips: { [olderArtifact.id]: zip, [newerArtifact.id]: zip },
    calls,
  });
  const drift = await verifySmokeDrift({ baselinePath, outputPath, api });
  assert.equal(drift.smoke_run_id, 900);
  assert.equal(drift.smoke_artifact_id, 70);
  assert.equal(calls.some((path) => path.endsWith(`/artifacts/${olderArtifact.id}/zip`)), false,
    'the older run must not be downloaded once the newest match is found');
  await rm(directory, { recursive: true, force: true });
});

test('a candidate whose release identity differs is skipped for the older matching run', async () => {
  const { f, directory, baselinePath, outputPath, zip } = await setup();
  const wrongRelease = structuredClone(f.evidence.before);
  wrongRelease.collected_at = '2026-10-07T12:00:00.000Z';
  wrongRelease.service.service_commit = 'f'.repeat(40);
  const wrongZip = buildZip([{ name: 'deployment-evidence.json', data: `${JSON.stringify(wrongRelease, null, 2)}\n` }]);
  const newer = makeRun(900, { created: '2026-10-07T13:00:00Z' });
  const older = makeRun(800, { created: '2026-10-06T13:00:00Z' });
  const wrongArtifact = makeArtifact(newer, { id: 70 });
  const rightArtifact = makeArtifact(older, { id: 60 });
  const api = fakeApi({
    runs: [newer, older],
    artifacts: { [newer.id]: [wrongArtifact], [older.id]: [rightArtifact] },
    zips: { [wrongArtifact.id]: wrongZip, [rightArtifact.id]: zip },
  });
  const drift = await verifySmokeDrift({ baselinePath, outputPath, api });
  assert.equal(drift.smoke_run_id, 800);
  await rm(directory, { recursive: true, force: true });
});

test('no match within the bound refuses and names the release identity', async () => {
  const { f, directory, baselinePath, outputPath } = await setup();
  for (const { label, runs, artifacts, zips, pattern } of [
    { label: 'no runs', runs: [], artifacts: {}, zips: {}, pattern: new RegExp(`No deploy-smoke observation matches ${describeIdentity(f)}`) },
    { label: 'runs without the artifact name', runs: [makeRun(900)], artifacts: { 900: [{ id: 1, name: 'other-900-1', expired: false, workflow_run: { id: 900 } }] }, zips: {}, pattern: new RegExp(`No deploy-smoke observation matches ${describeIdentity(f)}`) },
  ]) {
    const api = fakeApi({ runs, artifacts, zips });
    await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api }), pattern, label);
    await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api }), expectedRefusal, label);
  }
  // A run the payload claims but that is not a completed-success workflow_dispatch run on
  // main is refused loudly instead of being silently skipped.
  const lyingApi = fakeApi({ runs: [{ ...makeRun(900), conclusion: 'failure' }], artifacts: {}, zips: {} });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api: lyingApi }), /non-qualifying run/);
  await rm(directory, { recursive: true, force: true });
});

test('the enumeration is bounded to the 30 newest runs', async () => {
  const { directory, baselinePath, outputPath, zip } = await setup();
  const runs = Array.from({ length: 30 }, (_, index) => makeRun(1000 - index));
  const matchRun = makeRun(500);
  const artifact = makeArtifact(matchRun, { id: 70 });
  const calls = [];
  const api = fakeApi({
    runs: [...runs, matchRun], // 31 runs: the match sits beyond the 30-run bound
    artifacts: { [matchRun.id]: [artifact] },
    zips: { [artifact.id]: zip },
    calls,
  });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api }), /No deploy-smoke observation matches/);
  assert.ok(calls[0].includes(`per_page=${RUNS_BOUND}`), 'the runs request must name the reviewed bound');
  await rm(directory, { recursive: true, force: true });
});

test('an expired or malformed matching artifact is a loud refusal naming the release identity', async () => {
  const { f, directory, baselinePath, outputPath } = await setup();
  const run = makeRun(900);
  const expiredArtifact = makeArtifact(run, { id: 70, expired: true });
  const expiredApi = fakeApi({ runs: [run], artifacts: { [run.id]: [expiredArtifact] }, zips: {} });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api: expiredApi }),
    new RegExp(`Deploy-smoke drift refused for ${describeIdentity(f)}: the tested-revisions artifact 70 of run 900 is expired`));
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api: expiredApi }), expectedRefusal);

  const malformedArtifact = makeArtifact(run, { id: 71 });
  const malformedZip = buildZip([{ name: 'deployment-evidence.json', data: 'not-json' }]);
  const malformedApi = fakeApi({ runs: [run], artifacts: { [run.id]: [malformedArtifact] }, zips: { [malformedArtifact.id]: malformedZip } });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api: malformedApi }),
    /artifact 71 of run 900 is not a valid discovery observation/);
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api: malformedApi }), expectedRefusal);

  // A pre-change artifact (the old object-shaped lambdas / queue_config_sha256) does not
  // validate under the discovered shape and is refused as no evidence.
  const { zip: oldShapeZip } = await setup({
    mutateSmoke: (observation) => {
      observation.platform.lambdas = {
        'pre-sign-up': { code_sha256: observation.platform.lambdas[1].code_sha256, configuration_sha256: observation.platform.lambdas[1].configuration_sha256 },
      };
      observation.platform.queue_config_sha256 = 'a'.repeat(64);
      delete observation.platform.queues;
    },
  });
  const oldShapeApi = fakeApi({ runs: [run], artifacts: { [run.id]: [malformedArtifact] }, zips: { [malformedArtifact.id]: oldShapeZip } });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api: oldShapeApi }),
    /artifact 71 of run 900 is not a valid discovery observation/);
  await rm(directory, { recursive: true, force: true });
});

test('one mutated recorded member fails the run and the refusal names that member', async () => {
  const { directory, zip } = await setup();
  const run = makeRun(900);
  const artifact = makeArtifact(run, { id: 70 });
  const mutations = [
    ['platform.queues[0].maxReceives', (o) => { o.platform.queues[0].maxReceives = 4; }, /Deploy-smoke observation mismatch at <root>\.platform\.queues\[0\]\.maxReceives: expected 3, observed 4/],
    ['platform.lambdas[0].code_sha256', (o) => { o.platform.lambdas[0].code_sha256 = Buffer.from('f'.repeat(64), 'hex').toString('base64'); }, /Deploy-smoke observation mismatch at <root>\.platform\.lambdas\[0\]\.code_sha256/],
    ['platform.stacks[0].template_sha256', (o) => { o.platform.stacks[0].template_sha256 = 'f'.repeat(64); }, /Deploy-smoke observation mismatch at <root>\.platform\.stacks\[0\]\.template_sha256/],
    // A version change also re-derives the observation's own schema_sha256 (each
    // observation is self-consistent); the drift is the differing member itself.
    ['platform.inputs[0].version', (o) => {
      o.platform.inputs[0].version = '9';
      o.platform.schema_sha256 = contentHash(o.platform.inputs.map(({ parameter, version }) => ({ parameter, version })));
    }, /Deploy-smoke observation mismatch at <root>\.platform\.inputs\[0\]\.version: expected "1", observed "9"/],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const { baselinePath: mutatedPath, directory: mutatedDirectory } = await setup({ mutateBaseline: mutate });
    const api = fakeApi({ runs: [run], artifacts: { [run.id]: [artifact] }, zips: { [artifact.id]: zip } });
    await assert.rejects(verifySmokeDrift({ baselinePath: mutatedPath, outputPath: join(mutatedDirectory, 'smoke-drift.json'), api }), pattern, label);
    await rm(mutatedDirectory, { recursive: true, force: true });
  }
  await rm(directory, { recursive: true, force: true });
});

test('a smoke observation collected after the qualification observation is refused', async () => {
  const { directory, baselinePath, outputPath, zip } = await setup({ smokeAt: '2026-10-08T00:05:00.000Z' });
  const run = makeRun(900);
  const artifact = makeArtifact(run, { id: 70 });
  const api = fakeApi({ runs: [run], artifacts: { [run.id]: [artifact] }, zips: { [artifact.id]: zip } });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api }),
    /was collected after the qualification observation/);
  await rm(directory, { recursive: true, force: true });
});

test('--verify-recorded re-proves the recorded artifact against the live metadata and the baseline', async () => {
  const { f, smoke, directory, baselinePath, outputPath, zip } = await setup();
  const run = makeRun(900, { created: '2026-10-07T13:00:00Z' });
  const artifact = makeArtifact(run, { id: 70, created: '2026-10-07T13:05:00Z' });
  const api = fakeApi({
    runs: [run],
    artifacts: { [run.id]: [artifact] },
    zips: { [artifact.id]: zip },
    artifactMeta: { [artifact.id]: artifact },
    runMeta: { [run.id]: run },
  });
  const drift = await verifySmokeDrift({ baselinePath, outputPath, api });
  assert.equal(drift.smoke_artifact_id, 70);
  const reProved = await verifySmokeDrift({ baselinePath, outputPath, api, verifyRecorded: true });
  assert.equal(reProved.smoke_run_id, 900);
  assert.equal(reProved.matched_service_commit, smoke.service.service_commit);

  // A tampered recorded file whose live metadata no longer matches (renamed artifact,
  // wrong head sha, expired artifact, missing file) is refused without a download.
  const tamperedPath = join(directory, 'tampered.json');
  await writeFile(tamperedPath, JSON.stringify({ ...drift }, null, 2));
  const tamperedApi = fakeApi({
    runs: [run], artifacts: { [run.id]: [artifact] }, zips: {},
    artifactMeta: { [artifact.id]: { ...artifact, name: 'tested-revisions-900-2' } }, runMeta: { [run.id]: run },
  });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath: tamperedPath, api: tamperedApi, verifyRecorded: true }),
    /Recorded smoke drift does not match the artifact 70 and run 900 metadata/);
  const wrongHeadPath = join(directory, 'wrong-head.json');
  await writeFile(wrongHeadPath, JSON.stringify({ ...drift }, null, 2));
  const wrongHeadApi = fakeApi({
    runs: [run], artifacts: { [run.id]: [artifact] }, zips: {},
    artifactMeta: { [artifact.id]: artifact }, runMeta: { [run.id]: { ...run, head_sha: 'a'.repeat(40) } },
  });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath: wrongHeadPath, api: wrongHeadApi, verifyRecorded: true }),
    /Recorded smoke drift does not match the artifact 70 and run 900 metadata/);
  const expiredPath = join(directory, 'expired.json');
  await writeFile(expiredPath, JSON.stringify({ ...drift }, null, 2));
  const expiredApi = fakeApi({
    runs: [run], artifacts: { [run.id]: [artifact] }, zips: {},
    artifactMeta: { [artifact.id]: { ...artifact, expired: true } }, runMeta: { [run.id]: run },
  });
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath: expiredPath, api: expiredApi, verifyRecorded: true }),
    /Recorded smoke drift does not match the artifact 70 and run 900 metadata/);
  await assert.rejects(verifySmokeDrift({
    baselinePath, outputPath: join(directory, 'missing.json'), api: expiredApi, verifyRecorded: true,
  }), /recorded smoke drift file is missing/);
  void f;
  await rm(directory, { recursive: true, force: true });
});

test('the release identity in the recorded file must match the qualification observation', async () => {
  const { directory, baselinePath, outputPath, zip } = await setup();
  const run = makeRun(900);
  const artifact = makeArtifact(run, { id: 70 });
  const api = fakeApi({
    runs: [run], artifacts: { [run.id]: [artifact] }, zips: { [artifact.id]: zip },
    artifactMeta: { [artifact.id]: artifact }, runMeta: { [run.id]: run },
  });
  await verifySmokeDrift({ baselinePath, outputPath, api });
  const recorded = JSON.parse(await readFile(outputPath, 'utf8'));
  recorded.matched_service_commit = 'f'.repeat(40);
  await writeFile(outputPath, JSON.stringify(recorded, null, 2));
  await assert.rejects(verifySmokeDrift({ baselinePath, outputPath, api, verifyRecorded: true }),
    /Recorded smoke drift identity does not match the qualification observation/);
  await rm(directory, { recursive: true, force: true });
});
