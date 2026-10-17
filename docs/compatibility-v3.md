# Compatibility v3: per-producer deployment records

`compatibility.json` version 3 splits the recorded deployment identity by producer.
It replaces the v2 single Infra `runtime.yml` deployment record that covered every
stack, and the committed `selection` whose release verification crossed
repositories. It is the system-test side of the release-slice split recorded in
[ADR 0025](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/ADR/0025-per-service-release-slice-repositories.md):
`AnyWear-Infra` keeps Bootstrap, Platform and Billing; `AnyWear-Service` owns and
deploys the Workload release slice.

The contract answers one question: which exact producer produced the deployed
system this suite qualifies, and which exact record bytes say so. Qualification
refuses anything else.

## Shape

```json
{
  "version": 3,
  "client": { "repository": "git-malu/AnyWear-Client", "sha": "<40 hex>" },
  "service": { "repository": "git-malu/AnyWear-Service", "sha": "<40 hex>" },
  "infra": { "repository": "git-malu/AnyWear-Infra", "sha": "<40 hex>" },
  "platform": {
    "producer": "git-malu/AnyWear-Infra",
    "producer_sha": "<40 hex>",
    "record": { "…deployment identity…" }
  },
  "workload": {
    "producer": "git-malu/AnyWear-Service",
    "producer_sha": "<40 hex>"
  },
  "deployment": { "…deployment identity…" },
  "service_artifacts": {
    "repository": "git-malu/AnyWear-Service",
    "release_id": 0,
    "manifest_asset_id": 0,
    "manifest_sha256": "<64 hex>"
  }
}
```

A **deployment record** (produced by Infra or Service, consumed by E2E) has this
shape. The two producers share the envelope but never the stack list or the
observed tuple:

```json
{
  "schema_version": 3,
  "record_type": "anywear_infra_deployment",
  "producer": {
    "repository": "git-malu/AnyWear-Infra",
    "sha": "<40 hex>",
    "workflow_path": ".github/workflows/runtime.yml",
    "workflow_ref": "git-malu/AnyWear-Infra/.github/workflows/runtime.yml@refs/heads/main",
    "run_id": 0,
    "run_attempt": 1
  },
  "stacks": [
    { "name": "AnyWearPlatformStack-beta", "region": "ap-east-1",
      "producer_repository": "git-malu/AnyWear-Infra", "producer_sha": "<40 hex>",
      "template_sha256": "<64 hex>" }
  ],
  "inputs": [
    { "parameter": "/anywear/beta/vpc_id", "version": "3", "value_sha256": "<64 hex>" }
  ],
  "observed": { "…producer tuple…" },
  "schema": { "content_sha256": "<64 hex>" }
}
```

`inputs[]` is sorted by parameter name; `version` is the SSM version as a decimal
string; `value_sha256` is the hash of the value the run read. `schema.content_sha256`
is derived from those inputs (parameter names and versions), so a reader can
recompute it instead of trusting a cross-repository pin.

A **deployment identity** in `compatibility.json` is one of two strict shapes. The
deferred shape records that the producer is named but no record has been pinned
yet:

```json
{
  "producer": "git-malu/AnyWear-Infra",
  "workflow_path": ".github/workflows/runtime.yml",
  "status": "deferred",
  "reason": "no Infra v3 platform record exists yet; pin the first authorized platform observe"
}
```

The recorded shape replaces `status`/`reason` with the exact run, artifact and
record bytes:

```json
{
  "producer": "git-malu/AnyWear-Service",
  "workflow_path": ".github/workflows/service-artifacts.yml",
  "status": "recorded",
  "run_id": 0,
  "run_attempt": 1,
  "artifact_id": 0,
  "record_sha256": "<64 hex>"
}
```

No member accepts a branch, tag or moving reference. Every SHA is a full
lowercase 40-character commit, every checksum is a full lowercase SHA-256, and
every run/attempt/artifact id is a positive safe integer.

## The two producers

| Member | Purpose | Producer |
| --- | --- | --- |
| `platform` | The Foundation/Platform/Billing deployment record that produced the stage base. `producer_sha` is the commit whose run wrote the record; `record` names that run, its artifact and the exact record bytes. | `git-malu/AnyWear-Infra` |
| `workload` | The Workload release-slice producer identity. `producer_sha` is the Service release-chain commit that built and deployed the slice. | `git-malu/AnyWear-Service` |
| `deployment` | The Workload deployment record: the Service release-chain run, artifact and exact record bytes. Its `producer` must equal `workload.producer`. | `git-malu/AnyWear-Service` |

The two records are deliberately not one record:

- Every v3 record has a top-level `producer {repository, sha, workflow_path,
  workflow_ref, run_id, run_attempt}` and lists only the stacks that producer
  deployed. The Infra record covers `AnyWearFoundationStack`,
  `AnyWearPlatformStack-beta` and `AnyWearBillingStack-beta`; the Service record
  covers only `AnyWearWorkloadStack-beta`. A record that claims another
  repository's stack is refused.
- The two `observed` tuples are also disjoint. The Infra record observes the
  Platform tuple (the two Lambdas, the queue configuration hash, the Client commit
  and the Client endpoint). The Service record observes the Workload tuple (the
  Service commit, the image digest, the two ECS service identities and the API
  endpoint). Neither record is a substitute for the other.
