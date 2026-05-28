---
name: git-submodule-ops
description: |
  Recursive git operations for the AnyWear shell repo: pull, commit, push, and
  merge across root + submodules (AnyWear-Meta, AnyWear-Service, AnyWear-Client).
  Always operates submodules first, then root.

  Triggers when user mentions:
  - "pull submodules" / "fetch submodules recursively" / "git submodule update"
  - "commit submodules" / "push submodules recursively"
  - "merge submodules" / "recursive merge" / "merge to main"
  - "repo setup" with submodules
---

# Git Submodule Operations

Recursive git operations for the AnyWear shell repo and its three submodules.

**Core rule: submodules first, then root.** Any operation that modifies state
must be applied to each submodule before touching the root repo.

## Detection

Before any operation, verify you are in the AnyWear shell repo:

```bash
git submodule status | grep -E 'AnyWear-(Meta|Service|Client)'
```

Expected output lists all three submodules. If fewer, you may be in a
subdirectory — navigate to the repo root first.

## Common Prerequisites

These variables are used across operations:

- **Branch name**: `BRANCH` — the feature branch name. If the root is already on
  a non-main branch, use that. Otherwise derive one from context.
- **Submodule list**: `AnyWear-Meta`, `AnyWear-Service`, `AnyWear-Client`.

## Operation: `pull` (Repo Setup / Sync)

Ensures all submodules are initialized and all repos are on the same feature
branch with latest commits.

### Pull — Step 1: Root pull

```bash
git pull origin "$BRANCH" 2>/dev/null || true
```

### Pull — Step 2: Init submodules

```bash
git submodule update --init --recursive
```

### Pull — Step 3: For each submodule

```bash
# Enter submodule directory
cd <submodule>

# Fetch latest
git fetch origin

# Checkout matching feature branch
# If branch exists locally: checkout + pull
# If branch exists on remote only: checkout tracked
# If branch doesn't exist: create from origin/main
if git rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  git checkout "$BRANCH" && git pull origin "$BRANCH"
elif git ls-remote --heads origin "$BRANCH" | grep -q "$BRANCH"; then
  git checkout -b "$BRANCH" "origin/$BRANCH"
else
  git checkout -b "$BRANCH" origin/main
fi

cd ..
```

### Pull — Step 4: Report

```
Repo setup complete — all repos on branch <BRANCH>.
```

## Operation: `commit`

Stages and commits changes in each submodule first, then the root (which
includes submodule pointer updates).

### Commit — Step 1: For each submodule with changes

```bash
cd <submodule>

# Skip if nothing to commit
if [[ -z $(git status --porcelain) ]]; then
  cd ..
  continue
fi

git add -A
git commit -m "<scope>: <description>"
echo "Committed <submodule>"

cd ..
```

### Commit — Step 2: Root repo

```bash
# Root commit always includes submodule pointer updates
git add -A
git commit -m "<scope>: <description>"
echo "Committed root"
```

### Commit — Rules

- Always commit submodules **before** root. The root commit captures the updated
  submodule pointers.
- Skip submodules with no changes (no empty commits).
- Use a descriptive scope prefix (e.g., `feat:`, `fix:`, `chore:`).

## Operation: `push`

Pushes each submodule's feature branch first, then the root.

### Push — Step 1: For each submodule

```bash
cd <submodule>
git push -u origin "$BRANCH"
cd ..
```

### Push — Step 2: Root

```bash
git push -u origin "$BRANCH"
```

### Push — Rules

- Use `-u` (set upstream) on first push; subsequent pushes can omit it.
- If a submodule has no commits to push, `git push` will report
  "Everything up-to-date" — that's fine, continue.

## Operation: `merge` (Recursive Merge to Main)

Merges every submodule's feature branch into `main` first, then the root.
Ensures the root's submodule pointers always reference committed `main` commits.

### Merge — Step 1: For each submodule

```bash
cd <submodule>
git checkout main
git pull origin main
git merge "$BRANCH" --no-edit
git push origin main
echo "Merged <submodule>: $BRANCH -> main"
cd ..
```

### Merge — Step 2: Root repo

```bash
git checkout main
git pull origin main
git merge "$BRANCH" --no-edit

# Sync submodule pointers to latest main commits
git submodule update --init --recursive

git push origin main
echo "Merged root: $BRANCH -> main"
```

### Merge — Step 3: Clean up

Ensure all submodules are back on `main` (in case any stayed on the feature
branch):

```bash
for dir in AnyWear-Meta AnyWear-Service AnyWear-Client; do
  cd "$dir"
  [[ $(git branch --show-current) != "main" ]] && git checkout main
  cd ..
done
```

## Common Rules

1. **Submodules first, then root.** Always. Submodule pointer updates in the
   root must reference changes that already exist in the submodule repos.
2. **Same branch name across all repos.** The feature branch name must be
   identical in the root and all submodules.
3. **Never commit/push root before submodules.** If a submodule has uncommitted
   changes, the root's pointer won't match what's pushed to the remote.
4. **Verify `git submodule update --init --recursive` after root merge.** This
   syncs local submodule checkouts to the pointers recorded in the merged
   `main`.

## Quick Reference

| Operation | Order | Key Command |
|-----------|-------|-------------|
| `pull` | Root pull → init → submodules → checkout branch | `git submodule update --init --recursive` |
| `commit` | Submodules → root | `git add -A && git commit -m "..."` |
| `push` | Submodules → root | `git push -u origin <branch>` |
| `merge` | Submodules → root → cleanup | `git merge <branch> --no-edit` then `git submodule update --init --recursive` |
