---
name: git-submodule-ops
description: |
  Recursive git operations (pull, commit, push, merge) for the AnyWear shell
  repo and all submodules, including nested api/ submodules.
  Innermost first, then outward to root.

  Triggers when user mentions:
  - "pull submodules" / "fetch submodules recursively"
  - "commit submodules" / "push submodules recursively"
  - "merge submodules" / "recursive merge" / "merge to main"
  - "repo setup" with submodules
---

# Git Submodule Operations

**Rule**: innermost first (`api/` → direct submodules → root).
**Branch**: `$BRANCH` is whatever branch root is currently on.
Works on any branch, not just feature branches.

## Detection

```bash
git submodule status | grep -E 'AnyWear-(Meta|Service|Client)'
```

## Submodule Tree

```
Root (AnyWear)
├── AnyWear-Meta/
├── AnyWear-Service/    ← source of truth for api/
│   └── api/
└── AnyWear-Client/     ← consumes api/ from Service
    └── api/
```

**API dependency**: `AnyWear-Service/api/` owns shared types. Changes go in
Service first; Client's `api` pointer synced as a separate follow-up step.

## Operations

All use `BRANCH=$(git branch --show-current)`.

### `pull` — Repo Sync

```bash
git submodule update --init --recursive
git pull origin "$BRANCH"

for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir"
  git fetch origin
  if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
    git checkout "$BRANCH" && git pull origin "$BRANCH"
  elif git ls-remote --heads origin "$BRANCH" | grep -q "$BRANCH"; then
    git checkout -b "$BRANCH" "origin/$BRANCH"
  else
    git checkout -b "$BRANCH" origin/main
  fi

  # Nested api/ submodule
  if git submodule status api >/dev/null 2>&1; then
    git submodule update --init --recursive
    cd api
    git fetch origin
    if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
      git checkout "$BRANCH" && git pull origin "$BRANCH"
    elif git ls-remote --heads origin "$BRANCH" | grep -q "$BRANCH"; then
      git checkout -b "$BRANCH" "origin/$BRANCH"
    else
      git checkout -b "$BRANCH" origin/main
    fi
    cd ..
  fi
  cd ..
done
```

### `commit`

```bash
# Step 1: Nested api/
for api_dir in AnyWear-Service/api AnyWear-Client/api; do
  cd "$api_dir"
  if [[ -n $(git status --porcelain) ]]; then
    git add -A && git commit -m "<scope>: <description>"
  fi
  cd - >/dev/null
done

# Step 2: Direct submodules
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir"
  if [[ -n $(git status --porcelain) ]]; then
    git add -A && git commit -m "<scope>: <description>"
  fi
  cd ..
done

# Step 3: Root
if [[ -n $(git status --porcelain) ]]; then
  git add -A && git commit -m "<scope>: <description>"
fi
```

### `push`

```bash
# Step 1: Nested api/
cd AnyWear-Service/api && git push -u origin "$BRANCH" && cd ../../
cd AnyWear-Client/api && git push -u origin "$BRANCH" && cd ../../

# Step 2: Direct submodules
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir" && git push -u origin "$BRANCH" && cd ..
done

# Step 3: Root
git push -u origin "$BRANCH"
```

### `merge` — Recursive Merge to Main

```bash
# Step 1: Nested api/
for dir in AnyWear-Service/api AnyWear-Client/api; do
  cd "$dir"
  git checkout main && git pull origin main
  git merge "$BRANCH" --no-edit
  git push origin main
  cd - >/dev/null
done

# Step 2: Direct submodules
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir"
  git checkout main && git pull origin main
  git merge "$BRANCH" --no-edit
  git push origin main
  cd ..
done

# Step 3: Root
git checkout main && git pull origin main
git merge "$BRANCH" --no-edit
git submodule update --init --recursive
git push origin main

# Step 4: Cleanup — all back on main
for dir in AnyWear-Service/api AnyWear-Client/api AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir" 2>/dev/null || continue
  [[ $(git branch --show-current) != "main" ]] && git checkout main
  cd - >/dev/null
done
```

## Common Rules

- **Innermost first** (`api/` → direct → root). Submodule pointers in each level
  must reference commits that already exist in the level below.
- **Skip empty repos** — no empty commits; "Everything up-to-date" on push is fine.
- **`git submodule update --init --recursive`** after root merge to sync pointers.
- **`-u`** on first push per repo; omit on subsequent pushes.
