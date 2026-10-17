import {
  assertEqual, byteHash, exactKeys, payloadDigest as strictPayloadDigest, repositories,
  parseStrictJson, requireId, requireHash, validateCompatibility,
} from './evidence-contract.mjs';
import { assertDeploymentBinding } from './trusted-deployment-inputs.mjs';
import { assertQualificationEnvironment } from './beta-sizing-environment.mjs';
import { validateDeploymentRecord, validateSnapshot, assertObservedMatchesDeployment } from './vendor/deployment-contract.mjs';
import {
  QUALIFICATION_REPORT_ENV, QUALIFICATION_REPORT_PATH, RECORDABLE_RESULTS, SCENARIO_KEYS, SELECTION_KEYS, TEST_KEYS,
  assertTestSelection, buildTestMember, reportScenarios,
} from './test-selection.mjs';

const commitPattern = /^[0-9a-f]{40}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;

function requireValue(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireCommit(value, label) {
  if (typeof value !== 'string' || !commitPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  }
  return value;
}

function requireImageDigest(value) {
  if (typeof value !== 'string' || !imageDigestPattern.test(value)) {
    throw new Error('Service image identity must be a sha256 OCI digest');
  }
  return value;
}

function requireHttpsUrl(value, label) {
  const url = new URL(requireValue(value, label));
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url.toString().replace(/\/$/, '');
}

async function fetchJson(fetcher, url, label) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return parseStrictJson(Buffer.from(await response.arrayBuffer()));
}

export async function collectDeploymentEvidence(input, compatibility, fetcher = fetch) {
  const clientUrl = requireHttpsUrl(input.clientUrl, 'E2E_CLIENT_URL');
  const serviceUrl = requireHttpsUrl(input.serviceUrl, 'E2E_SERVICE_URL');
  const cacheBuster = encodeURIComponent(input.runId ?? Date.now().toString());
  const clientMetadataUrl = new URL('/build-metadata.json', `${clientUrl}/`);
  clientMetadataUrl.searchParams.set('qualification', cacheBuster);

  const [clientMetadata, serviceHealth] = await Promise.all([
    fetchJson(fetcher, clientMetadataUrl, 'Client build metadata'),
    fetchJson(fetcher, new URL('/health', `${serviceUrl}/`), 'Service health'),
  ]);

  const clientCommit = requireCommit(clientMetadata.source_commit, 'Deployed Client source_commit');
  const serviceCommit = requireCommit(serviceHealth.service_commit, 'Deployed Service service_commit');
  const serviceImageDigest = requireImageDigest(serviceHealth.image_digest);

  if (clientMetadata.component !== 'AnyWear-Client') {
    throw new Error('Client build metadata has an unexpected component identity');
  }
  if (serviceHealth.status !== 'ok') throw new Error('Deployed Service is not healthy');
  if (clientCommit !== compatibility.client.sha) {
    throw new Error('Deployed Client does not match compatibility.json');
  }
  if (serviceCommit !== compatibility.service.sha) {
    throw new Error('Deployed Service does not match compatibility.json');
  }

  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    client: {
      url: clientUrl,
      source_commit: clientCommit,
      built_at: requireValue(clientMetadata.built_at, 'Client built_at'),
    },
    service: {
      url: serviceUrl,
      source_commit: serviceCommit,
      image_digest: serviceImageDigest,
    },
  };
}

export function assertStableDeploymentEvidence(before, after) {
  for (const [component, fields] of [
    ['client', ['url', 'source_commit', 'built_at']],
    ['service', ['url', 'source_commit', 'image_digest']],
  ]) {
    for (const field of fields) {
      const original = requireValue(before[component]?.[field], `Initial ${component} ${field}`);
      const current = requireValue(after[component]?.[field], `Final ${component} ${field}`);
      if (original !== current) {
        throw new Error(`Deployed ${component} ${field} changed during qualification`);
      }
    }
  }
  if (before.schema_version === 2 || after.schema_version === 2) {
    if (before.schema_version !== 2 || after.schema_version !== 2) throw new Error('Observation schema changed during qualification');
    assertEqual(before.compatibility, after.compatibility, 'Reviewed compatibility');
    assertEqual(before.deployment, after.deployment, 'Trusted deployment record');
    assertEqual(before.service_artifacts, after.service_artifacts, 'Immutable Service artifacts');
    const stable = (snapshot) => {
      const copy = structuredClone(snapshot);
      delete copy.schema.verification.executor;
      delete copy.schema.verification.task_arn;
      delete copy.schema.verification.task_definition_arn;
      return copy;
    };
    assertEqual(stable(before.authenticated), stable(after.authenticated), 'Authenticated deployment changed during qualification');
  }
}

