# AnyWear Kanban Compatibility CLI

GitHub Issues in [git-malu/AnyWear](https://github.com/git-malu/AnyWear/issues)
and [Project #4](https://github.com/users/git-malu/projects/4) hold the issue
records and Kanban state. Follow the
[kanban-workflow skill](../../.agents/skills/kanban-workflow/SKILL.md) for intake,
scheduling, delivery gates, and closure.

These compatibility entry points provide a manager intake prompt and a read-only status view.
The intake implementation belongs to the skill's
[scripts/issue_creation.py](../../.agents/skills/kanban-workflow/scripts/issue_creation.py);
`scripts/devops/issue_creation.py` only delegates to it and preserves existing imports.
Creating a prompt does not create an issue or start execution. Give the prompt
to a `kanban_manager` session, which checks the existing board, decides priority,
dependencies and scope, writes the GitHub records, and verifies their Backlog
placement. Execution requires a separate `issue_worker` assignment.

## Commands

Run these commands from the root checkout with Python 3:

```bash
python scripts/devops/devops.py create --title "Dark mode for wardrobe" --type feature --body "Add a user-selectable dark theme."
python scripts/devops/devops.py create --title "Consolidate settings" --type refactor --body-file proposal.md --scope AnyWear-Client
python scripts/devops/devops.py status
```

The `create` command accepts `feature`, `bug`, `refactor`, or `chore`. Use
`--body-file` for multiline proposals; the file must be UTF-8. Proposal values
are encoded as JSON data in the prompt and are never interpolated into a shell
command. Both the skill's script and the legacy `scripts/devops/issue_creation.py`
accept the same arguments directly:

```bash
python .agents/skills/kanban-workflow/scripts/issue_creation.py create --title "Consolidate settings" --type refactor --body-file proposal.md
```

The generated prompt references the skill's intake rules and GitHub operations
rather than embedding a second copy of the workflow.

The `status` command requires an authenticated GitHub CLI with `read:project`
or `project` scope. It reads `gh project item-list` for Project #4 and prints
the count of issues for each native Status value, including `Unset`. Native
`content.type` separates issues from PR evidence and drafts: those item counts
and the complete Project total are shown separately. A PR marked Completed
does not increase the count of completed issues. Authentication,
permission, timeout, malformed response, and incomplete response errors return
a nonzero exit code. It currently requests up to 1,000 items and refuses to
present a partial board as complete. Intake also needs issue write access and
`project` scope to write Project fields and membership.

## Legacy Entry Point

`issue_creation.py create-chain` exits with migration guidance before writing
any files or creating any tasks. Update old callers to use the manager intake
prompt. The Markdown issue writer and Hermes SOLVE/VERIFY chain implementation
have been removed. Hermes profiles and a gateway are no longer prerequisites
for these commands; the GitHub workflow's issue owner controls delivery.
