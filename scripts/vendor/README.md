# Vendored deployment contract

These files are exact byte copies of the public v3 deployment contract from
[`AnyWear-Infra`](https://github.com/git-malu/AnyWear-Infra) commit
`bab0b6a69ad27f86f405c80f34f588044f28adc4`. The final C commit
`fc0e23a7efc832562559ae465d06f68a7bf94126` carries byte-identical copies of these
three files; the approved stage-contract parameter-list extension is a separate
change and does not alter them. The Infra observer was rewritten separately and is
not vendored.

| E2E file | Producer path in Infra | Raw SHA-256 |
| --- | --- | --- |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `307dfdf5b69be2c74e61685ac076ae7f4de72a4f5ec0b1665e10f5d7c191cd59` |
| `json-contract.mjs` | `scripts/json-contract.mjs` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` |
| `operation-stacks.mjs` | `scripts/operation-stacks.mjs` | `6105de5a9b3860cb130ad7d5c8d05cf03a31a36dc71f818e451f7eddd65cf023` |

`provenance.json` is the machine-readable pin. `scripts/vendored-contract.mjs`
asserts the repository, the source SHA and every file hash before the consumer
imports the contract; `scripts/vendored-contract.test.mjs` proves a modified,
missing or extra module is refused. The assertion is a source-drift check, not
provenance authority: it does not fetch the producer, prove its review status or
authorize a deployment.

## What the contract validates

`deployment-contract.mjs` is producer-parameterized. `validateDeploymentRecord`
dispatches on `record_type` and accepts exactly one producer's record:

- `anywear_infra_deployment` — producer `git-malu/AnyWear-Infra`, workflow
  `runtime.yml` or `mutate.yml`. The record lists exactly the three Infra stacks
  (`AnyWearFoundationStack`, `AnyWearPlatformStack-beta`,
  `AnyWearBillingStack-beta`). Its `observed` is the Platform tuple: the two
  Lambdas, the queue configuration hash, the Client commit and the Client
  endpoint.
- `anywear_service_deployment` — producer `git-malu/AnyWear-Service`, workflow
  `.github/workflows/service-artifacts.yml`. The record lists exactly
  `AnyWearWorkloadStack-beta`. Its `observed` is the Workload tuple: the Service
  commit, the image digest, the two ECS service identities and the API endpoint.

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
never as a live v3 input.