export function validateInfraEvidence(evidence, compatibility, executor) {
  validateCompatibility(compatibility);
  exactKeys(evidence, ['schema_version', 'collected_at', 'client', 'service', 'compatibility', 'deployment', 'service_artifacts', 'authenticated'], 'deployment evidence');
  if (evidence.schema_version !== 2 || !Number.isFinite(Date.parse(evidence.collected_at))) throw new Error('Unsupported authenticated evidence schema/date');
  assertEqual(evidence.compatibility, compatibility, 'Observation compatibility');
  assertEqual(evidence.service_artifacts, compatibility.service_artifacts, 'Observation artifact binding');
  validateDeploymentRecord(evidence.deployment);
  assertDeploymentBinding(evidence.deployment, compatibility);
  validateSnapshot(evidence.authenticated);
  assertObservedMatchesDeployment(evidence.deployment, evidence.authenticated);
  exactKeys(evidence.client, ['url', 'source_commit', 'built_at'], 'observed Client');
  exactKeys(evidence.service, ['url', 'source_commit', 'image_digest'], 'observed Service');
  if (evidence.client.source_commit !== compatibility.client.sha || evidence.service.source_commit !== compatibility.service.sha
    || evidence.service.image_digest !== evidence.authenticated.observed.image_digest
    || evidence.client.url !== evidence.authenticated.observed.endpoints.client
    || evidence.service.url !== evidence.authenticated.observed.endpoints.api) throw new Error('HTTP and authenticated AWS identities disagree');
  requireCommit(evidence.client.source_commit, 'Observed Client SHA');
  requireCommit(evidence.service.source_commit, 'Observed Service SHA');
  requireImageDigest(evidence.service.image_digest);
  requireHttpsUrl(evidence.client.url, 'Observed Client endpoint');
  requireHttpsUrl(evidence.service.url, 'Observed Service endpoint');
  if (!Number.isFinite(Date.parse(evidence.client.built_at))) throw new Error('Invalid Client build timestamp');
  if (executor) assertEqual(evidence.authenticated.schema.verification.executor, executor, 'Authenticated observation trusted executor');
  if (evidence.authenticated.schema.verification.source_sha !== compatibility.infra.sha) throw new Error('Observation command source differs from reviewed Infra');
  return evidence;
}

