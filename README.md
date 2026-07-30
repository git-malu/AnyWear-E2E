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

The preferred layout is the AnyWear shell repository, whose submodule pointers
pin the exact Client, Service, Meta, and E2E revisions under review:

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

Create `AnyWear-E2E/.env` from `.env.example` and populate the dev Cognito,
S3, database, and weather configuration. Do not commit `.env` or Playwright
authentication state.

## Commands

```bash
pnpm check             # lint, type check, and test discovery
pnpm audit             # fail on high/critical dependency advisories
pnpm test:smoke        # stable critical-path gate
pnpm test:full-stack   # all local Client + Service system tests
pnpm test              # complete suite
pnpm report            # open the latest HTML report
```

Playwright starts the sibling Client and Service automatically. Set
`E2E_EXTERNAL_SERVERS=true` with `E2E_CLIENT_URL` and `E2E_SERVICE_URL` to test
already-running or deployed endpoints.

## CI Model

The E2E repository pipeline validates its own source without selecting mutable
Client or Service branches. Full system tests run from the AnyWear shell
repository after recursive submodule checkout, so the reviewed submodule SHAs
are exactly the revisions executed by CI.
