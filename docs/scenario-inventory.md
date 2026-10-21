# Scenario inventory

This inventory is the per-scenario classification the [testing principles and execution
policy](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
requires in place of tags alone. It records, for every tracked deployed scenario, the
governance class that policy defines, the claim it asserts, the invocation that selects
it, the cleanup contract that disposes of what it creates, and the verdict a red result
carries.

The policy owns the classes, the tag vocabulary, the scenario admission rule and the
evidence levels. This document owns which class each scenario here is, and what its
result means. Where the two could disagree, the policy governs and this document is
wrong.

## Deployed invocations

Each invocation below carries its own trigger and its own verdict. The verdicts are
separated deliberately: a measurement or drill result is data about an operation, and it
can neither satisfy nor fail release qualification.

| invocation | Selects | Trigger | Verdict |
| --- | --- | --- | --- |
| `test:smoke` | `@smoke` | The `smoke` operation of the protected `qualify` entry | Diagnostic observation of a narrow deployed path; it does not qualify a release |
| `test:regression` | `@regression` | The `full` operation of the protected `qualify` entry, as the only release-gating selection | Release qualification: a red result fails the gate, and a green result is a required input to the qualification record |
| `test:instrumentation` | `@instrumentation` | Explicit operator opt-in through the `measure` operation of the protected `qualify` entry | Measurement or drill result; it can neither satisfy nor fail release qualification |
| `test:full-stack` | `@full-stack`, which every cross-repository scenario carries | Explicit operator selection | Broad deployed cross-boundary observation, including instrumentation; not a release-gating selection on its own |
| `test` | `@regression` | Local investigation, and the `full` operation's qualification suite step | Identical to `test:regression`: the release gate. An instrumentation scenario is not in this selection |
| `test:core` | The explicitly listed offline `scripts/*.test.mjs` contract files and `tests/scenario-declarations.test.mjs` | The automatic Check entry (PR/main) and qualify preflight source preparation | Source contract result; no deployed claim |
| `test:tool-regressions` | The explicitly listed offline retained-tool files | The automatic Check entry's `tool-regressions` job on every PR/main | Tool source result; no deployed claim |
| `test:deferred-sqs` | The explicitly listed prospective SQS protocol files | Manual deferred-owner review | Prototype contract only |

The separation is carried by the signed `operation` field, not by a workflow boundary, a step
or a job. One protected dispatch surface, the `qualify` entry in `beta-qualification.yml`,
carries `full`, `smoke`, `measure` and `recover`. A release consumer accepts a qualification
record only from the `full` operation of a completed-success qualification run: the record
states `operation: full` and is produced only by that operation, so a `smoke`, `measure` or
`recover` run can neither produce nor withhold a record the gate legitimately produced. The
three properties separation keeps are: the record is produced only by `full`; the record binds
the operation dispatched, so its producer is uniquely identifiable; and both this repository's
producer/verifier and the Infra-side executor allow-list check `operation == full`.

Since [#180](https://github.com/git-malu/AnyWear/issues/180) the dispatch surface also names
the trigger and the expectation it was dispatched for: `trigger=deploy-smoke` only runs
`smoke`, `trigger=release-qualify` only runs `full` and requires `expected_service_commit`, and
`trigger=manual` covers re-runs and diagnostics. `full` compares the expected Service commit
with the live `/health` value, writes qualification record v3 from the live observed tuple, and
the `record` job is the last qualification job: the green `full` run plus its sealed record is
the release decision, with the dispatch event, the run/attempt and the record tuple as the
audit trail. No release-qualification path reads a committed compatibility file; the
qualification path reads `minimum-supported-client.json` only for the oldest-Client leg. The
one remaining executed read of the retained pin is the `measure` sizing workload
(`tests/beta-sizing.spec.ts` → `scripts/beta-sizing-source.mjs`): it is a measurement, not
qualification, and #141 deletes it.

`test:list` and `playwright test --list` discover tests without executing them. Discovery
reads configuration only, makes no cloud call and asserts no verdict.

`tests/scenario-declarations.test.mjs` is the offline check that keeps this document and
the spec files agreeing, and it is named on the `test:core` list so the registry states its
membership explicitly rather than by discovery.

Scenario membership is positive: a scenario is in an invocation because it carries that
invocation's tag. A scenario that loses its tag therefore leaves the release-gating
selection, which is why `tests/scenario-declarations.test.mjs` fails the offline check if
a spec stops declaring its invocation, or if this document and `package.json` stop
agreeing about the invocations that exist.

## Scenarios

### `tests/wardrobe.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Wardrobe Management @regression @full-stack` |
| Policy class | Full deployed system E2E |
| Tags | `@regression @full-stack` |
| Intent | A wardrobe item survives the real auto-tagging pipeline: the upload is confirmed idempotently before and after the terminal state, tagging reaches `ready` with a monotonic state version across a reload and a second browser page, the item can be edited, and deletion removes it without disturbing items that pre-date the run |
| Current caller | The `full` operation of the protected `qualify` entry, through the release-gating selection. `test:smoke` does not select it |
| Assertion boundary | Deployed Client UI and Service HTTP API together, with the Service's real provider call in the path |
| Actual operation | Leases a synthetic Cognito identity, signs in through the real Client, presigned-uploads a fixture to S3, creates and mutates a wardrobe item, and invokes the external VLM |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current; retired only with a caller and lifecycle decision per the policy's retention rules |
| Command | `pnpm test:regression`, and `pnpm test` because the suite step runs the same selection |
| Default trigger | The `full` operation of the `qualify` entry, whose selection this scenario is part of |
| Cost | External write and paid provider cost: one identity, one uploaded object, one tagging task per attempt. Not separately metered |
| Side effects | Application rows, an S3 object, provider spend, and a Cognito identity |
| Evidence level | Qualification, when the complete selection and the pre/post identity checks pass |
| Disposition | Retain |
| Cleanup contract | `DirectTeardown` against the attempt's own `run_scope`/`test_scope`: register before the first business side effect, bind the owner subject, capture the created `wardrobe_item`, then finalize with the attempt's own authorization. The scenario reads back exact absence (HTTP 404) independently of the product assertion, and a teardown that is not `passed` quarantines the scope and fails a separate gate. The worker-lease fixture then deletes the Cognito identity and releases the lease |
| Verification rationale | The product assertion stands alone; teardown is reported beside it and never rewrites it. A red result means a product defect or a provider failure — the scenario requires a terminal `ready`, so a provider failure cannot pass by the processing indicator disappearing. `retries: 0` is configured, because a failed provider attempt must not be repeated automatically and protected recovery owns non-terminal resources |
| Red result means | A release-gating product failure. It is not a measurement: no measurement failure can produce it, and it cannot be excused as one |

### `tests/auth-startup.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Session startup @smoke @regression @full-stack` |
| Policy class | Deployed smoke, and Full deployed system E2E in the release selection |
| Tags | `@smoke @regression @full-stack` |
| Intent | The real session starts, is restored across documents, and is destroyed on logout: every authenticated step observes a successful `/users/me` with a bearer header, no transient sign-in heading or login form, and no unexpected navigation to `/login`; an unauthenticated reload and a protected navigation issue no profile request; the persisted Amplify session is cleared before the next document |
| Current caller | `test:smoke` in the `smoke` operation, and the release-gating selection in `full` |
| Assertion boundary | Deployed Client UI and navigation behaviour together with the Service profile endpoint and the real identity provider's session storage |
| Actual operation | Leases a synthetic Cognito identity, signs in through the real Client, navigates, reloads, opens a second page in the same context, signs out, and reads browser storage |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current |
| Command | `pnpm test:smoke` for the diagnostic, and `pnpm test:regression` for the qualification |
| Default trigger | The `smoke` operation's dispatch, and the `full` operation |
| Cost | External write and paid provider cost bounded by one leased identity and no business resource; no provider spend |
| Side effects | A Cognito identity for the duration of the attempt; in-page observation bindings |
| Evidence level | Deployed smoke for the diagnostic run; Qualification as part of the complete release selection |
| Disposition | Retain |
| Cleanup contract | Declares `declareNoBusinessCleanup` with `teardownResult: 'passed'`, because the attempt creates no business resource. The worker-lease fixture then deletes the captured Cognito identity, reads back its absence, and releases the lease; the declaration replaces the business-cleanup operation, never the identity cleanup. An undeclared attempt is treated as `partial` and quarantined rather than released |
| Verification rationale | The scenario is the stable critical path the smoke invocation requires, and it is the only `@smoke` scenario that exercises session destruction as well as startup. Its retry budget is the workflow default rather than `0`, so a run that only passes on a retry is a flake to investigate, not evidence that its assertion needed the retry |
| Red result means | A product failure in session startup, restore or logout — or an environment or credential condition. A red smoke run withholds diagnostic confidence but asserts no release verdict by itself; the same red inside the qualification selection fails the release gate |

### `tests/auth.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Optional public registration @regression @full-stack` |
| Policy class | Full deployed system E2E |
| Tags | `@regression @full-stack` |
| Intent | Public registration, when explicitly opened, admits a synthetic user through the deployed Client and that user can sign in and reach the dashboard |
| Current caller | The release-gating selection in the `full` operation. No workflow sets `E2E_PUBLIC_REGISTRATION_OPEN`, so it is collected and skipped in every current run |
| Assertion boundary | Deployed Client registration and sign-in flow against the real identity provider |
| Actual operation | Creates and reserves an `ephemeral` test account, registers it through the UI, confirms it, signs in, and deletes the identity |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Retain while admission policy can change; the scenario is the only acceptance path for an opened registration surface |
| Command | `pnpm test:regression` |
| Default trigger | Skipped by default. It runs only when an operator explicitly opens registration for the environment, which no workflow does |
| Cost | External write: one ephemeral identity per attempt. No provider spend |
| Side effects | A Cognito identity, deleted in the scenario's own `afterEach` |
| Evidence level | Qualification for the admission claim, on a run that actually executed it rather than skipped it |
| Disposition | Retain as an explicitly optional acceptance scenario |
| Cleanup contract | Its own account lifecycle rather than the shared worker-lease fixture: reserve the account in `ephemeral` mode, then `deleteTestAccount` in `afterEach`, which re-verifies the captured subject before `AdminDeleteUser` and quarantines the account if deletion refuses. It does not use `tests/support/fixtures.ts`, so it has no attempt-keyed business-cleanup declaration and the post-suite worker cleanup cannot dispose of an abandoned ephemeral account |
| Verification rationale | The scenario is the registration-path acceptance the policy allows to stay optional with a separate purpose, and it can never be the sole smoke case. A skipped run establishes nothing, so it must never be read as a passing admission result |
| Red result means | A product failure in the registration or admission path. A skipped result means the claim was not established, not that it holds |

### `tests/worker-smoke.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Worker account smoke @smoke @regression @full-stack` |
| Policy class | Deployed smoke, and Full deployed system E2E in the release selection |
| Tags | `@smoke @regression @full-stack` |
| Intent | The first profile read of the attempt's own synthetic identity binds that identity, and the signed-in account reaches the dashboard and the wardrobe |
| Current caller | `test:smoke` in the `smoke` operation, and the release-gating selection in `full` |
| Assertion boundary | Deployed Client UI against the Service profile endpoint and the real identity boundary |
| Actual operation | Leases a synthetic Cognito identity, signs in through the real Client, observes the first `GET /users/me`, and navigates to two routes. No upload and no provider call |
| Owner | AnyWear-E2E maintainers |
| Lifecycle | Current. It exists to observe the profile binding that issue #129 could only read from CloudWatch |
| Command | `pnpm test:smoke` for the diagnostic, and `pnpm test:regression` for the qualification |
| Default trigger | The `smoke` operation's dispatch, and the `full` operation |
| Cost | External write bounded by one leased identity; no provider spend |
| Side effects | A Cognito identity for the duration of the attempt; a retained trace on failure, by an explicit file-scoped `test.use`, because the failed attempt is the evidence |
| Evidence level | Deployed smoke for the diagnostic run; Qualification as part of the complete release selection |
| Disposition | Retain |
| Cleanup contract | Declares `declareNoBusinessCleanup` with `teardownResult: 'passed'`. The worker-lease fixture deletes the captured Cognito identity, reads back its absence, and releases the lease. Ownership is per attempt: the address is bound to the run scope and slot and is never re-bound |
| Verification rationale | The binding assertion is the reason the scenario exists and it cannot be established at a lower boundary: the defect it guards against appeared only against the deployed identity boundary. The profile status is attached as evidence for a red run |
| Red result means | A product failure in the identity/profile binding contract, or an environment condition. As smoke it withholds diagnostic confidence; inside the release selection it fails the gate |

### `tests/beta-sizing.spec.ts`

| Field | Value |
| --- | --- |
| Declared title | `Representative Beta sizing @full-stack @beta-sizing @instrumentation` |
| Policy class | `Destructive/expensive drill`, admitted as measurement rather than as a gate: it spends paid provider work, so the policy classes it as a drill even though it observes the ordinary deployed environment |
| Tags | `@instrumentation` to select it, plus `@full-stack` for cross-repository discovery and `@beta-sizing` as the sizing workload identifier |
| Intent | A frozen representative workload — twelve upload/tagging cases and eight virtual try-on cases — runs once against the deployed environment so cost, capacity and provider behaviour can be measured from its own artifact |
| Current caller | The `measure` operation of the protected `qualify` entry, which requires a sizing stage as an input. It also skips itself unless `BETA_SIZING_STAGE` is `S1`, `S2` or `S3` |
| Assertion boundary | The deployed Service's task pipeline, provider calls, streaming responses and credit accounting, with the deployed Client used for navigation and reloads |
| Actual operation | Leases a synthetic identity, uploads frozen fixtures through presigned URLs, submits tagging and VTO work, reads back terminal states, samples ordinary routes, and writes `test-results/beta-sizing-workload.json` |
| Owner | AnyWear-E2E maintainers, under the sizing work item |
| Lifecycle | Current while the sizing envelope and cost baseline are being established; it is retired or replaced only with a recorded caller and evidence decision |
| Command | `pnpm test:instrumentation` |
| Default trigger | Explicit operator dispatch of the `measure` operation, never as part of the `full` operation. It is never part of the release-gating selection |
| Cost | The most expensive scenario here: paid provider spend on twelve uploads and eight VTO generations, plus one leased identity per attempt |
| Side effects | Application rows, generated images, provider spend, and a Cognito identity |
| Evidence level | Diagnostic and measurement; the policy's Qualification level is not reachable from an instrumentation result |
| Disposition | Retain as instrumentation; its own record, not a release verdict |
| Cleanup contract | `DirectTeardown` against the attempt's own scope, capturing every created `wardrobe_item`, `base_photo`, `outfit` and `outfit_generation`. It refuses to report a captured child without its owning resource, proves absence by exact readback for routed resources and by the authenticated list route for base photos, and performs no ad hoc deletion. A teardown that is not `passed` quarantines the scope and fails the separate teardown gate |
| Verification rationale | The scenario's own terminal record decides its outcome: `passed` only from a completed workload, otherwise `failed-or-incomplete`. The workload is bounded by the measured S1 input envelope, and each observation records the aggregate bytes it actually submitted. `retries: 0`, because each attempt spends real provider budget |
| Red result means | An unqualified or rejected measurement, not a product verdict. It cannot fail release qualification, and a passing measurement is not qualification evidence. A run that is not the `measure` operation of the `qualify` entry is refused before any provider call |

## Admission rule

The [testing policy
admission rule](https://github.com/git-malu/AnyWear-Meta/blob/main/architecture/system-component-architecture/technical-architecture/devops/test/test_governance.md)
governs whether a new deployed scenario is admitted, and this document does not restate it:
the policy is its single normative statement, so that a reader has one wording to rely on
rather than two that can drift apart.

What this repository adds is the local procedure a candidate follows once the policy admits
it, because a scenario's verdict follows from the invocation that selects it:

1. Declare the invocation tag on the `test.describe` title, and give the scenario a
   section in this document that applies the policy's inventory-row fields.
   `tests/scenario-declarations.test.mjs` fails the offline check if a spec and this
   document disagree.
2. Tag a release-gating scenario `@regression` and every cross-repository scenario
   `@full-stack`. Reserve `@instrumentation` for measurement workloads and drills, which
   the policy admits as measurement and never as a gate.
3. Record the cleanup contract. A scenario that creates no business resource declares that
   in its own attempt record; an absent declaration is not a declaration.
4. Satisfy the offline `pnpm check` gate before the scenario enters any deployed
   invocation.

## Related documents

- [README](../README.md) — commands, execution policy and the CI model
- [AGENTS.md](../AGENTS.md) — repository ownership and stage rules