// The environment verdict is a required argument, not an option: this is the only path
// that writes `qualification-record.json`, and a passing suite measured across two worker
// task definitions measured neither of them, so it cannot issue a qualification record.
// The assertion denies by default, so no caller can build a record without stating the
// environment gate it consulted.
//
// The run's Playwright JSON report bytes are the sixth required argument for the same
// reason: the record states which scenarios ran and how many of each spec's tests were
// collected and skipped, and none of that can be inferred from a suite that merely ended
// green. The report is where the record's `test` member comes from, so a caller that does
// not hold it cannot state what it measured.
// #163: the record is produced only by the `full` operation of the single `qualify` entry.
// The operation is read from the dispatch event (`E2E_OPERATION`) rather than inferred from
// the workflow file, and it is written into the payload so the validator and the Infra-side
// executor allow-list can re-check the binding. `smoke`, `measure` and `recover` share the
// dispatch surface but cannot reach this function with a recordable operation.
//
// The `operation` member is additive to the v2 record, not a v3 bump. Infra's
// `scripts/production-preflight.mjs` requires a flat `anywear_beta_qualification` v2 record
// (`payload === undefined`) and validates its named fields rather than an exact top-level
// key set, so an added member stays compatible with the current consumer. A v3 bump would
// make every existing v2 consumer reject the record and would need a matching Infra change;
// #163 therefore records the decision as additive v2.
export function buildQualificationRecord(input, compatibility, evidence, now = new Date(), environment, reportBytes) {
  if (input.result !== 'passed') {
    throw new Error('Only a completed passing test run can issue a qualification record');
  }
  if (input.operation !== 'full') {
    throw new Error('Only the full qualification operation can issue a qualification record');
  }
  assertQualificationEnvironment(environment);
  if (reportBytes === undefined || reportBytes === null) {
    throw new Error(`The qualification record requires the run's Playwright JSON report bytes at ${QUALIFICATION_REPORT_PATH}; ${QUALIFICATION_REPORT_ENV} names that path and the release-gating suite step writes it`);
  }

  validateCompatibility(compatibility);
  exactKeys(evidence, ['before', 'after'], 'qualification observations');
  if (input.repository !== repositories.e2e || input.workflowPath !== '.github/workflows/beta-qualification.yml'
    || input.workflowRef !== `${repositories.e2e}/.github/workflows/beta-qualification.yml@refs/heads/main`) throw new Error('Only protected Beta Qualification can issue v2 records');
  const executor = {
    repository: repositories.e2e, sha: requireCommit(input.e2eSha, 'E2E SHA'),
    workflow_path: input.workflowPath,
    run_id: requireId(Number(input.runId), 'E2E run'), run_attempt: requireId(Number(input.runAttempt), 'E2E attempt'),
  };
  validateInfraEvidence(evidence.before, compatibility, executor);
  validateInfraEvidence(evidence.after, compatibility, executor);
  assertStableDeploymentEvidence(evidence.before, evidence.after);
  assertObservationSequence(evidence, now.toISOString());
  const after = evidence.after;
  if (input.awsAccountId !== '650880818323' || input.awsRegion !== 'ap-east-1') throw new Error('Qualification must observe the reviewed Beta account/region');
  if (input.serverUrl !== 'https://github.com') throw new Error('Qualification must bind GitHub.com');
  const payload = {
    schema_version: 2,
    record_type: 'anywear_beta_qualification',
    qualification_id: `beta-${requireValue(input.runId, 'GITHUB_RUN_ID')}-${requireValue(input.runAttempt, 'GITHUB_RUN_ATTEMPT')}`,
    result: 'passed',
    operation: 'full',
    qualified_at: now.toISOString(),
    environment: {
      stage: 'beta',
      aws_account_id: requireValue(input.awsAccountId, 'AWS_ACCOUNT_ID'),
      aws_region: requireValue(input.awsRegion, 'AWS_REGION'),
      client_url: requireHttpsUrl(after.client.url, 'Client URL'),
      service_url: requireHttpsUrl(after.service.url, 'Service URL'),
    },
    revisions: {
      e2e: {
        repository: requireValue(input.repository, 'GITHUB_REPOSITORY'),
        sha: requireCommit(input.e2eSha, 'E2E SHA'),
      },
      client: {
        repository: compatibility.client.repository,
        sha: requireCommit(after.client.source_commit, 'Client SHA'),
      },
      service: {
        repository: compatibility.service.repository,
        sha: requireCommit(after.service.source_commit, 'Service SHA'),
        image_digest: requireImageDigest(after.service.image_digest),
      },
      infra: compatibility.infra,
    },
    compatibility,
    service_artifacts: compatibility.service_artifacts,
    deployment: { identity: compatibility.deployment, record: after.deployment },
    observations: evidence,
    // Which tests this record covers is derived from the run and this checkout, never
    // written as a literal: the invocation the qualification workflow's suite step ran,
    // the tag that invocation selects, the run's own report digest, and one entry per
    // selected spec with its outcome and its collected/skipped counts.
    test: buildTestMember(reportBytes),
    workflow: {
      repository: repositories.e2e,
      path: input.workflowPath,
      ref: input.workflowRef,
      run_id: executor.run_id,
      run_attempt: executor.run_attempt,
      run_url: `${requireValue(input.serverUrl, 'GITHUB_SERVER_URL')}/${input.repository}/actions/runs/${input.runId}`,
    },
  };

  if (payload.revisions.client.sha !== compatibility.client.sha) {
    throw new Error('Qualification Client SHA does not match compatibility.json');
  }
  if (payload.revisions.service.sha !== compatibility.service.sha) {
    throw new Error('Qualification Service SHA does not match compatibility.json');
  }

  return {
    ...payload,
    integrity: {
      algorithm: 'sha256',
      payload_sha256: strictPayloadDigest(payload),
    },
  };
}

