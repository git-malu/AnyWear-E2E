# Compatibility v3: per-producer deployment records

`compatibility.json` version 3 splits the recorded deployment identity by producer.
It replaces the v2 single Infra `runtime.yml` deployment record that covered every
stack, and the committed `selection` whose release verification crossed
repositories. It is the system-test side of the release-slice split recorded in
[ADR 0025](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/ADR/0025-per-service-release-slice-repositories.md):
`AnyWear-Infra` keeps Bootstrap, the Base stack (physical name
`AnyWearPlatformStack-beta`) and Billing; `AnyWear-Service` owns and deploys the
Runtime release slice (`AnyWearRuntimeStack-beta`, formerly the Workload stack).

The contract answers one question: which exact producer produced the deployed
system this suite qualifies, and which exact record bytes say so. Qualification
refuses anything else.

The record version is per producer. The Infra `anywear_infra_deployment` record
stays **schema version 3** with the seven-member core. The Service
`anywear_service_deployment` record is **schema version 4**: the same core plus a
required top-level `gate` that records the passed 600-second deployment bake.
Historical v2 Infra records stay readable only through the frozen envelope check
in `scripts/trusted-deployment-inputs.mjs`; they are never a live input. Pre-gate
Service v3 records were never produced, so there is no Service v3 window to keep.

## Shape

