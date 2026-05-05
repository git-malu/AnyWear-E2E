---
name: autonomous-e2e-test
description: Use Playwright MCP to autonomously drive E2E testing of the AnyWear Tauri app's web layer — navigate the UI, fill forms, upload images, click buttons, and verify behavior without pre-written test scripts.
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: testing
---

## What I do

- Guide autonomous end-to-end testing of AnyWear Client's web layer via Playwright MCP (`@playwright/mcp`).
- Provide reusable test image assets and a test account for consistent, repeatable test flows.

## When to use me

After implementing a feature and passing scripted tests (unit, integration, e2e). Load this skill to autonomously drive the running app and verify real-world behavior.

The full set of features to be tested is defined in `AnyWear-Meta/feature/` — read those feature docs to understand the expected user flows and acceptance criteria before testing.

## Prerequisites

1. Playwright MCP configured in `opencode.json`:
   ```json
   { "mcp": { "playwright": { "type": "local", "command": ["npx", "-y", "@playwright/mcp"], "enabled": true } } }
   ```
2. Vite dev server running at `http://localhost:1420` (`pnpm dev` in `AnyWear-Client`).
3. Backend service running and reachable.

## Bundled Test Resources

All paths are relative to this skill directory (`<workspace>/.agents/skills/autonomous-e2e-test/`).

### Test Account

Read from `credentials/test-account.yaml` before starting. Use these credentials to sign in/up during tests.

### Asset Images

Use absolute paths with `browser_file_upload`.

| Directory | Count | Use Case |
|-----------|-------|----------|
| `assets/base-photos/` | 1 PNG | User profile photo, VTO base image |
| `assets/wearable-items/` | 6 PNGs | Wardrobe item uploads, VTO clothing |

## Execution Steps

### 1. Prepare

- Confirm Vite dev server is running.
- Read test credentials.
- Resize browser: `browser_resize(width=1280, height=720)`.
- Navigate to `http://localhost:1420`.

### 2. The Testing Loop

For every feature under test, repeat this cycle:

1. **Snapshot** (`browser_snapshot`) — capture the ARIA tree to see the current page state.
2. **Act** — interact using refs from the snapshot: `browser_click`, `browser_type`, `browser_fill_form`, `browser_file_upload`.
3. **Verify** — snapshot again to confirm the expected state change occurred.
4. **Check console** — `browser_console_messages(level="error")` after each flow.
5. **Screenshot** — `browser_take_screenshot` at key moments for visual confirmation.
6. **Wait** — `browser_wait_for(text="<expected>")` after async operations like uploads or AI processing.

Never act without snapshotting first. Always use ARIA `ref` values from the live snapshot — never hardcode selectors.

### 3. Common AnyWear Flows

**Sign In:** Navigate to sign-in, fill email/password from test credentials, submit, wait for user name to appear.

**Wardrobe Upload:** Navigate to `/wardrobe`, click "Add Item", `browser_file_upload` an image from `assets/wearable-items/`, fill category/metadata, save, wait for item to appear in grid.

**VTO:** Navigate to `/vto`, upload a base photo from `assets/base-photos/`, upload a wearable item, wait for AI processing, verify result is visible.

### 4. Report

After testing, output a concise summary: features tested, pass/fail per feature, console errors observed, and screenshot paths.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Element with ref 'eXX' not found` | ARIA tree changed between snapshot and interaction | Re-snapshot before interacting to get fresh refs |
| `Cannot find file` | Relative path used for `browser_file_upload` | Always use absolute paths to `assets/` |
| Timeout waiting for text | Async operation slow | Increase wait time or re-snapshot to check state |
| Console `window.__TAURI__` errors | Running in standalone Chromium, not WebView2 | Expected — harmless for web-layer testing |

## References

- [`AnyWear-Meta/change/devops/agentic_autonomous_e2e_testing.md`](../../AnyWear-Meta/change/devops/agentic_autonomous_e2e_testing.md) — DevOps setup & MCP configuration
- [`AnyWear-Meta/architecture/agent_driven_testing.md`](../../AnyWear-Meta/architecture/agent_driven_testing.md) — Full testing architecture
