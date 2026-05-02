---
name: push-worktree
description: Push changes from a worktree-based shell repository with Git submodules to main, tag releases, and ensure consistent submodule pointers
license: MIT
compatibility: opencode
metadata:
  audience: developers
  workflow: version-control
---

## What I do

- Safely push changes from a worktree-based shell repository containing Git submodules (`AnyWear-Service`, `AnyWear-Client`, `AnyWear-Meta`).
- Handle the shared `api` submodule dependency order between Service and Client.
- Tag releases consistently across all repos.
- Resolve common worktree and submodule pitfalls (detached HEAD, dirty submodule files, locked branches).

## When to use me

Use this when the user asks to "push to main", "ship changes", "merge and push", or any variant across the AnyWear multi-repo setup.

## Critical Constraints

1. **Dependency Order**: The `api` submodule (`AnyWear-Service-API`) must be pushed **first**, then each parent repo's submodule pointer must be updated afterward:
   ```
   1. api submodule (AnyWear-Service-API)     ← push first
   2. AnyWear-Service                         ← then update api pointer
   3. AnyWear-Client                          ← then update api pointer
   4. AnyWear-Meta                            ← independent, can go in parallel with 2-3
   5. Root (stellar-comet)                    ← last: update all 3 submodule pointers
   ```
2. **Tagging Convention**: All repos in the same feature push must use the **same semantic tag name** for traceability. Tags are named after the feature (e.g., `"vto-engine"`, `"daily-recommendation"`).
3. **Worktree Safety**: Root's `main` may be locked by another worktree. Always use `git push origin HEAD:main` for the root repo, never `git push origin main`.

## Execution Steps

### Step 1: Check Status of All Repos

Run these in parallel to assess what needs committing:

```bash
# Root
git status

# Service
git -C AnyWear-Service status

# Client
git -C AnyWear-Client status

# Meta
git -C AnyWear-Meta status

# api submodule (in Service)
git -C AnyWear-Service/api status
```

### Step 2: Push api Submodule (if changed)

Only if the OpenAPI spec (`anywear_openapi.yaml`) was modified:

```bash
# Navigate to api submodule
cd AnyWear-Service/api
git checkout main
git pull origin main
git add anywear_openapi.yaml
git commit -m "feat: <feature-name>"
git tag "<tag-name>" -m "<tag-message>"
git push origin main
git push origin tag <tag-name>
```

Note the new commit hash — it will be needed for Step 3.

### Step 3: Push Service Repo

```bash
cd AnyWear-Service
git checkout main
git pull origin main
git add .
git commit -m "feat: <feature-name>"
git tag "<tag-name>" -m "<tag-message>"
git push origin main
git push origin tag <tag-name>
```

### Step 4: Push Client Repo

The Client's `api` submodule must point to the latest commit from Step 2. If the submodule checkout is stale or has dirty files:

```bash
cd AnyWear-Client/api
git checkout main
git restore anywear_openapi.yaml   # discard dirty copies
git pull origin main               # fast-forward to latest

cd ..  # back to AnyWear-Client
git checkout main
git pull origin main
git add api                        # stage the updated submodule pointer
git add .
git commit -m "feat: <feature-name>"
git tag "<tag-name>" -m "<tag-message>"
git push origin main
git push origin tag <tag-name>
```

### Step 5: Push Meta Repo

```bash
cd AnyWear-Meta
git checkout main
git pull origin main
git add .
git commit -m "feat: <feature-name>"
git tag "<tag-name>" -m "<tag-message>"
git push origin main
git push origin tag <tag-name>
```

### Step 6: Push Root Repo

```bash
cd .  # back to root
git add AnyWear-Service AnyWear-Client AnyWear-Meta
git commit -m "feat: update submodule pointers for <feature-name>"
git push origin HEAD:main          # push current branch's HEAD to remote main
git tag "<tag-name>" -m "<tag-message>"
git push origin tag <tag-name>
```

### Step 7: Verify

```bash
# Compare api submodule commits across Service and Client
git -C AnyWear-Service/api rev-parse HEAD
git -C AnyWear-Client/api rev-parse HEAD
# Both must match

# Check that the Client's parent commit has the correct api pointer
git -C AnyWear-Client ls-tree HEAD api
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `fatal: 'main' is already used by worktree` | Root's main is checked out in another worktree | Use `git push origin HEAD:main` instead of `git push origin main` |
| `error: Your local changes would be overwritten by merge` | Submodule has dirty files not tracked by git | `git restore <file>` then `git pull` |
| Client api submodule at old commit | `git add api` staged the old pointer | Go into `AnyWear-Client/api`, `git checkout main && git pull origin main`, then `git add api` in parent |
| `HEAD detached at <hash>` | Submodule checked out at a specific commit, not a branch | `git checkout main` first to attach to branch |
