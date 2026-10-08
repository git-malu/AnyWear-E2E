---
name: kanban-manager-continuation
description: Compatibility alias for kanban-manager-heartbeat, used by existing scheduled prompts and saved references to the former skill name.
---

# Kanban Manager Continuation Compatibility Alias

This skill has been renamed to [kanban-manager-heartbeat](../kanban-manager-heartbeat/SKILL.md). Read that skill and follow its current instructions, including its authorization boundaries and idle Beta shutdown rules; this alias does not run a separate manager.

When the caller loads skills from `git-malu/AnyWear` on `main`, load the canonical skill from the same source rather than falling back to a stale local checkout:

```powershell
gh api 'repos/git-malu/AnyWear/contents/.agents/skills/kanban-manager-heartbeat/SKILL.md?ref=main' -H 'Accept: application/vnd.github.raw+json'
```

If the canonical skill cannot be read, preserve the scene and report the concrete blocker.
