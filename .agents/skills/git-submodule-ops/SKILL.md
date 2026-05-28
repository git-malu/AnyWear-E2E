---
name: git-submodule-ops
description: |
  Recursive git operations for the AnyWear shell repo: pull, commit, push, and
  merge across root + all submodules (AnyWear-Meta, AnyWear-Service,
  AnyWear-Client, plus nested api/ submodules).
  Always operates innermost submodules first, then outward to root.

  Triggers when user mentions:
  - "pull submodules" / "fetch submodules recursively" / "git submodule update"
  - "commit submodules" / "push submodules recursively"
  - "merge submodules" / "recursive merge" / "merge to main"
  - "repo setup" with submodules
---

# Git Submodule Operations

Recursive git operations for the AnyWear shell repo and its submodules.

**Core rule: innermost first, then outward to root.** Any operation that
modifies state must be applied to nested submodules first, then direct
submodules, then the root repo.

## Detection

Before any operation, verify you are in the AnyWear shell repo:

```bash
git submodule status | grep -E 'AnyWear-(Meta|Service|Client)'
```

Expected output lists all three direct submodules. If fewer, you may be in a
subdirectory — navigate to the repo root first.

## Submodule Tree

Operations flow from innermost to outermost:

```
Root (AnyWear)
├── AnyWear-Meta/
├── AnyWear-Service/           ← direct submodule
│   └── api/                   ← nested submodule (source of truth for API types)
└── AnyWear-Client/            ← direct submodule
    └── api/                   ← nested submodule (consumes API types from Service)
```

**Commit/push/merge order**: `api` submodules → direct submodules → root.

**API dependency note**: `AnyWear-Service/api/` is the source of truth for
shared API types. `AnyWear-Client/api/` only consumes them. Any changes to
`api/` must be committed in Service first, then the Client's `api` submodule
pointer synced to that commit.

## Branch Handling

This skill works on **any branch** — not just feature branches. The variable
`$BRANCH` is always the **current branch** of the root repo:

```bash
BRANCH=$(git branch --show-current)
```

- For **commit/push**: operates on `$BRANCH` (whatever it is — `main`, a
  feature branch, etc.).
- For **pull**: uses `$BRANCH` to checkout matching branches in submodules.
- For **merge**: specifically merges `$BRANCH` into `main` (does not assume a
  feature branch name).

## Operation: `pull` (Repo Sync)

Initializes submodules recursively and ensures all repos are on the same branch
with latest commits.

### Pull — Step 1: Init submodules recursively

```bash
git submodule update --init --recursive
```

### Pull — Step 2: Root pull

```bash
git pull origin "$BRANCH"
```

### Pull — Step 3: For each submodule (outer-to-inner for init, then sync)

Enter each submodule directory. The submodule may already be in a detached HEAD
state from `submodule update` — check it out to `$BRANCH`.

```bash
# For each: AnyWear-Meta, AnyWear-Service, AnyWear-Client
cd <submodule>

git fetch origin

# Checkout matching branch
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git checkout "$BRANCH" && git pull origin "$BRANCH"
elif git ls-remote --heads origin "$BRANCH" | grep -q "$BRANCH"; then
  git checkout -b "$BRANCH" "origin/$BRANCH"
else
  git checkout -b "$BRANCH" origin/main
fi

# Init nested api/ submodule (if present)
git submodule update --init --recursive

cd ..
```

### Pull — Step 4: Report

```
Repo sync complete — all repos on branch <BRANCH>.
```

## Operation: `commit`

Stages and commits changes in innermost submodules first, working outward to
the root. Each level's commit captures pointer updates from the level below it.

### Commit — Step 1: Nested `api/` submodules

```bash
# Service/api (source of truth — commit first)
cd AnyWear-Service/api
if [[ -n $(git status --porcelain) ]]; then
  git add -A
  git commit -m "<scope>: <description>"
  echo "Committed Service/api"
fi
cd ../../

# Client/api (sync pointer only if Service/api was updated)
# Run after Service commit so its pointer refers to the committed Service/api hash
cd AnyWear-Client
git submodule update --remote api
cd api
if [[ -n $(git status --porcelain) ]]; then
  git add -A
  git commit -m "chore: sync api submodule pointer"
  echo "Committed Client/api"
fi
cd ../../
```

