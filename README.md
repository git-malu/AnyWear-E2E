# AnyWear

AnyWear is an AI-powered virtual try-on and wardrobe management platform designed to revolutionize how users interact with their clothing, daily styling, and fashion purchases. It is built as a cloud-native, serverless-container application utilizing a modern stack (Tauri, React, Node.js, AWS ECS Fargate, Aurora Serverless).

## Core Features

- **Virtual Try-On (VTO) Engine**: Powered by ByteDance's Seedream 5.0, the core VTO engine realistically maps selected garments onto a user's uploaded "base photo," handling multi-garment fusion and pose preservation.
- **Digital Wardrobe Management**: Users can digitize their real-world wardrobe. The platform automatically tags clothing attributes (category, color, material, brand, etc.) and removes backgrounds using 2026 SOTA Vision-Language Models (VLM) such as GLM-5V or Qwen3-VL. It also supports vector-based visual search to quickly locate items via images.
- **AI Styling & Recommendations**:
  - **Context-Aware Recommendations**: Utilizing the ByteDance doubao-seed-2-0 model alongside hyperlocal weather data (via QWeather), the app provides daily personalized outfit suggestions directly rendered onto the user's avatar.
  - **Conversational AI Stylist**: An interactive chat interface allows users to request outfit ideas using natural language, dynamically generating styled VTO images based on the user's prompt and wardrobe context.
- **Social Sharing**: Users can create social networks, share their digital wardrobes, and even perform proxy try-ons for friends and family based on role-based permissions.
- **Marketplace Integration**: Integrates with third-party retailers to allow users to virtually try on clothes from online stores before purchasing seamlessly through the platform.

## Architecture Highlights

- **Client**: Cross-platform application (Desktop and Mobile) built with Tauri v2, React 19, TypeScript, Vite, and Tailwind CSS v4.
- **Service (Backend)**: A modular monolith deployed on AWS ECS Fargate using a "One Task" unified architecture. Built with Node.js, Hono, Drizzle ORM, and LangGraph.js.
- **Architecture and API Contracts**: `AnyWear-Meta` owns product and architecture documentation. Service generates the shared `api` contract; Client consumes a published API revision in Service → API → Client order.
- **System Tests**: `AnyWear-E2E` owns Playwright flows that cross the real Client and Service boundary. Its versioned `compatibility.json` defines the exact CI inputs; source delivery and actual deployment qualification have separate acceptance gates.
- **Cloud Infrastructure**: `AnyWear-Infra` owns the shared AWS CDK source and reviewed infrastructure workflows for Cognito, Aurora Serverless, S3 and other shared resources under [ADR 0021](AnyWear-Meta/architecture/ADR/0021-shared-infrastructure-repository.md). Service's CDK/deployment entry points are source-retired; effective cloud permissions and runtime acceptance are verified separately in #54.

This shell contains five submodules: Client, Service, Meta, E2E and Infra. Their fixed commit pins reproduce a local workspace; the shell owns no application build, deployment pipeline or cross-repository credentials. Service owns immutable application/Lambda artifacts, migrations and verification commands; Infra verifies immutable Service releases and automatically verifies the publisher, while Client publishes independently. Infra source registration does not establish artifact publication, native consumer acceptance, deployment or system qualification.

## Local Development

### Prerequisites

- **Node.js** >= 24
- **pnpm** (package manager)
- **Docker Desktop** (for local PostgreSQL)
- **Rust toolchain** (for Tauri desktop builds)

### 1. Clone & Initialize Submodules

```bash
git clone <repo-url> && cd AnyWear
git submodule update --init --recursive
```

### 2. Start the Backend

See [`AnyWear-Service/README.md`](AnyWear-Service/README.md) for full setup instructions. All available scripts are defined in [`AnyWear-Service/package.json`](AnyWear-Service/package.json).

Quick start:

```bash
cd AnyWear-Service
pnpm install
aws sso login --profile anywear-dev
pnpm sync:dev-env
pnpm db:up
pnpm db:generate && pnpm db:push
pnpm dev                           # → http://localhost:3000, Swagger UI at /docs
pnpm test                          # vitest run
```

#### Infrastructure Source and Operations

Run bounded source checks in the Infra repository using [its required checks](AnyWear-Infra/AGENTS.md#required-source-checks) and [package scripts](AnyWear-Infra/package.json). These checks do not deploy resources. Assign infrastructure source changes to Infra; Service owns application artifacts and migration/verification code.

For cloud operations, follow the [Beta runbook](AnyWear-Infra/docs/runbooks/beta-infrastructure.md) and [cutover/recovery runbook](AnyWear-Infra/docs/runbooks/cutover-and-recovery.md) with the manager's exact source/input and environment writer allocation. Verify the AWS account, profile and region first. Only the Kanban manager controls Beta on/off, and a start or reactivation requires the user's explicit consent under the [lifecycle rules](.agents/skills/kanban-workflow/SKILL.md#beta-lifecycle-authority). Do not infer runtime authority from a local submodule pin.

### 3. Start the Frontend

See [`AnyWear-Client/README.md`](AnyWear-Client/README.md) for full setup instructions. All available scripts are defined in [`AnyWear-Client/package.json`](AnyWear-Client/package.json).

Quick start:

```bash
cd AnyWear-Client
pnpm install
# `.env` is generated by `AnyWear-Service/pnpm sync:dev-env`
pnpm dev                           # web dev server
# or: pnpm tauri dev               # Tauri desktop app
pnpm test                          # vitest (watch mode)
pnpm test:run                      # vitest single run
pnpm test:coverage                 # vitest with coverage
pnpm test:browser                  # Client-only browser integration tests
```

### 4. Run System E2E

System E2E runs from the dedicated repository. Local commands use the sibling
Client and Service checkouts; E2E CI uses the exact commits in
`AnyWear-E2E/compatibility.json`:

```bash
cd AnyWear-E2E
pnpm install
pnpm check
pnpm test:smoke
pnpm test:full-stack
```

See [`AnyWear-E2E/README.md`](AnyWear-E2E/README.md) for database, AWS, and environment prerequisites.

### 5. Syncing the `api` Submodule

Both Client and Service share the `api` submodule as the source of truth for OpenAPI specs and shared types.

- **After API changes in Service**: run `pnpm dev` to regenerate `api/anywear_openapi.yaml`.
- **In Client**: run `pnpm orval` to regenerate typed API hooks from the updated spec.
- **Publish and consume in order**: commit/publish the generated contract in the `api` repository, record its full revision in Service, then have the assigned Client writer pin that released revision and regenerate its client. Commit each repository's changes inside that repository; do not use a floating branch as a release input.
