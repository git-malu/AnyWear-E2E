import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildV2Compatibility } from './migrate-compatibility.mjs';
import { candidateBuilderTarget, assertCandidateBuilderContext } from './build-v2-candidate.mjs';
import { byteHash, parseStrictJson, payloadDigest, repositories } from './evidence-contract.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';

function environment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'git-malu/AnyWear-E2E',
    GITHUB_REPOSITORY_ID: '1317091305',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/build-v2-candidate.yml@refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '1',
    GH_TOKEN: 'infra-reader',
    SERVICE_ARTIFACT_READ_TOKEN: 'service-reader',
    CLIENT_CONTENTS_READ_TOKEN: 'client-reader',
    ...overrides,
  };
}

test('candidate builder fixes the authorized Infra deployment target', () => {
  assert.deepEqual(candidateBuilderTarget, {
    infraSha: 'bafc3072ea6aee2d5193009c014cb1cf04b43848',
    infraRunId: 37887802281,
    infraRunAttempt: 1,
    infraArtifactId: 11598145428,
    workflowPath: '.github/workflows/build-v2-candidate.yml',
    e2eRepositoryId: '1317091305',
  });
});

test('candidate builder accepts only protected main workflow context and all scoped readers', () => {
  assert.equal(assertCandidateBuilderContext(environment()), true);
  for (const patch of [
    { GITHUB_REPOSITORY: 'git-malu/other' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_WORKFLOW_REF: 'git-malu/AnyWear-E2E/.github/workflows/beta-qualification.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GH_TOKEN: '' },
    { SERVICE_ARTIFACT_READ_TOKEN: undefined },
    { CLIENT_CONTENTS_READ_TOKEN: undefined },
    { GITHUB_RUN_ATTEMPT: '0' },
  ]) assert.throws(() => assertCandidateBuilderContext(environment(patch)));
});

test('candidate builder workflow is read-only and labels its uploaded artifact', async () => {
  const workflow = await readFile(resolve(process.cwd(), '.github/workflows/build-v2-candidate.yml'), 'utf8');
  assert.equal((workflow.match(/actions\/create-github-app-token@v3/g) ?? []).length, 3);
  assert.match(workflow, /permission-contents: read/);
  assert.match(workflow, /permission-actions: read/);
  assert.match(workflow, /permission-attestations: read/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /infra-v2-candidate-\$\{\{ github\.run_id \}\}/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /aws-actions\/configure-aws-credentials/);
  assert.doesNotMatch(workflow, /beta-qualification\.yml/);
  assert.doesNotMatch(workflow, /workflow:\s*run/);
});

function deploymentFixture() {
  const deployment = qualificationFixture().deployment;
  // The migration baseline is built from the committed pins, so the synthetic
  // deployment record must observe those same revisions.
  const committed = parseStrictJson(readFileSync(resolve(process.cwd(), 'compatibility.json')));
  const clientSha = committed.client.sha;
  const serviceSha = committed.service.sha;
  deployment.infra.sha = candidateBuilderTarget.infraSha;
  deployment.infra.run_id = candidateBuilderTarget.infraRunId;
  deployment.infra.run_attempt = candidateBuilderTarget.infraRunAttempt;
  deployment.infra.workflow_ref = `${repositories.infra}/.github/workflows/runtime.yml@refs/heads/main`;
  deployment.observed.client_sha = clientSha;
  deployment.observed.service_sha = serviceSha;
  deployment.schema.verification.service_sha = serviceSha;
  deployment.schema.verification.source_sha = candidateBuilderTarget.infraSha;
  deployment.schema.verification.executor.sha = candidateBuilderTarget.infraSha;
  deployment.schema.verification.executor.run_id = candidateBuilderTarget.infraRunId;
  deployment.schema.verification.executor.run_attempt = candidateBuilderTarget.infraRunAttempt;
  deployment.stacks.forEach((stack) => { stack.source_sha = stack.source_repository === repositories.infra ? candidateBuilderTarget.infraSha : serviceSha; });
  deployment.selection.components.image.service_sha = serviceSha;
  Object.values(deployment.selection.components.lambdas).forEach((value) => { value.service_sha = serviceSha; });
  deployment.selection.components.runtime_policy.service_sha = serviceSha;
  deployment.selection.components.schema.service_sha = serviceSha;
  deployment.selection.release.id = 409515424;
  deployment.selection.release.manifest_asset_id = 630141009;
  deployment.selection.release.manifest_sha256 = 'bc52404eb45842b23a4243a85585aec1278b76743a73c12a4cac85fa785caa47';
  deployment.selection.sha256 = payloadDigest({
    schema_version: 2,
    record_type: 'anywear_infra_selection',
    release: deployment.selection.release,
    ...deployment.selection.components,
  });
  return deployment;
}

function artifactHarness({ artifactId = candidateBuilderTarget.infraArtifactId } = {}) {
  const run = {
    id: candidateBuilderTarget.infraRunId,
    run_attempt: candidateBuilderTarget.infraRunAttempt,
    repository: { full_name: repositories.infra },
    path: '.github/workflows/runtime.yml',
    head_sha: candidateBuilderTarget.infraSha,
    head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    run_started_at: '2098-01-01T00:00:00Z', updated_at: '2098-01-01T00:05:00Z',
  };
  const artifact = {
    id: artifactId, name: `infra-deployment-${run.id}-${run.run_attempt}`, expired: false,
    expires_at: '2099-01-01T00:00:00Z', created_at: '2098-01-01T00:04:00Z',
    workflow_run: { id: run.id, head_sha: run.head_sha },
  };
  const calls = [];
  const api = async (path, binary, env) => {
    calls.push({ path, binary, env });
    if (path === `repos/${repositories.infra}/actions/runs/${run.id}/attempts/${run.run_attempt}`) return JSON.stringify(run);
    if (path.startsWith(`repos/${repositories.infra}/actions/runs/${run.id}/artifacts?`)) return JSON.stringify({ total_count: 1, artifacts: [artifact] });
    if (path === `repos/${repositories.infra}/actions/artifacts/${candidateBuilderTarget.infraArtifactId}/zip`) return Buffer.from('fixed-archive');
    throw new Error(`Unexpected request ${path}`);
  };
  return { run, artifact, calls, api };
}

test('candidate build authenticates only the fixed Infra attempt and passes all scoped readers to migration', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'anywear-v2-builder-test-'));
  const sourceRoot = join(outputRoot, 'source');
  const compatibilityPath = join(sourceRoot, 'compatibility.json');
  const committedCompatibilityBytes = await readFile(resolve(process.cwd(), 'compatibility.json'));
  try {
    const committed = parseStrictJson(committedCompatibilityBytes);
    assert.equal(committed.version, 2);
    assert.equal(byteHash(committedCompatibilityBytes), 'fe42942f1eca73713617d809dc7dca13005936f689f4c13754a99c0e78424ccf');
    // Candidate generation intentionally migrates from a v1 baseline. Keep that
    // legacy input local to this migration test while the repository pins v2.
    const migrationBaseline = {
      version: 1,
      client: committed.client,
      service: committed.service,
    };
    const migrationBaselineBytes = Buffer.from(`${JSON.stringify(migrationBaseline, null, 2)}\n`);
    await cp(resolve(process.cwd(), 'scripts'), join(sourceRoot, 'scripts'), { recursive: true });
    await writeFile(compatibilityPath, migrationBaselineBytes);
    const isolatedBuilder = await import(pathToFileURL(join(sourceRoot, 'scripts/build-v2-candidate.mjs')).href);
    const record = deploymentFixture();
    const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const env = environment({ GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2' });
    const harness = artifactHarness();
    let migrationCalled = false;
    const result = await isolatedBuilder.buildCandidate({
      environment: env,
      outputRoot,
      api: harness.api,
      suppressMigrationErrors: false,
      extractRecord: async (archivePath) => {
        assert.equal(await readFile(archivePath, 'utf8'), 'fixed-archive');
        return recordBytes;
      },
      runMigration: async ({ recordPath, candidatePath, env: migrationEnv }) => {
        migrationCalled = true;
        assert.deepEqual(parseStrictJson(await readFile(recordPath)), record);
        for (const name of ['GH_TOKEN', 'SERVICE_ARTIFACT_READ_TOKEN', 'CLIENT_CONTENTS_READ_TOKEN']) assert.ok(migrationEnv[name]);
        const candidate = buildV2Compatibility(migrationBaseline, record, recordBytes, candidateBuilderTarget.infraArtifactId);
        await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
      },
    });
    assert.deepEqual(await readFile(compatibilityPath), migrationBaselineBytes,
      'candidate generation must not modify the selected compatibility baseline');
    assert.equal(migrationCalled, true);
    assert.equal(result.candidate.version, 2);
    assert.equal(result.candidate.infra.sha, candidateBuilderTarget.infraSha);
    assert.equal(result.candidate.deployment.run_id, candidateBuilderTarget.infraRunId);
    assert.equal(result.candidate.deployment.artifact_id, candidateBuilderTarget.infraArtifactId);
    const note = await readFile(result.notePath, 'utf8');
    assert.match(note, /UNTRUSTED-FOR-MAIN/);
    const provenance = parseStrictJson(await readFile(result.provenancePath));
    assert.equal(provenance.classification, 'untrusted-for-main-pr-review');
    assert.equal(provenance.candidate_sha256, byteHash(await readFile(result.candidatePath)));
    assert.equal(harness.calls.length, 3);
    for (const call of harness.calls) {
      assert.equal(call.env.GH_TOKEN, 'infra-reader');
      assert.equal(call.env.SERVICE_ARTIFACT_READ_TOKEN, undefined);
      assert.equal(call.env.CLIENT_CONTENTS_READ_TOKEN, undefined);
      assert.equal(call.env.GITHUB_TOKEN, undefined);
    }
  } finally {
    assert.deepEqual(await readFile(resolve(process.cwd(), 'compatibility.json')), committedCompatibilityBytes,
      'candidate generation must leave the committed v2 compatibility bytes unchanged');
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('candidate build rejects a different artifact before downloading its contents', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'anywear-v2-builder-test-'));
  try {
    const sourceRoot = join(outputRoot, 'source');
    await cp(resolve(process.cwd(), 'scripts'), join(sourceRoot, 'scripts'), { recursive: true });
    await cp(resolve(process.cwd(), 'compatibility.json'), join(sourceRoot, 'compatibility.json'));
    const isolatedBuilder = await import(pathToFileURL(join(sourceRoot, 'scripts/build-v2-candidate.mjs')).href);
    const harness = artifactHarness({ artifactId: candidateBuilderTarget.infraArtifactId + 1 });
    await assert.rejects(isolatedBuilder.buildCandidate({ environment: environment(), outputRoot, api: harness.api }), /fixed candidate target/);
    assert.equal(harness.calls.some((call) => call.binary), false);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