export function verifyQualificationRecord(record, { trustedRun } = {}) {
  if (record.schema_version !== 2 || record.record_type !== 'anywear_beta_qualification') {
    throw new Error('Unsupported qualification record schema');
  }
  exactKeys(record, ['schema_version', 'record_type', 'qualification_id', 'result', 'operation', 'qualified_at', 'environment', 'revisions', 'compatibility', 'service_artifacts', 'deployment', 'observations', 'test', 'workflow', 'integrity'], 'qualification');
  exactKeys(record.test, TEST_KEYS, 'test result');
  exactKeys(record.test.selection, SELECTION_KEYS, 'test selection');
  if (!Array.isArray(record.test.scenarios) || record.test.scenarios.length === 0) {
    throw new Error('test result.scenarios must be a non-empty list of selected scenarios');
  }
  for (const scenario of record.test.scenarios) {
    exactKeys(scenario, SCENARIO_KEYS, `test scenario ${scenario?.file}`);
  }
  requireHash(record.test.report_sha256, 'Qualification report checksum');
  if (record.result !== 'passed' || record.test.runner !== 'playwright' || !RECORDABLE_RESULTS.includes(record.test.result)) {
    throw new Error('Qualification record is not passing');
  }
  // The signed operation is re-checked here, not trusted from the payload: a record that
  // names any operation other than `full` cannot qualify regardless of its checksum.
  if (record.operation !== 'full') throw new Error('Qualification record operation must be full');
  exactKeys(record.integrity, ['algorithm', 'payload_sha256'], 'qualification integrity');
  requireHash(record.integrity.payload_sha256, 'Qualification payload checksum');
  if (record.integrity.algorithm !== 'sha256') {
    throw new Error('Qualification record integrity algorithm must be sha256');
  }

  const { integrity, ...payload } = record;
  if (integrity.payload_sha256 !== strictPayloadDigest(payload)) {
    throw new Error('Qualification record checksum mismatch');
  }
  // Re-derived only after the payload checksum, so a record tampered with anywhere still
  // reports the checksum mismatch first. This is the half that refuses a record whose
  // stated selection or scenario list does not match the workflow, `package.json`, the spec
  // titles and the scenario inventory of the checkout that judges it.
  assertTestSelection(payload.test);
  validateCompatibility(payload.compatibility);
  exactKeys(payload.workflow, ['repository', 'path', 'ref', 'run_id', 'run_attempt', 'run_url'], 'qualification workflow');
  const workflow = payload.workflow;
  requireId(workflow.run_id, 'Qualification run'); requireId(workflow.run_attempt, 'Qualification attempt');
  if (workflow.repository !== repositories.e2e || workflow.path !== '.github/workflows/beta-qualification.yml'
    || workflow.ref !== `${repositories.e2e}/${workflow.path}@refs/heads/main`
    || workflow.run_url !== `https://github.com/${repositories.e2e}/actions/runs/${workflow.run_id}`
    || payload.qualification_id !== `beta-${workflow.run_id}-${workflow.run_attempt}`) throw new Error('Qualification workflow binding mismatch');
  exactKeys(payload.revisions, ['e2e', 'client', 'service', 'infra'], 'revisions');
  for (const component of ['e2e', 'client', 'service', 'infra']) {
    exactKeys(payload.revisions[component], component === 'service' ? ['repository', 'sha', 'image_digest'] : ['repository', 'sha'], `${component} revision`);
    if (payload.revisions[component].repository !== repositories[component]) throw new Error('Qualification repository mismatch');
    requireCommit(payload.revisions[component].sha, `${component} SHA`);
  }
  exactKeys(payload.environment, ['stage', 'aws_account_id', 'aws_region', 'client_url', 'service_url'], 'qualification environment');
  if (payload.environment.stage !== 'beta' || payload.environment.aws_account_id !== '650880818323' || payload.environment.aws_region !== 'ap-east-1') throw new Error('Qualification account/region mismatch');
  if (!Number.isFinite(Date.parse(payload.qualified_at))) throw new Error('Invalid qualification timestamp');
  exactKeys(payload.observations, ['before', 'after'], 'observations');
  const executor = { repository: repositories.e2e, sha: payload.revisions.e2e.sha, workflow_path: workflow.path, run_id: workflow.run_id, run_attempt: workflow.run_attempt };
  validateInfraEvidence(payload.observations.before, payload.compatibility, executor);
  validateInfraEvidence(payload.observations.after, payload.compatibility, executor);
  assertStableDeploymentEvidence(payload.observations.before, payload.observations.after);
  assertObservationSequence(payload.observations, payload.qualified_at);
  exactKeys(payload.deployment, ['identity', 'record'], 'qualification deployment');
  assertEqual(payload.deployment.identity, payload.compatibility.deployment, 'Qualified deployment identity');
  assertEqual(payload.deployment.record, payload.observations.after.deployment, 'Qualified deployment record');
  assertEqual(payload.service_artifacts, payload.compatibility.service_artifacts, 'Qualified Service artifacts');
  for (const component of ['client', 'service', 'infra']) {
    if (payload.revisions[component].sha !== payload.compatibility[component].sha) throw new Error('Qualified revision compatibility mismatch');
  }
  if (payload.revisions.service.image_digest !== payload.observations.after.service.image_digest
    || payload.environment.client_url !== payload.observations.after.client.url
    || payload.environment.service_url !== payload.observations.after.service.url) throw new Error('Qualification runtime binding mismatch');
  if (trustedRun && (trustedRun.id !== workflow.run_id || trustedRun.run_attempt !== workflow.run_attempt
    || trustedRun.head_sha !== payload.revisions.e2e.sha || trustedRun.repository?.full_name !== repositories.e2e
    || trustedRun.path !== workflow.path || trustedRun.event !== 'workflow_dispatch' || trustedRun.head_branch !== 'main'
    || trustedRun.status !== 'completed' || trustedRun.conclusion !== 'success')) throw new Error('Trusted E2E run binding mismatch');
  return true;
}

