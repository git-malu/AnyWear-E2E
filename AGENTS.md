# AnyWear E2E Agent Instructions

This repository owns system tests that cross at least two deployable AnyWear
boundaries. It uses TypeScript, Playwright Test, Node.js 24, and pnpm 11.18.0.

## Ownership Rules

- Keep mocked browser tests in `AnyWear-Client`.
- Keep Service route, database, contract, and CDK tests in `AnyWear-Service`.
- Add a test here only when it exercises the real Client and Service together,
  a deployed environment, or a real external identity/cloud boundary.
- Treat Client and Service as black boxes. Do not import their implementation
  modules into E2E tests.

## Stage Policy

- Do not run or gate the `AnyWear-E2E` suite in the dev stage. Dev-stage
  verification is covered by unit tests and integration tests; those are
  sufficient for that stage.
- Run this E2E suite only in the beta stage and later stages, including prod.
  Do not add dev-stage E2E jobs, release gates, or required checks.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Audit: `pnpm audit`
- Lint: `pnpm lint`
- Type check: `pnpm typecheck`
- Discover tests: `pnpm test:list`
- Smoke tests: `pnpm test:smoke`
- Release-gating deployed selection: `pnpm test:regression`; `pnpm test` runs the same
  selection, and the protected qualification step runs it as the release gate
- Scenario classification: [docs/scenario-inventory.md](docs/scenario-inventory.md)

Run install and build commands from this repository.

## Test Design

- Tag stable critical paths with `@smoke`, release-gating scenarios with
  `@regression`, and all cross-repository scenarios with `@full-stack`.
- Classify every scenario in the [scenario inventory](docs/scenario-inventory.md):
  its policy class, intent, selecting invocation, evidence level, cleanup contract
  and what a red result means. A new scenario is admitted only under the testing
  policy's admission rule.
- Lease a distinct worker-pool address per parallel test attempt through the account-budget
  ledger, and generate unique records per test, so parallel execution is safe. The pool rows
  are stable by design; the lease, not a random address, is what separates attempts.
- Clean up every cloud resource created by a test in teardown, even after a
  failed assertion.
- Fail clearly when required environment variables are missing; do not silently
  skip a required CI gate.
- Use role, label, and visible-text locators before test IDs or CSS selectors.
- Never commit credentials, browser storage state, reports, traces, screenshots,
  or videos.
- Qualification reads the live deployed tuple. The Client identifies itself through
  `build-metadata.json` (`source_commit`, `client_version`, `built_at`, schema 3) and the
  Service through `/health` (`service_commit`, `image_digest`, `minimum_client_version`);
  `full` compares those values with the dispatch expectation and refuses a mismatch before
  the suite, naming the observed and the expected value. The only committed input on the
  live path is `minimum-supported-client.json` (`{version, sha}`): the oldest supported
  Client the deployed Service still accepts, whose `version` must equal the live Service
  floor (a disagreement is a refusal, never an automatic choice). Do not add a committed
  file that describes the deployed revisions; that is what #180 removed.
- For release qualification, record the full intended Client, Service, and E2E
  SHAs and verify that the target environment serves those Client and Service
  revisions through Client `build-metadata.json` and Service `/health`. Recheck
  both identities, the platform observation and the Service image digest after the suite;
  a mismatch or deployment change cannot qualify the release. Preserve the observed runtime
  revisions, image digest, environment endpoints, and qualification run/artifact
  links together with the intended SHAs in the release evidence. Checking out
  pinned source alone does not prove the deployed system ran it.
- Qualification reads the live Service release identity, never a manifest. The live Service
  commit must resolve to an immutable `service-artifacts-<service sha>` GitHub release whose
  tag resolves to that commit and whose four expected assets (`pre-sign-up.zip`,
  `post-confirmation.zip`, `runtime-policy.json`, `service-schema.json`) are each uploaded
  with a non-empty size and a published `sha256:<hex>` digest. The gate reads only the
  release and the tag ref through the GitHub API and downloads zero release asset bytes. An
  extra asset is ignored, so a pre-change five-asset release (the four plus the retired
  `service-artifacts.json`) stays qualifiable for rollback; its manifest is never read or
  parsed. The image digest stays in the live `/health` identity and is not compared with a
  release field.
- Qualification record schema v4 is self-contained: `expected`, `revisions`
  (`e2e`/`client`/`service`, never `infra`), `service_artifacts`
  (`{repository, release_id, tag, target_commit, assets}` where `tag` is
  `service-artifacts-<service sha>`, `target_commit` is the commit the tag resolved to, and
  `assets` is exactly the four released names each with `{size, digest}`), the two
  `observations`, `test`, `workflow` (including `trigger` and `dispatched_by`) and
  `integrity`. It has no `compatibility` and no `deployment` member, and the v4 verifier
  refuses a v2/v3 record. The independent platform observation is this repository's own
  authenticated read (`scripts/infra-observation.mjs`) through the vendored contract, not a
  cross-repository Infra checkout.
- The compatibility pin is **deleted** (#192): the committed pin file, `docs/compatibility-pin.md`,
  `docs/compatibility-v3.md` and the pin tools (`validate-compatibility-pin.mjs`,
  `migrate-compatibility.mjs`, `check-compatibility.mjs`) were removed, and no
  **release-qualification** path read them (`beta-qualification.yml`, `pnpm check`, `test:core`
  and `test:list` were pin-free). The last manual expected-tuple readers — the
  `runtime-drill.mjs` and `runtime-recovery-artifact.mjs` CLIs — were retired with the runtime
  instrumentation ladder under #213, so no tracked command reads a qualification tuple or a
  committed deployment file, no workflow, `pnpm check`, `test:core` or `test:list` path is
  affected, and `minimum-supported-client.json` remains the only committed input on the live
  path.
- Beta registration is gated by the exact tester allowlist in the Cognito `PreSignUp`
  trigger (#213). The deployed scenarios lease one of the eight stable worker-pool addresses
  (`e2e-beta-worker-0-chromium@anywear.local` … `-7-`, offset by `E2E_WORKER_SLOT_OFFSET`) and
  never mint an address; the qualification pre-flight refuses before the first account exists
  unless every pool address the run can lease is on the allowlist. Do not add a synthetic
  address family, an `E2E_PUBLIC_REGISTRATION_OPEN` switch, or any reader/writer of
  `custom:e2e_bootstrap` back.
- The release decision is the green `full` run plus the sealed record that `record` verifies
  and attaches. There is no separate approval job or approval Environment: the audit trail is
  the `qualify` `workflow_dispatch` event (actor and time), the E2E `full` run/attempt and the
  record tuple. Do not add an approval Environment or approval/`Approved`/`Rejected` states.
- The single protected `qualify` entry in `beta-qualification.yml` owns the deployed
  operations for beta and later stages; it must not target dev. Separation between
  qualification, the smoke diagnostic and account recovery now lives in the
  signed `operation` field, not in a workflow-file boundary: `qualification-record.json` is
  produced only by the `full` operation, the record binds the operation that was dispatched,
  and both this repository's producer/verifier and the Infra-side executor allow-list require
  `operation: full`. A `smoke` or `recover` run therefore can neither produce nor
  withhold the record the release gate produced, and a recovery result is
  never substituted for qualification evidence.