### Commit — Step 2: Direct submodules

```bash
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir"
  if [[ -n $(git status --porcelain) ]]; then
    git add -A
    git commit -m "<scope>: <description>"
    echo "Committed $dir"
  fi
  cd ..
done
```

### Commit — Step 3: Root repo

```bash
# Root commit always includes submodule pointer updates
if [[ -n $(git status --porcelain) ]]; then
  git add -A
  git commit -m "<scope>: <description>"
  echo "Committed root"
fi
```

### Commit — Rules

- Always commit innermost first (api → direct submodules → root).
- Skip repos with no changes (no empty commits).
- Use a descriptive scope prefix (e.g., `feat:`, `fix:`, `chore:`).
- When Service/api changes, sync Client/api pointer after Service is committed.

## Operation: `push`

Pushes each submodule first, then the root.

### Push — Step 1: Nested `api/` submodules

```bash
cd AnyWear-Service/api && git push -u origin "$BRANCH" && cd ../../
cd AnyWear-Client/api && git push -u origin "$BRANCH" && cd ../../
```

### Push — Step 2: Direct submodules

```bash
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir" && git push -u origin "$BRANCH" && cd ..
done
```

### Push — Step 3: Root

```bash
git push -u origin "$BRANCH"
```

### Push — Rules

- Use `-u` (set upstream) on first push; omit on subsequent pushes.
- "Everything up-to-date" is fine — continue to the next.

## Operation: `merge` (Recursive Merge to Main)

Merges every submodule's current branch into `main` (innermost first), then the
root. The root's submodule pointers always end up referencing committed `main`
commits.

### Merge — Step 1: Nested `api/` submodules

```bash
cd AnyWear-Service/api
git checkout main && git pull origin main
git merge "$BRANCH" --no-edit
git push origin main
echo "Merged Service/api: $BRANCH -> main"
cd ../../

cd AnyWear-Client/api
git checkout main && git pull origin main
git merge "$BRANCH" --no-edit
git push origin main
echo "Merged Client/api: $BRANCH -> main"
cd ../../
```

### Merge — Step 2: Direct submodules

```bash
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir"
  git checkout main && git pull origin main
  git merge "$BRANCH" --no-edit
  git push origin main
  echo "Merged $dir: $BRANCH -> main"
  cd ..
done
```

### Merge — Step 3: Root repo

```bash
git checkout main && git pull origin main
git merge "$BRANCH" --no-edit

# Sync submodule pointers to latest main commits
git submodule update --init --recursive

git push origin main
echo "Merged root: $BRANCH -> main"
```

### Merge — Step 4: Clean up

Ensure all repos are back on `main`:

```bash
for dir in AnyWear-Service/api AnyWear-Client/api AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir" 2>/dev/null || continue
  [[ $(git branch --show-current) != "main" ]] && git checkout main
  cd - >/dev/null
done
```

## Common Rules

1. **Innermost first, then outward.** Nested submodules (`api/`) → direct
   submodules → root.
2. **API source of truth.** `AnyWear-Service/api/` owns shared API types.
   Changes to `api/` must be committed in Service first; Client syncs its
   `api` pointer after.
3. **Same branch name across all repos.** `$BRANCH` is the root's current
   branch and must be used identically across all submodules.
4. **Never commit/push root before submodules.** The root's submodule pointers
   must reference changes that already exist in the submodule repos.
5. **Run `git submodule update --init --recursive` after root merge.** Syncs
   local submodule checkouts to the pointers recorded in the merged `main`.
6. **Works on any branch.** Does not require a feature branch. `$BRANCH` is
   whatever branch the root repo is currently on.

## Quick Reference

| Operation | Order | Key Command |
|-----------|-------|-------------|
| `pull` | Root pull → init recursive → submodules → checkout branch | `git submodule update --init --recursive` |
| `commit` | api/ → direct submodules → root | `git add -A && git commit -m "..."` |
| `push` | api/ → direct submodules → root | `git push -u origin <branch>` |
| `merge` | api/ → direct submodules → root → cleanup | `git merge <branch> --no-edit` then `git submodule update --init --recursive` |
