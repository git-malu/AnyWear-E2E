# AnyWear E2E

System-level tests for a reviewed combination of `AnyWear-Client` and
`AnyWear-Service`. This repository owns only behavior that crosses deployable
boundaries; repository-local tests remain with the Client or Service.

## Test Boundary

- Browser behavior with mocked APIs belongs in `AnyWear-Client`.
- Route, database, contract, and infrastructure tests belong in `AnyWear-Service`.
- Browser flows that use both the real Client and Service belong here.
- Real cloud smoke tests belong here and must be explicitly tagged.

## Prerequisites

- Node.js 24
- pnpm 11.18.0
- Docker
- AWS credentials for the non-production test environment
- Sibling `AnyWear-Client` and `AnyWear-Service` checkouts

The preferred local layout is the AnyWear shell repository:

```text
AnyWear/
|-- AnyWear-Client/
|-- AnyWear-Service/
|-- AnyWear-Meta/
`-- AnyWear-E2E/
```

## Setup

Install dependencies independently in each repository:

```bash
cd AnyWear-E2E && pnpm install
cd ../AnyWear-Client && pnpm install
cd ../AnyWear-Service && pnpm install
```

Start PostgreSQL and apply committed migrations:

```bash
cd AnyWear-Service
pnpm db:up
pnpm db:migrate
```

After configuring AWS SSO and provisioning the dev secrets, run
`pnpm sync:dev-env` from `AnyWear-Service` after `aws sso login --profile anywear-dev`. This writes the
ignored Service, Client, and E2E `.env` files from SSM and Secrets Manager while
preserving local-only settings such as the database URL and test URLs. Do not commit
`.env` or Playwright authentication state.

## Commands

```bash
pnpm check             # source checks, script tests, and Playwright test discovery; no browser execution
pnpm audit             # fail on high/critical dependency advisories
pnpm test:smoke        # optional on-demand Dev diagnostic
pnpm test:full-stack   # local-only diagnostic; not a PR/Dev gate
pnpm test              # complete deployed Beta qualification suite
pnpm report            # open the latest HTML report
```

Playwright starts the sibling Client and Service automatically. Set
`E2E_EXTERNAL_SERVERS=true` with `E2E_CLIENT_URL` and `E2E_SERVICE_URL` to test
already-running or deployed endpoints.

## Execution Policy

Pull requests do not run cross-repository browser E2E as a required check. The E2E
Quality workflow runs compatibility validation, script tests, lint, type checking, and
Playwright test discovery. Client and Service workflows remain responsible for their
required unit, repository integration, contract, database, and browser integration tests.

The E2E Integration workflow is an on-demand Dev smoke diagnostic and runs only the small
`@smoke` subset. The complete suite is not a PR or Dev CI operation. Developers may run
`pnpm test:full-stack` locally when investigating the composition, but that run is not a
release gate and produces no qualification evidence.

The complete `pnpm test` suite is reserved for the deployed Beta Qualification workflow.
Only a passing run against the exact reviewed Client, Service, and E2E revisions produces
qualification evidence that Production may consume.

Test classification is explicit: `@smoke` marks the small, stable critical path allowed in
the on-demand Dev diagnostic; `@full-stack` marks cross-repository scenarios that may be
run locally for investigation. Beta runs every discovered test, regardless of tag.

The manual `Beta Qualification` workflow is the production-readiness gate for an
already-deployed Beta environment. It reads the reviewed full SHAs from
`compatibility.json`, verifies those identities against the deployed Client
`build-metadata.json` and Service `/health`, runs the complete suite, and uploads a
checksummed qualification record. A failed or mismatched run cannot issue a passing
record. The workflow requests 90-day artifact retention, subject to GitHub's configured
repository or organization ceiling; durable release-ledger storage remains
out of scope for the initial Production launch. The finite GitHub retention window is an
accepted trade-off: after the artifact expires, that qualification can no longer authorize a
new Production deployment or rollback and the candidate must be qualified again. Persistent
S3 evidence storage will be reconsidered only if long-term audit or rollback requirements arise.

## CI Model

`compatibility.json` is the CI source of truth for the Client and Service
revisions under test. It accepts only full commit SHAs; branch and tag names are
rejected. When invoked, the E2E Integration workflow checks out those exact private
repositories, including their recursive API submodules, and records every tested
revision as an artifact.

The AnyWear shell repository remains a convenient local workspace and may pin
the same revisions, but it does not run CI or hold cross-repository credentials.
Update `compatibility.json` only after the peer commits exist on their remotes
and their repository-owned pipelines pass.