```json
{
  "version": 3,
  "client": { "repository": "git-malu/AnyWear-Client", "sha": "<40 hex>" },
  "minimum_supported_client": { "version": 0, "sha": "<40 hex>" },
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

`minimum_supported_client` names the oldest Client revision the deployed Service still supports,
and the floor it enforces. `version` is a non-negative safe integer and `sha` is a full
lowercase 40-character Client commit. Version `0` is the unversioned Client: a build that
predates `client-version.json` is version `0` by definition, so the oldest leg accepts such
a schema 1/2 build with no `client_version` when the floor is `0`. `client.sha` stays the newest deployed Client the
platform record observed; the two may name the same commit when only one Client version is
supported. The member is required at qualification and on a pin move, but the committed pin
moves **after** the deployment that first serves the floor: until that move the committed
pin has no `minimum_supported_client` member, `pnpm check` (which only validates the shape) still
accepts it, and `full` refuses to write a qualification record. `smoke` and `measure` do not
require it.

A **deployment record** (produced by Infra or Service, consumed by E2E) shares a
seven-member core. The two producers share that core but never the stack list or
the observed tuple. The Infra record stays schema version 3:

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

The Service record is schema version 4: the same seven members plus a required
top-level `gate`:

```json
{
  "schema_version": 4,
  "record_type": "anywear_service_deployment",
  "producer": { "…Service producer…" },
  "stacks": [
    { "name": "AnyWearRuntimeStack-beta", "region": "ap-east-1",
      "producer_repository": "git-malu/AnyWear-Service", "producer_sha": "<40 hex>",
      "template_sha256": "<64 hex>" }
  ],
  "inputs": [ { "parameter": "/anywear/beta/vpc_id", "version": "3", "value_sha256": "<64 hex>" } ],
  "observed": {
    "service_sha": "<40 hex>",
    "image_digest": "sha256:<64 hex>",
    "minimum_client_version": 0,
    "ecs": { "…api and worker identities…" },
    "endpoints": { "api": "<url>" }
  },
  "schema": { "content_sha256": "<64 hex>" },
  "gate": {
    "name": "beta-anywear-deployment-bake",
    "result": "passed",
    "started_at": "2026-10-18T00:00:00.000Z",
    "ended_at": "2026-10-18T00:10:00.000Z",
    "duration_seconds": 600,
    "service_sha": "<40 hex>",
    "image_digest": "sha256:<64 hex>",
    "probe": { "interval_seconds": 15, "probes_sent": 40, "request_floor": 30 },
    "signals": [ "…the six fixed ordered signals…" ]
  }
}
```

`inputs[]` is sorted by parameter name; `version` is the SSM version as a decimal
string; `value_sha256` is the hash of the value the run read. `schema.content_sha256`
is derived from those inputs (parameter names and versions), so a reader can
recompute it instead of trusting a cross-repository pin.

The 0.3.0 stage contract publishes 36 parameter definitions: 35 unconditional,
including `api_base_url` (the public API CloudFront endpoint the Base stack owns),
plus the conditional `cleanup_task_role_arn`. Issue #166 renamed the Service-owned
release slice to the Runtime stack; the always-present Infra manifest stays exactly
Foundation, `AnyWearPlatformStack-beta` and Billing. `AnyWearEgressStack-beta` is
operation-owned and never appears in a deployment record or the observation
manifest, so the recorded system tuple stays three Infra stacks plus one Service
stack.

`observed.minimum_client_version` is the minimum supported Client floor the deployed
Service enforces, read back from its live `/health` response at deploy time. The
`@git-malu/stage-contracts` 0.3.0 validator requires a non-negative safe integer there, so
a producer that did not read the live value cannot write a v4 record. `assertDeploymentBinding`
requires it to equal `compatibility.minimum_supported_client.version` when the pin carries the member.
The Service `observed` tuple therefore names both the Service/image it deployed and the
oldest Client that deployment still serves.

The gate is evidence for one deployment only. Its window must be exactly 600
seconds (`ended_at - started_at`), its probe budget is a 15-second interval with
30–40 probes and a request floor of 30, and its six fixed ordered signals are
`alb_5xx_rate`, `alb_p95_latency`, `ecs_running_not_desired`,
`sqs_oldest_message_age`, `sqs_dlq_depth` and `outbox_oldest_age`. Every signal
must be `not-breaching` and carry its exact value, threshold and comparison, the
deployed alarm names and observed states, and its exact read identity and minimum
data points. `gate.service_sha` and `gate.image_digest` must equal
`observed.service_sha` and `observed.image_digest`, so a passed gate from another
run cannot be reused. The Infra v3 record never carries a gate.

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
| `platform` | The Foundation/Base/Billing deployment record that produced the stage base. `producer_sha` is the commit whose run wrote the record; `record` names that run, its artifact and the exact record bytes. | `git-malu/AnyWear-Infra` |
| `workload` | The Runtime release-slice producer identity; the member keeps its historical `workload` name while the stack is `AnyWearRuntimeStack-beta`. `producer_sha` is the Service release-chain commit that built and deployed the slice. | `git-malu/AnyWear-Service` |
| `deployment` | The Runtime deployment record: the Service release-chain run, artifact and exact record bytes. Its `producer` must equal `workload.producer`. | `git-malu/AnyWear-Service` |

The two records are deliberately not one record:

- Every record has a top-level `producer {repository, sha, workflow_path,
  workflow_ref, run_id, run_attempt}` and lists only the stacks that producer
  deployed. The Infra record covers `AnyWearFoundationStack`,
  `AnyWearPlatformStack-beta` and `AnyWearBillingStack-beta`; the Service record
  covers only `AnyWearRuntimeStack-beta`. A record that claims another
  repository's stack is refused. `AnyWearEgressStack-beta` belongs to the Infra
  `deploy-egress` / `delete-egress` operations and is not listed by either record.
- The record versions differ deliberately: the Infra record is schema version 3
  and never carries a gate; the Service record is schema version 4 and its
  top-level `gate` is part of the deployment it names. A Service record without a
  passed gate, or a gate bound to another observed Service commit or image digest,
  is refused. Pre-gate Service v3 records are historical only and were never
  produced.
- The two `observed` tuples are also disjoint. The Infra record observes the
  Base tuple (the two Lambdas, the queue configuration hash, the Client commit
  and the Client endpoint). The Service record observes the Runtime tuple (the
  Service commit, the image digest, the minimum Client floor, the two ECS service
  identities and the API endpoint). Neither record is a substitute for the other.
- The Infra producer record is written by the run whose `producer.sha` is
  `platform.producer_sha`; that is the platform record producer, and the pin binds
  the record, its run and its artifact to it. `infra.sha` is a different pin: the
  reviewed Infra revision E2E checks out as the observation source. The two may
  differ because a platform stack can be deployed from an earlier reviewed commit
  than the observation helper, so `compatibility.json` keeps both.
- The Service producer is the release chain that owns the Runtime stack. The
  same run builds the image, verifies the sealed release, deploys the slice and
  writes the record, so no committed `selection` and no cross-repository native
  asset verification exist in this contract.

`service_artifacts` remains the four-field immutable Service release identity. It
is **evidence only**: the Service release chain verifies its own sealed release
before it deploys, so E2E no longer downloads or parses that release with the
retired Service parser. The pin still binds the release identity to the deployed
`service.sha` through the Service record's `observed.service_sha`.

## Deferred records (contract history)

The deferred identity shape stays part of the v3 contract as history. It exists
because C removed the Infra Workload deploy path before the first Service
release-chain deployment existed, so a pin could name a producer without
inventing a run:

- `validateCompatibility` accepts a deferred record and rejects any other member
  of the identity shape. Each identity is validated on its own, so one producer's
  record could be pinned while the other stayed deferred.
- Every live path fails closed with `deployment evidence deferred` for the
  deferred identity before it downloads, observes or qualifies anything. It never
  falls back to a historical Infra `runtime.yml` tuple and never treats a Service
  publication run as a deployment.
- `validate-compatibility-pin` refuses to move a pin while either record is
  deferred, so a deferred pin cannot be relabelled as a recorded one offline.

A deferred pin is coherent and reviewable; it is not qualification authority.
The committed pin no longer uses the shape: both records are recorded through the
routine in [compatibility-pin.md](compatibility-pin.md).

The committed `deployment` identity is recorded from the Service release-chain run
`39098055973` attempt `1`, artifact `service-deployment-39098055973-1` (artifact
id `12124879790`) and the SHA-256 of the exact `service-deployment.json` bytes.
That record predates the #162 v4 gate: the release chain that wrote it used the
v3 producer. The vendored v4 contract refuses a v3 Service record, so the pin must
be re-recorded from the first gated v4 deploy before qualification can pass; the
offline routine only moves a recorded pin from real downloaded v4 record bytes.
The committed `platform.record` is recorded from the reviewed Infra observation
run `39104244598` attempt `1`, artifact `infra-deployment-39104244598-1` (artifact
id `12128200024`) and the SHA-256 of the exact `deployment-record.json` bytes
(`0c63e881…`). `platform.producer_sha` is `5420469f…`, the run's `head_sha` and the
record's `producer.sha`. `infra.sha` stays `da67841f…`: it names the reviewed
observation source E2E executes, which is not the platform record producer.

One cross-repository dependency is recorded here and has now been approved for the
producer side. C's post-C Platform deploy removes every `PublishOutput*` output,
and the release-slice deploy's last eleven weak reads (nine cleanup values and
two isolated-subnet values) became stage-contract parameters. The Service
record's `inputs[]` therefore grows to whatever the deployment actually reads:
the 0.3.0 stage contract publishes 36 definitions — 35 unconditional including
`api_base_url`, plus the conditional `cleanup_task_role_arn` — and the release
chain reads the values it consumes as pure SSM parameters. There is no
resident/stopped phase variant any more, so no recorded input depends on which
lifecycle state the deployment ran in. E2E does not hardcode a count or a name list:
it accepts the producer's recorded, sorted and unique list within the contract's
bound, and derives the schema hash from it, so no schema or format change
follows. Once both stacks read pure SSM parameters, deploy order no longer
matters. The conversion has landed and one authorized Workload deploy completed
from it; issue #166 renamed that slice to the Runtime stack without changing the
record shape, the platform record is now pinned, so both producers' records are
recorded and the deferred evidence gap is closed. That Workload record predates
the #162 v4 gate, so a gated v4 re-pin remains before qualification can pass.

## Migration

`scripts/migrate-compatibility.mjs` owns the offline transition:

- **v2 → v3 is strict.** Both a valid v2 pin (read as the previous pin) and both
  producer records (Infra v3 and Service v4) are required. The migration copies
  `client`, `service`, `infra` and `service_artifacts` from the v2 pin, checks the
  records' `observed` Client and Service commits against those pins, and writes
  the platform/workload producer identities and deployment identities from the
  records. A record from the wrong producer, a record covering another producer's
  stack, a Service record without its passed bake gate, or a record whose observed
  application tuple differs from the v2 pin is refused.
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
4. the vendored contract validates the record shape — the seven-member v3 core
   for both producers, and for the v4 Service record the passed 600-second bake
   gate with its exact probe budget, six ordered signals, thresholds,
   comparisons, alarm names and read identities — and derives the stage
   contract schema hash from the recorded inputs;
5. the record's `producer` equals the pinned producer (repository, commit,
   workflow, run and attempt);
6. its `stacks` cover exactly that producer's stacks, with the reviewed regions,
   producer repository and the record producer's commit on every row;
7. its `observed` identity equals the compatibility pins: the Infra record's
   Client commit, and the Service record's Service commit and OCI image digest;
   the Service gate's `service_sha` and `image_digest` must match that same
   observed tuple;
8. the Service `service_artifacts` release/asset identities and manifest bytes
   match the pinned four-field identity, and the manifest image source/digest
   match the Service record's observed tuple;
9. when the pin carries `minimum_supported_client`, the workload record's
   `observed.minimum_client_version` equals `minimum_supported_client.version`, the live
   Service `/health.minimum_client_version` equals the same floor, and the live
   deployed Client `build-metadata.json` uses schema 3 and states a
   `client_version` greater than or equal to the floor. These comparisons are
   enforced by `collectDeploymentEvidence` in
   `scripts/qualification-record.mjs`, called by
   `scripts/collect-deployment-evidence.mjs` for `qualification:collect`, so they
   fail before and after the suite, and the record's member set does not gain a copy
   of either live value.

For operation `full`, a second release-gating leg runs after the newest deployed leg and
its gates: it checks out `minimum_supported_client.sha` as `AnyWear-Client-oldest`, installs and
builds it with `SOURCE_COMMIT_SHA` set to that commit and the deployed Service URL, then
requires its `dist/build-metadata.json` to state `schema_version: 3`,
`client_version: minimum_supported_client.version` and the pinned source commit. The built Client is
served on `http://127.0.0.1:<port>` and the suite runs against it with the deployed Service
still reached over HTTPS, writing
`test-results/qualification-report-oldest-client.json` while its Playwright output
directory is `test-results/oldest-client`, so the second run cannot clean the primary
`test-results` inputs the record reads, and using its own cleanup run scope. The job fails
if either leg fails. The second report and the built `build-metadata.json` are uploaded as
evidence. The qualification record's `test` member continues to derive from the primary
deployed report, and the second leg is not a record member: a Client that cannot even parse
the deployed Service contract fails the leg, while the oldest supported Client's behavior
is evidenced by the uploaded report and the workflow's own assertions. This leg does not
run for `smoke`, `measure` or `recover`.

E2E then independently observes the live stage base from AWS and requires the
authenticated body (three Infra stacks, their deployed `Original` template
content hashes, the stage inputs and the Base observed tuple) to match the
Infra record. The Service record's Runtime identity is bound by the HTTP
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
information; the Runtime identity is the Service commit and image digest. This
folds in the E2E half of the fix from
[AnyWear #138](https://github.com/git-malu/AnyWear/issues/138). A comparison
failure in this consumer names the field that differs and both values; the
producer-owned shared comparison keeps its own message.