// The producer's own next step, run in the job that wrote both files: it refuses a record
// hand-edited between the report the suite wrote and the artifact upload. The report itself
// is retained in the qualification artifact, so the digest the record states is auditable
// against the bytes it names instead of being an unchecked claim.
export function verifyQualificationAgainstReport(record, reportBytes) {
  if (reportBytes === undefined || reportBytes === null) {
    throw new Error(`Verifying a qualification record against its run requires the Playwright JSON report bytes at ${QUALIFICATION_REPORT_PATH}`);
  }
  if (record?.test?.report_sha256 !== byteHash(reportBytes)) {
    throw new Error('Qualification record and Playwright report checksums differ');
  }
  assertEqual(record.test.scenarios, reportScenarios(reportBytes), 'Qualification scenarios and the Playwright report');
  return true;
}

export function assertObservationSequence({ before, after }, qualifiedAt) {
  const times = [before.collected_at, after.collected_at, qualifiedAt].map(Date.parse);
  if (times.some((value) => !Number.isFinite(value)) || times[0] >= times[1] || times[1] > times[2]) throw new Error('Qualification observations must occur before and after the suite in order');
  if (before.authenticated.schema.verification.task_arn === after.authenticated.schema.verification.task_arn) throw new Error('Before and after observations require distinct authenticated verification tasks');
}

// Producer self-checks run while their workflow is still in progress. A release
// consumer must use this stricter entry point after downloading the exact pinned
// artifact, not infer authenticity from the payload's checksum alone.
export function verifyQualificationForPromotion(record, { trustedRun, trustedArtifact, expected, recordBytes, now = Date.now() } = {}) {
  if (!trustedRun || !trustedArtifact || !expected || !recordBytes) throw new Error('Promotion requires authenticated run/artifact metadata and pinned record bytes');
  verifyQualificationRecord(record, { trustedRun });
  if (trustedArtifact.id !== expected.artifact_id || trustedArtifact.expired !== false
    || Date.parse(trustedArtifact.expires_at) <= now || !Number.isFinite(Date.parse(trustedArtifact.expires_at))
    || trustedArtifact.name !== `beta-qualification-${trustedRun.id}-${trustedRun.run_attempt}`
    || trustedArtifact.workflow_run?.id !== trustedRun.id || trustedArtifact.workflow_run?.head_sha !== trustedRun.head_sha
    || expected.run_id !== trustedRun.id || expected.run_attempt !== trustedRun.run_attempt
    || expected.e2e_sha !== trustedRun.head_sha) throw new Error('Trusted qualification artifact binding or lifetime mismatch');
  const bytesHash = byteHash(recordBytes);
  requireHash(expected.record_sha256, 'Pinned qualification record checksum');
  if (bytesHash !== expected.record_sha256) throw new Error('Pinned qualification exact-byte checksum mismatch');
  assertEqual(parseStrictJson(recordBytes), record, 'Downloaded qualification bytes');
  const start = Date.parse(trustedRun.run_started_at);
  const end = Date.parse(trustedRun.updated_at);
  const created = Date.parse(trustedArtifact.created_at);
  if (![start, end, created].every(Number.isFinite) || created < start || created > end
    || Date.parse(record.observations.before.collected_at) < start || Date.parse(record.qualified_at) > end) throw new Error('Qualification evidence does not belong to the trusted attempt interval');
  return true;
}
