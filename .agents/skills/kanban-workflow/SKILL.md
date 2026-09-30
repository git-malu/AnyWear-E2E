---
name: kanban-workflow
description: Follow the AnyWear Kanban workflow for delivery, stage gates, closure, and subagent coordination.
---

- Use the Kanban board as the source of truth; keep issue status, Kanban, and roadmap synchronized.
- **Control Loop:** Every main-agent or subagent-owned work item follows `define → execute → observe → adjust → verify`, repeating until its acceptance criteria and stage gate pass.
- The main agent owns the high-level loop across the workflow; each subagent owns a low-level loop within its assigned scope. Feedback flows upward and back into planning, while stage transitions remain synchronous.
- **Backlog:** Define scope, acceptance criteria, dependencies, and ownership.
- **Analysis:** Confirm architecture, API contracts, risks, and implementation boundaries.
- **Development:** Implement the approved design. After the Service produces and the Client consumes the aligned API contract, Client and Service work may run in parallel with separate subagents.
- **Testing:** Run development-only Unit Tests and Integration Tests; do not run E2E here. Independent Client and Service test suites may run in parallel when their inputs are ready.
- **Deployment:** Release to Dev/Beta/Production and run E2E qualification during release, starting in Beta and continuing through Production; parallelize independent environment checks, but keep promotion gates synchronous.
- **Pending Closure:** Update architecture docs, issue status and acceptance records, Kanban/roadmap views, links, and evidence; verify every dependent work item is complete. If any dependency is incomplete, keep the current item open and do not advance it to Completed. A subagent may own the reconciliation checklist.
- **Completed:** Mark complete and archive only after all closure work is verified.
- **Escalation:** Record the blocker and `escalated-from`; resume at the recorded stage after intervention.
- Treat stage transitions as synchronous gates; parallelize only independent work within a stage.
- Use subagents for stage ownership where useful; the main agent integrates results and verifies each stage gate before advancing.
