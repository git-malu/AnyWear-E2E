# Vendored deployment contract

These files are the public v4 deployment contract from
[`AnyWear-Infra`](https://github.com/git-malu/AnyWear-Infra) commit
`367292167ef6c4a4e3425a6f5c4ba268ef39bfd5`. The contract keeps the seven-member
v3 record core, and the Service `anywear_service_deployment` record is schema
version 4 with a required `gate` block. The Infra `anywear_infra_deployment`
record stays schema version 3 and never carries a gate.

Three files are exact byte copies. `deployment-contract.mjs` is the raw producer
file with exactly one declared import rewrite because this repository consumes
the dependency-free package source instead of installing a tarball:

| E2E file | Producer path in Infra | Producer SHA-256 | Committed SHA-256 |
| --- | --- | --- | --- |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `972c1fbe8896f53c3046c5c3f67543c87cc550bb973a0a87f47b722a413fa06a` | `0a5dce23d6cd6947595c49cce282477d34c49110a186f01feb9b16dc22c3990a` |
| `json-contract.mjs` | `scripts/json-contract.mjs` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` |
| `operation-stacks.mjs` | `scripts/operation-stacks.mjs` | `6105de5a9b3860cb130ad7d5c8d05cf03a31a36dc71f818e451f7eddd65cf023` | `6105de5a9b3860cb130ad7d5c8d05cf03a31a36dc71f818e451f7eddd65cf023` |
| `stage-contracts.mjs` | `packages/stage-contracts/index.mjs` | `1ef2596c258a9b65349023dd2492909a478a09ca3e7cdc1f7968e2fe82e96b5b` | `1ef2596c258a9b65349023dd2492909a478a09ca3e7cdc1f7968e2fe82e96b5b` |

## The one declared rewrite

`deployment-contract.mjs` imports the versioned package entry:

```diff
-} from '@git-malu/stage-contracts';
+} from './stage-contracts.mjs';
```

`provenance.json` records that substitution as `import_rewrites` and the raw
producer file hash as `producer_files`. `scripts/vendored-contract.mjs` asserts
the repository, the source SHA and every committed file hash; it also reverses
the declared rewrite, asserts the raw producer bytes hash, and re-applies the
declaration forward. A missing or malformed declaration, an undeclared byte
change or a doctored file is refused before the consumer imports the contract.

## Package pin

| Member | Value |
| --- | --- |
| Package | `@git-malu/stage-contracts` |
| Version | `0.2.0` |
| Source | `packages/stage-contracts` |
| Tarball SHA-256 | `6cbe78e0e310eff050b2eb574054ab753e7b0d48d5ca44bd2085e6b23b88938b` |

The tarball is the packed `git-malu-stage-contracts-0.2.0.tgz` for consumers that
install the package. This repository does not commit the tarball and adds no
dependency: `stage-contracts.mjs` is the same package entry in install-free form.
`provenance.json` is the machine-readable pin of both forms.

## What the contract validates

`deployment-contract.mjs` is producer-parameterized. `validateDeploymentRecord`
dispatches on `record_type` and accepts exactly one producer's record:

- `anywear_infra_deployment` — schema version 3, producer
  `git-malu/AnyWear-Infra`, workflow `runtime.yml` or `mutate.yml`. The record
  lists exactly the three Infra stacks (`AnyWearFoundationStack`,
  `AnyWearPlatformStack-beta`, `AnyWearBillingStack-beta`). Its `observed` is the
  Platform tuple: the two Lambdas, the queue configuration hash, the Client
  commit and the Client endpoint. It has no `gate`.
- `anywear_service_deployment` — schema version 4, producer
  `git-malu/AnyWear-Service`, workflow `.github/workflows/service-artifacts.yml`.
  The record lists exactly `AnyWearWorkloadStack-beta`. Its `observed` is the
  Workload tuple: the Service commit, the image digest, the two ECS service
  identities and the API endpoint.
- The Service `gate` is a required top-level member. It records one passed
  `<stage>-anywear-deployment-bake` window of exactly 600 seconds, the probe
  budget (`15`-second interval, 30–40 probes, request floor 30), and the six
  fixed ordered signals (`alb_5xx_rate`, `alb_p95_latency`,
  `ecs_running_not_desired`, `sqs_oldest_message_age`, `sqs_dlq_depth`,
  `outbox_oldest_age`). Every signal must be `not-breaching` with its exact
  value, threshold and comparison, the deployed alarm names and observed states,
  and its exact read identity and minimum data points. The gate's `service_sha`
  and `image_digest` must equal the record's `observed` values.

Both records carry `stacks[]` (each row with its producer and the sha256 of the
deployed `Original` template body), `inputs[]` (stage-contract SSM parameter name,
version and value hash, sorted), a `schema` member that is a content hash derived
from those inputs, and a `producer` member with the producing repository, commit,
workflow, workflow ref and run/attempt. A record that lists another producer's
stack or mixes producer identities is refused.

## Retired sources

`artifact-consumer.mjs` (the v2 selection loader/verifier) and the nested
`vendor/service-artifact-contract.mjs` / `vendor/service-release-attestation.mjs`
Service parser copies are deleted. The v2 `selection` contract, its committed
files and the cross-repository native release verification path no longer exist
in this consumer; the Service release chain verifies its own sealed release
before it deploys, and E2E keeps only the four-field `service_artifacts` identity
as evidence. Historical v2 records remain readable for the audit/migration path
through the frozen envelope check in `scripts/trusted-deployment-inputs.mjs`,
never as a live v3 input. Pre-gate Service v3 records were never produced; the
Service record is only ever the v4 gated shape.
