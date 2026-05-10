# Agents Context & Repository Structure

> **Note:** There are specific agent instruction files for each submodule. Be sure to also reference them when working in their respective directories:
> - `AnyWear-Meta/AGENTS.md`
> - `AnyWear-Client/AGENTS.md`
> - `AnyWear-Service/AGENTS.md`
> 
> 💡 **Tip:** To get a comprehensive big picture of the entire project, please read [`AnyWear-Meta/architecture/overall_architecture.md`](AnyWear-Meta/architecture/overall_architecture.md).

This root directory is a **shell repository** containing three Git submodules. **Do not run build or install commands in the root directory.** All code and package configuration lives in the subdirectories.

1. **Client Repository**: `AnyWear-Client/` (Tauri / React Frontend)
2. **Service Repository**: `AnyWear-Service/` (Node.js / Hono Backend)
3. **Meta Repository**: `AnyWear-Meta/` (Source of truth for documentation and shared TypeScript interfaces)

## Repository Relations

### Submodule Relation
```mermaid
graph TD
    Anywear --> |submodule| AnyWear-Client 
    Anywear --> |submodule| AnyWear-Service
    Anywear --> |submodule| AnyWear-Meta
    AnyWear-Client --> |submodule| api
    AnyWear-Service --> |submodule| api
```

### Dependency Relation
```mermaid
graph TD
    AnyWear-Client --> |depends on| AnyWear-Meta
    AnyWear-Service --> |depends on| AnyWear-Meta 
    AnyWear-Client --> |depends on| api
    api --> |depends on| AnyWear-Service
```

## Standard Workflow

Follow the full development workflow documented in [`AnyWear-Meta/AGENTS.md`](AnyWear-Meta/AGENTS.md#1-standardized-agent-workflows):

## Project Management

- **Kanban Board**: Project progress is tracked in the github project board (kanban board) at [`https://github.com/users/git-malu/projects/4`](https://github.com/users/git-malu/projects/4).
- **Issue Grouping**: Always create a parent issue under `git-malu/AnyWear`, then create sub-issues under `git-malu/AnyWear-Meta`, `git-malu/AnyWear-Client`, and `git-malu/AnyWear-Service` separately as needed.
- **Issue Dependencies**: Use `blocked by` / `blocking` relations to build dependencies between issues. See [GitHub docs on issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies) for details.
- **Permission**: If `gh` commands related to the project board fail with a permission error, run `gh auth refresh -s project` to grant the required project scopes.

## Git & Submodule Operations

- Run `git submodule update --init --recursive` if directories are empty or missing.
- **Git Commits**: Since each directory is an independent Git repository, you must execute `git` operations (add, commit, push) *inside* the specific subdirectory (`AnyWear-Client`, `AnyWear-Service`, or `AnyWear-Meta`). Committing at the root only updates the submodule commit pointers.

## Parallel Sub-Agent Strategy

When a task involves significant changes to **both** the frontend (`AnyWear-Client`) and backend (`AnyWear-Service`) simultaneously, launch two sub-agents in parallel to work on each repository independently. This saves time by overlapping work instead of serial execution.

- Use this strategy for high-workload tasks touching both repositories.
- Each sub-agent should be given a clear, scoped prompt targeting its specific repository.
- After both complete, verify changes in each repository with build/lint/test commands.

> ⚠️ **API Dependency Caution:** Both `AnyWear-Client` and `AnyWear-Service` reference the same remote `api` repo as a submodule, but with a strict producer/consumer relationship: **`AnyWear-Service` generates the API types, and `AnyWear-Client` only consumes them**. The update flow is always *Service generates → Client consumes* — never the reverse. If your task involves modifying these shared API types, make changes in `AnyWear-Service` first (it's the source of truth), and then update `AnyWear-Client`'s submodule pointer to pull in those changes. When using parallel sub-agents, be careful — the two agents may introduce conflicting or inconsistent changes to the same API definitions. In such cases, handle the shared API changes first (or coordinate them explicitly in the prompts), before spinning off the client/service work in parallel.
