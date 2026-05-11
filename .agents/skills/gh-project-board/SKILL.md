---
name: gh-project-board
description: |
  Manage the AnyWear GitHub kanban board via gh CLI — query columns, move issues between statuses, add items, and discover field/option IDs.

  Triggers when user mentions:
  - "update kanban", "move issue on board", "project board status"
  - "gh project" CLI operations
  - "kanban board", "project board column"
---

## Quick Reference

### Board Identity

| Property | Value |
|----------|-------|
| Project number | `4` |
| Owner | `git-malu` |
| Global node ID | `PVT_kwHOAK8QsM4BXRbk` |
| Repo | `git-malu/AnyWear` |

### Status Column — Field & Option IDs

**Field ID**: `PVTSSF_lAHOAK8QsM4BXRbkzhSfZAI`

| Column | Option ID |
|--------|-----------|
| Backlog | `f75ad846` |
| Ready | `61e4505c` |
| Design | `47fc9ee4` |
| Development | `df73e18b` |
| Review | `47b07b34` |
| Test | `987a1db4` |
| Done | `98236657` |

### Other Custom Fields

| Field | Field ID | Type |
|-------|----------|------|
| Priority | `PVTSSF_lAHOAK8QsM4BXRbkzhSfZOU` | SingleSelect |
| Size | `PVTSSF_lAHOAK8QsM4BXRbkzhSfZOY` | SingleSelect |
| Estimate | `PVTF_lAHOAK8QsM4BXRbkzhSfZOc` | Number |
| Start date | `PVTF_lAHOAK8QsM4BXRbkzhSfZOg` | Date |
| Target date | `PVTF_lAHOAK8QsM4BXRbkzhSfZOk` | Date |
| Parent issue | `PVTF_lAHOAK8QsM4BXRbkzhSfZAg` | Text |
| Assignees | `PVTF_lAHOAK8QsM4BXRbkzhSfZAE` | Text |
| Labels | `PVTF_lAHOAK8QsM4BXRbkzhSfZAM` | Text |
| Milestone | `PVTF_lAHOAK8QsM4BXRbkzhSfZAU` | Text |
| Repository | `PVTF_lAHOAK8QsM4BXRbkzhSfZAY` | Text |
| Reviewers | `PVTF_lAHOAK8QsM4BXRbkzhSfZAc` | Text |

---

## Common Operations

### Get global project node ID

```bash
gh api graphql -f query='query { user(login: "git-malu") { projectV2(number: 4) { id } } }'
# Returns: {"data":{"user":{"projectV2":{"id":"PVT_kwHOAK8QsM4BXRbk"}}}}
```

### List all project fields

```bash
gh project field-list 4 --owner git-malu --format json
```

### List all items on the board

```bash
gh project item-list 4 --owner git-malu --format json
```

### Find an item ID by issue number

```bash
gh project item-list 4 --owner git-malu --format json | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for i in data.get('items', data):
    content = i.get('content', {})
    if content.get('number') == <ISSUE_NUMBER>:
        print(i['id'])
"
```

### Move an issue to a different column

```bash
gh project item-edit \
  --id <ITEM_ID> \
  --field-id PVTSSF_lAHOAK8QsM4BXRbkzhSfZAI \
  --single-select-option-id <OPTION_ID> \
  --project-id PVT_kwHOAK8QsM4BXRbk
```

### Add an issue to the board

```bash
gh project item-add 4 --owner git-malu --url "https://github.com/git-malu/AnyWear/issues/<NUMBER>"
```

### Create an issue and add to board

```bash
gh issue create \
  --repo git-malu/AnyWear \
  --title "Feature title" \
  --body "## Summary\n..." \
  --label "enhancement"

# Then add to board with item-add (see above)
```

### Refresh gh token scope (if permission errors)

```bash
gh auth refresh -s project
```

---

## Gotchas

- **`--project-id` must be the global node ID** (`PVT_kwHOAK8QsM4BXRbk`), not the numeric project number `4`. Using `4` gives: `Could not resolve to a node with the global id of '4'`.
- **`item-edit` has no `--owner` flag** — it's not needed when providing `--project-id`.
- **`item-add` uses `--owner`** but `item-edit` does not.
- **Field IDs always start with `PVT`** (ProjectV2) or `PVTSSF` (ProjectV2 SingleSelectField).
- **Output is silent on success** — if a command returns no output and no error, it succeeded. Verify with `item-list` afterward.
- **Item IDs are opaque** and can only be discovered via `item-list`, not constructed from issue numbers.
