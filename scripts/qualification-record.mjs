import { createHash } from 'node:crypto';

const commitPattern = /^[0-9a-f]{40}$/;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/;

function requireValue(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireCommit(value, label) {
  if (!commitPattern.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-character commit SHA`);
  }
  return value;
}

function requireImageDigest(value) {
  if (!imageDigestPattern.test(value)) {
    throw new Error('Service image identity must be a sha256 OCI digest');
  }
  return value;
}

function requireHttpsUrl(value, label) {
  const url = new URL(requireValue(value, label));
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return url.toString().replace(/\/$/, '');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function payloadDigest(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

async function fetchJson(fetcher, url, label) {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
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

export function buildQualificationRecord(input, compatibility, evidence, now = new Date()) {
  if (input.result !== 'passed') {
    throw new Error('Only a completed passing test run can issue a qualification record');
  }

  const payload = {
    schema_version: 1,
    record_type: 'anywear_beta_qualification',
    qualification_id: `beta-${requireValue(input.runId, 'GITHUB_RUN_ID')}-${requireValue(input.runAttempt, 'GITHUB_RUN_ATTEMPT')}`,
    result: 'passed',
    qualified_at: now.toISOString(),
    environment: {
      stage: 'beta',
      aws_account_id: requireValue(input.awsAccountId, 'AWS_ACCOUNT_ID'),
      aws_region: requireValue(input.awsRegion, 'AWS_REGION'),
      client_url: requireHttpsUrl(evidence.client.url, 'Client URL'),
      service_url: requireHttpsUrl(evidence.service.url, 'Service URL'),
    },
    revisions: {
      e2e: {
        repository: requireValue(input.repository, 'GITHUB_REPOSITORY'),
        sha: requireCommit(input.e2eSha, 'E2E SHA'),
      },
      client: {
        repository: compatibility.client.repository,
        sha: requireCommit(evidence.client.source_commit, 'Client SHA'),
      },
      service: {
        repository: compatibility.service.repository,
        sha: requireCommit(evidence.service.source_commit, 'Service SHA'),
        image_digest: requireImageDigest(evidence.service.image_digest),
      },
    },
    test: {
      runner: 'playwright',
      suite: 'complete',
      result: 'passed',
    },
    workflow: {
      run_id: input.runId,
      run_attempt: input.runAttempt,
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
      payload_sha256: payloadDigest(payload),
    },
  };
}

export function verifyQualificationRecord(record) {
  if (record.schema_version !== 1 || record.record_type !== 'anywear_beta_qualification') {
    throw new Error('Unsupported qualification record schema');
  }
  if (record.result !== 'passed' || record.test?.result !== 'passed') {
    throw new Error('Qualification record is not passing');
  }
  if (record.integrity?.algorithm !== 'sha256') {
    throw new Error('Qualification record integrity algorithm must be sha256');
  }

  const { integrity, ...payload } = record;
  if (integrity.payload_sha256 !== payloadDigest(payload)) {
    throw new Error('Qualification record checksum mismatch');
  }
  requireCommit(payload.revisions?.e2e?.sha, 'E2E SHA');
  requireCommit(payload.revisions?.client?.sha, 'Client SHA');
  requireCommit(payload.revisions?.service?.sha, 'Service SHA');
  requireImageDigest(payload.revisions?.service?.image_digest);
  requireHttpsUrl(payload.environment?.client_url, 'Client URL');
  requireHttpsUrl(payload.environment?.service_url, 'Service URL');
  return true;
}
