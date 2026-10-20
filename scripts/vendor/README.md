# Vendored deployment contract

These files are the public v4 deployment contract from
[`AnyWear-Infra`](https://github.com/git-malu/AnyWear-Infra) commit
`9382e40810fa451b626f13a3303fe205614305f7` (`@git-malu/stage-contracts` 0.3.0,
Issues #166 and #180). The contract keeps the seven-member v3 record core, and the
Service `anywear_service_deployment` record is schema version 4 with a required
`gate` block. The Infra `anywear_infra_deployment` record stays schema version 3
and never carries a gate.

The source commit moved from `c9983520edbff92c425d7db4261fd55e8f2ecbfb` to
`9382e40810fa451b626f13a3303fe205614305f7` for #180: the four contract files are
byte-identical at both commits (their producer blobs were compared), and only
`stage-contract-parameters.mjs` moved. AnyWear-E2E now takes the authenticated
platform observation itself instead of checking out the Infra observer, so it
needs the stage-input reader here rather than in a separate checkout.

The Service release slice is the **Runtime** stack. `SERVICE_RUNTIME_STACK` is
`AnyWearRuntimeStack-beta` (`ap-east-1`, workflow
`.github/workflows/service-artifacts.yml`); `runtimeStackName` and the exported
`runtimeStageFromStack` replaced the Workload identity, and no
`AnyWearWorkloadStack`, `SERVICE_WORKLOAD_STACK` or `workloadStageFromStack`
export remains. `AnyWearEgressStack-beta` is **operation-owned**: the contract's
always-present `configuredStacks` manifest is still exactly Foundation,
`AnyWearPlatformStack-beta` and Billing, and the recorded tuple stays three Infra
stacks plus one Service stack. Egress appears only in the operation change table
(`deploy-egress` / `delete-egress`) and in `operationOwnedStacks`, never in the
record or observation manifest.

Three contract files are exact byte copies. `deployment-contract.mjs` and
`stage-contract-parameters.mjs` are raw producer files with exactly one declared
import rewrite each because this repository consumes the dependency-free package
source instead of installing a tarball:

| E2E file | Producer path in Infra | Producer SHA-256 | Committed SHA-256 |
| --- | --- | --- | --- |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `c17ee5136d01f69309b55bfd18eb8b62b05c20d1306aea64e33a429e83754d5a` | `54a6986f9b399b6935f45829404a3e36b1bd7874da623ad8d56e3d7790728a21` |
| `json-contract.mjs` | `scripts/json-contract.mjs` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` |
| `operation-stacks.mjs` | `scripts/operation-stacks.mjs` | `7ff1e34479cd79207aa9db74b5a8356bb660f520d288c14514bd37ae509aecab` | `7ff1e34479cd79207aa9db74b5a8356bb660f520d288c14514bd37ae509aecab` |
| `stage-contract-parameters.mjs` | `scripts/stage-contract-parameters.mjs` | `f5a5f82b289de57840821fcee4fb3f4a25b399a1b5f86fb0d5d4b3db52ef6b68` | `b6e506ebc74cf120d696779d5f0bc4376735e5a0cb76e5aa9c1411c9090e57f8` |
| `stage-contracts.mjs` | `packages/stage-contracts/index.mjs` | `4aa26c3a857aa68fb53b09229074acbe4ce9a6912531475a9e748ac14a071784` | `4aa26c3a857aa68fb53b09229074acbe4ce9a6912531475a9e748ac14a071784` |

## The two declared rewrites

`deployment-contract.mjs` and `stage-contract-parameters.mjs` import the
versioned package entry:

```diff
-} from '@git-malu/stage-contracts';
+} from './stage-contracts.mjs';
```

`provenance.json` records each substitution as `import_rewrites` and the raw
producer file hashes as `producer_files`. `scripts/vendored-contract.mjs` asserts
the repository, the source SHA and every committed file hash; it also reverses
the declared rewrites, asserts the raw producer bytes hashes, and re-applies the
declarations forward. A missing or malformed declaration, an undeclared byte
change or a doctored file is refused before the consumer imports the contract.

## Package pin

| Member | Value |
| --- | --- |
| Package | `@git-malu/stage-contracts` |
| Version | `0.3.0` |
| Source | `packages/stage-contracts` |
| Tarball SHA-256 | `0180a2788e7df0bf695d235f17af2f7ee2cff81520bccf2d9efe7f5d1da0fadb` |

The tarball is the packed `git-malu-stage-contracts-0.3.0.tgz` for consumers that
install the package; it was packed from Infra commit
`29601d9a2264e69544daccbe7d4b7f29fe2a5991`, and its `index.mjs` is exactly the
vendored `stage-contracts.mjs` bytes. This repository does not commit the tarball
and adds no dependency: `stage-contracts.mjs` is the same package entry in
install-free form. `provenance.json` is the machine-readable pin of both forms.
Version 0.3.0 renames the Service release slice to the Runtime stack
(`runtimeStackName`, `SERVICE_RUNTIME_STACK`, `runtimeStageFromStack`,
`validateServiceStacks`) and adds the unconditional `api_base_url` stage-contract
parameter (36 definitions, 35 unconditional, 1 conditional), which the Base stack
publishes and the Service release chain reads. It does **not** claim a
`stage-contracts-v0.3.0` tag: the tag is created only after the Infra merge, at
Deployment.

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
  The record lists exactly `AnyWearRuntimeStack-beta`. Its `observed` is the
  Runtime tuple: the Service commit, the image digest, the minimum Client
  version floor the deployed Service enforces, the two ECS service identities and
  the API endpoint.
- The stage contract is 36 parameter definitions: 35 unconditional (including
  `api_base_url`, the public API distribution endpoint Base owns) and the
  conditional `cleanup_task_role_arn`. A reader accepts the recorded, sorted and
  unique `inputs[]` without a fixed count or name list and derives the schema hash
  from it.
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
as evidence. #180 also deletes the E2E deployment-record consumer
(`scripts/trusted-deployment-inputs.mjs`, including its frozen historical-v2
envelope check) and the cross-repository Infra observer checkout
(`scripts/infra-source.mjs`): qualification takes its own authenticated platform
observation from this contract instead of consuming a producer record. Historical
v2 records remain readable only in the retained-inert pin tooling (Wave 2
deletion), never as a live input. Pre-gate Service v3 records were never
produced; the Service record is only ever the v4 gated shape.
