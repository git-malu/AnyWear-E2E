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
- **Meta Contract**: The `AnyWear-Meta` submodule serves as the single source of truth for OpenAPI specifications and Shared TypeScript interfaces to seamlessly bridge the client and service repositories.
- **Cloud Infrastructure**: Embraces AWS managed services including Cognito (with WAF protection for passwordless OTP), Aurora Serverless (PostgreSQL + pgvector), S3, and EventBridge Scheduler.

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

### 2. AnyWear-Service (Backend)

```bash
cd AnyWear-Service
cp .env.example .env               # fill in placeholder values
pnpm install
pnpm db:up                         # start local PostgreSQL via Docker (pgvector)
pnpm db:generate && pnpm db:push   # create and apply DB schema
npm --prefix infra install         # install CDK dependencies
npm --prefix infra run cdk deploy  # provision AWS dev infra (Cognito, S3, RDS)
# → update .env with outputs from CDK deploy
pnpm dev                           # starts on localhost:3000, Swagger UI at /docs
```

### 3. AnyWear-Client (Frontend)

```bash
cd AnyWear-Client
cp .env.example .env               # fill in Cognito IDs (must match Service dev infra)
pnpm install
pnpm run dev                       # web dev server
# or: pnpm run tauri dev           # Tauri desktop app
```

### 4. Syncing the `api` Submodule

Both Client and Service share the `api` submodule as the source of truth for OpenAPI specs and shared types.

- **After API changes in Service**: run `pnpm dev` to regenerate `api/anywear_openapi.yaml`.
- **In Client**: run `pnpm orval` to regenerate typed API hooks from the updated spec.
- **Pull latest submodule**: `git submodule update --remote` in either repo.