- The Infra producer is checked out at `infra.sha` as the reviewed observation
  source. `platform.producer_sha` may move independently because a platform stack
  can be deployed from an earlier reviewed commit than the observer.
- The Service producer is the release chain that owns the Workload stack. The
  same run builds the image, verifies the sealed release, deploys the slice and
  writes the record, so no committed `selection` and no cross-repository native
  asset verification exist in this contract.

`service_artifacts` remains the four-field immutable Service release identity. It
is **evidence only**: the Service release chain verifies its own sealed release
before it deploys, so E2E no longer downloads or parses that release with the
retired Service parser. The pin still binds the release identity to the deployed
`service.sha` through the Service record's `observed.service_sha`.

## Deferred records

C removes the Infra Workload deploy path before the first Service release-chain
deployment exists. A compatibility pin therefore must be able to name the
producer without inventing a run. The deferred shape does exactly that:

- `validateCompatibility` accepts a deferred record and rejects any other member
  of the identity shape.
- Every live path fails closed with `deployment evidence deferred` before it
  downloads, observes or qualifies anything. It never falls back to a historical
  Infra `runtime.yml` tuple and never treats a Service publication run as a
  deployment.
- `validate-compatibility-pin` refuses to move a pin while either record is
  deferred, so a deferred pin cannot be relabelled as a recorded one offline.

A deferred pin is coherent and reviewable; it is not qualification authority.
The first authorized deployment/observe round supplies the two records and the
pin moves to the recorded shape through
[compatibility-pin.md](compatibility-pin.md).

One cross-repository dependency is recorded here and has now been approved for the
producer side. C's post-C Platform deploy removes every `PublishOutput*` output,
and the release-slice deploy's last eleven weak reads (nine cleanup values and
two isolated-subnet values) are being converted into stage-contract parameters.
The Service record's `inputs[]` therefore grows to whatever the deployed phase
actually reads — expected 39 for resident active `roles-added` (35 stage
parameters + 4 reused values). E2E does not hardcode a count or a name list:
it accepts the producer's recorded, sorted and unique list within the contract's
bound, and derives the schema hash from it, so no schema or format change
follows. Once both stacks read pure SSM parameters, deploy order no longer
matters. Until the deferred Foundation/Platform round supplies the parameters and
the first records, there is no live qualification and no Workload deploy.

## Migration

`scripts/migrate-compatibility.mjs` owns the offline transition:

- **v2 → v3 is strict.** Both a valid v2 pin (read as the previous pin) and both
  v3 records are required. The migration copies `client`, `service`, `infra` and
  `service_artifacts` from the v2 pin, checks the records' `observed` Client and
  Service commits against those pins, and writes the platform/workload producer
  identities and deployment identities from the records. A record from the wrong
  producer, a record covering another producer's stack, or a record whose
  observed application tuple differs from the v2 pin is refused.
- **v3 → v3 fills or refreshes the deferred identity.** A committed deferred pin
  is upgraded member by member from the supplied records; a recorded pin moves
  forward only through the offline validator's run/attempt ordering.
- **v1 → v2 is historical.** `buildV2Compatibility` and its tests remain so the
  historical migration can be read and re-verified, but the CLI does not accept
  a v1 committed pin: v1 is not a live input and is never converted into a v3
  pin.

## What the suite verifies

For each record, qualification re-downloads the exact artifact bytes and checks:

1. the run is the reviewed producer workflow, on `main`, a completed-success
   `workflow_dispatch` at the pinned `producer_sha` and the pinned run/attempt;
2. the artifact is the pinned, unexpired artifact of that run/attempt;
3. the downloaded record's byte hash equals `record_sha256`;
4. the vendored v3 contract validates the record shape and derives the stage
   contract schema hash from the recorded inputs;
5. the record's `producer` equals the pinned producer (repository, commit,
   workflow, run and attempt);
6. its `stacks` cover exactly that producer's stacks, with the reviewed regions,
   producer repository and the record producer's commit on every row;
7. its `observed` identity equals the compatibility pins: the Infra record's
   Client commit, and the Service record's Service commit and OCI image digest;
8. the Service `service_artifacts` release/asset identities and manifest bytes
   match the pinned four-field identity, and the manifest image source/digest
   match the Service record's observed tuple.

E2E then independently observes the live stage base from AWS and requires the
authenticated body (three Infra stacks, their deployed `Original` template
content hashes, the stage inputs and the Platform observed tuple) to match the
Infra record. The Service record's Workload identity is bound by the HTTP
evidence: the deployed Client `/build-metadata.json` source and endpoint match the
Infra record, and the Service `/health` commit, image digest and API endpoint
match the Service record. E2E comparisons name the differing field with its
expected and observed values.

## Content identity, not ECS revisions

Deployment identity is a **content** identity. Neither the pin nor a comparison
uses an ECS task-definition revision number as equality input: the revision is
append-only, so treating it as identity would permanently invalidate a reviewed
tuple after any authorized configuration change. The pin identifies the record by
the SHA-256 of its exact bytes, each stack by the content hash of its deployed
`Original` CloudFormation template, and each stage input by the hash of its value.
An ECS task-definition ARN revision inside the Service record is audit
information; the Workload identity is the Service commit and image digest. This
folds in the E2E half of the fix from
[AnyWear #138](https://github.com/git-malu/AnyWear/issues/138). A comparison
failure in this consumer names the field that differs and both values; the
producer-owned shared comparison keeps its own message.
