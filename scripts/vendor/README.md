# Vendored Infra contract

These five modules are copies of ordinary
[`AnyWear-Infra`](https://github.com/git-malu/AnyWear-Infra) source pinned at commit
`8022da659001d0c14bcc35e09f5d667180c49dd5` (#191): four are byte-for-byte copies and
one carries a single declared import rewrite. The producer is plain source inside the
Infra repository: there is no published package, no tarball and no registry consumer
to install. Every vendored file names the producer path it was copied from, and
`scripts/vendored-contract.mjs` refuses the set before a consumer imports it when a
copy, its producer path or its declared rewrite disagrees with `provenance.json`.

| E2E file | Producer path in Infra | Producer SHA-256 | Committed SHA-256 | Declared rewrite |
| --- | --- | --- | --- | --- |
| `contracts.mjs` | `lib/contracts.mjs` | `ec687601fcdabd8cd96668c07d004805a1540b43b803b905e96c12f7e9a182ec` | `ec687601fcdabd8cd96668c07d004805a1540b43b803b905e96c12f7e9a182ec` | none |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `5648c7bdf069efe184ae978d3753774ac28bed8abb9d979c7af7d8d97848b565` | `5648c7bdf069efe184ae978d3753774ac28bed8abb9d979c7af7d8d97848b565` | none |
| `json-contract.mjs` | `scripts/json-contract.mjs` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` | none |
| `operation-stacks.mjs` | `scripts/operation-stacks.mjs` | `cfd3c3838b3b5806d27f52a918b73d72a4d4613159cbfa6be26cb589d67074b6` | `cfd3c3838b3b5806d27f52a918b73d72a4d4613159cbfa6be26cb589d67074b6` | none |
| `stage-contract-parameters.mjs` | `scripts/stage-contract-parameters.mjs` | `956c1345be6d8dd3c0ac9ba4670415105c24b4861987a609c41a48589bb18d37` | `13e39e5257604f8f9be08c144374d8e7ef1b0fae1157abf22bf6e681e67df1c2` | one (below) |

The source commit is the head of the Infra issue branch that retires the old
packaging layout. `provenance.json` is the machine-readable pin: the source
repository and commit, the per-file hash, the producer path of every file, the raw
producer hash of the one rewritten file and the rewrite itself.

## The one declared rewrite

`stage-contract-parameters.mjs` is the only file that differs from its producer. Its
producer imports the contract module by Infra's repository-relative path; the
vendored copy resolves it beside itself:

```diff
-} from '../lib/contracts.mjs';
+} from './contracts.mjs';
```

`provenance.json` records that substitution in `import_rewrites` and the raw
producer SHA-256 in `producer_files`. No other vendored file carries a rewrite, and
`provenance.json` declares none for them.

## What each module owns

- `contracts.mjs` — the stage parameter surface (`STAGE_CONTRACT_*`,
  `stageParameters`, `validateStageInputs`, `stageContractSchemaHash`), the Base,
  Egress and Runtime stack identities (`SERVICE_RUNTIME_STACK`, `runtimeStackName`,
  `runtimeStageFromStack`, `platformStackName`), the deployed-template
  normalisation (`DEPLOYED_TEMPLATE_NORMALISATION`, `normaliseDeployedTemplate`,
  `canonicalDeployedTemplateHash`), the task-definition identity
  (`stableTaskDefinition`, `taskDefinitionContentHash`) and the 300-second
  six-signal bake gate (`DEPLOYMENT_GATE_*`, `deploymentBakeName`,
  `deploymentAlarmName`, `deploymentAlarmNames`, `deploymentQueueNames`).
- `stage-contract-parameters.mjs` — the stage-input reader: one bounded
  `ssm get-parameters` request per ten `/anywear/beta/...` names, normalised to
  `inputs[]` rows with the parameter version and the sha256 of its value. E2E reads
  the deployed contract itself through this reader (#180) instead of checking out an
  Infra observer.
- `operation-stacks.mjs` — one authoritative stack table. `configuredStacks` is the
  always-present manifest (Foundation, `AnyWearPlatformStack-beta`, Billing);
  `operationOwnedStacks` is the disposable set (`AnyWearEgressStack-beta`,
  `AnyWearRuntimeStack-beta`); `changedStackNames` maps an operation to the stacks
  it changes, so `deploy-runtime` and `stop-runtime` name only
  `AnyWearRuntimeStack-beta`.
- `deployment-contract.mjs` — the four single-account constants the controls import:
  `account`, `region`, `INFRA_REPOSITORY` and `SERVICE_REPOSITORY`. The
  operation/deployment record chain and its validators were retired with #207 and the
  pinned producer copy carries none of them.
- `json-contract.mjs` — canonical JSON, sha256 and content hashing, the strict JSON
  parser and the small field, pattern and safe-integer assertions the other modules
  use.

The Service release slice is the **Runtime** stack: `SERVICE_RUNTIME_STACK` is
`AnyWearRuntimeStack-beta` in `ap-east-1`, deployed and stopped through
`.github/workflows/mutate.yml` (#195). The recorded tuple stays three always-present
Infra stacks; Egress and Runtime are operation-owned and never enter the configured
manifest.

## What stays E2E-owned

`stableLambdaConfiguration` now lives in
[`scripts/lambda-configuration.mjs`](../lambda-configuration.mjs), with its tests in
[`scripts/lambda-configuration.test.mjs`](../lambda-configuration.test.mjs). The
pinned producer copy carries only the four constants above, so the projection that
hashes a deployed Lambda's stable configuration is observation policy owned here. It
is unchanged from the vendored copy it replaces and imports nothing from this
directory.

## The verifier rules

`scripts/vendored-contract.mjs`, run by `pnpm vendor:verify` and first in
`pnpm check`, enforces:

- the source repository is `git-malu/AnyWear-Infra` and the source SHA is a full
  40-character commit;
- the vendored module set equals the `files` key set exactly, and `producer_paths`
  covers exactly that key set with a non-empty producer path for every file;
- every `files` SHA-256 equals the committed bytes;
- for a file whose producer bytes are declared, the declared rewrites are reversed,
  the reconstructed bytes must hash to the recorded producer SHA-256, every declared
  rewrite must occur exactly once, and re-applying the rewrites forward must
  reproduce the committed bytes;
- an entry in `producer_files` must carry at least one declared rewrite: an empty
  rewrite list with producer bytes is refused, because it would make the reversal
  vacuous;
- a `package` block is refused and the error names the retired artifact it claims:
  the producer is source, so there is no package identity to pin.

## Retired sources

`artifact-consumer.mjs` (the v2 selection loader/verifier) and the nested
`vendor/service-artifact-contract.mjs` / `vendor/service-release-attestation.mjs`
Service parser copies are deleted; `provenance.json` records them under `retired`.
The v2 `selection` contract, its committed files and the cross-repository native
release verification path no longer exist in this consumer. The Service release
chain verifies its own sealed release before it deploys, and E2E keeps only the
release identity as evidence: the v4 `service_artifacts` member — `repository`,
`release_id`, `tag`, `target_commit` and `assets` — where the tag names the qualified
Service commit, `target_commit` is the commit the tag resolved to, and `assets` is
exactly the four released names (`pre-sign-up.zip`, `post-confirmation.zip`,
`runtime-policy.json`, `service-schema.json`) with their published size and `sha256`
digest. Qualification reads the release and the tag ref through the GitHub API and
downloads no release asset, so no `service-artifacts.json` manifest is on the E2E
path (#193) and the image digest stays in the live `/health` revision instead of a
release field. A pre-change five-asset release remains qualifiable during the 5→4
transition: the gate requires the four names it consumes and ignores the extra
legacy asset.
