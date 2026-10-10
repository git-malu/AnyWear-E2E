# Protected cleanup acceptance

Issue #86 uses `beta-cleanup-acceptance.yml` to qualify the real immutable Service
cleanup capability and external Cognito boundary. This is separate from full
Client/Service release qualification. The Kanban manager reviews the exact source
and runtime tuple, supplies immutable artifact origins, controls every Infra
fixture dispatch, and records the environment writer window. Source publication
does not authorize runtime execution or Beta lifecycle changes.

The workflow has five phase names and six bounded runs. The two refusal runs
permit independent manager inspection after each negative operation. Slots 2 and
3 have fixed budgets of two active, two newly created, and two quarantined
accounts. Slots 0 and 1 and all #95 recovery evidence remain outside this scope.

| E2E run | Inputs and required manager evidence | Result |
| --- | --- | --- |
| `bootstrap` | No imported origins; exact `frozen_tuple` | Fresh absent slots, uploaded/read-back creation intent, SUPPRESS AdminCreateUser with bootstrap attribute, captured immutable username/sub, identities retained |
| `refusals` (active) | Bootstrap origin; null previous origin; fixture `prepare`, `inspect` | Exact primary active-task request fails under the real capability, both tasks stopped, cleanup exits nonzero, no committed marker; identities retained |
| `refusals` (mismatch) | Bootstrap and active-refusal origins; fresh fixture `inspect` after active run completion | Both original snapshots unchanged; exact captured primary subject/sentinel email request fails; ordered refusal proofs retained |
| `qualification` | Bootstrap and combined-refusal origins; fresh `inspect` after mismatch run completion, then `release-task` | Exact failed-task cessation verified; retry1 intent uploaded/read back before StartExecution; authenticated ARN/start time persisted; result tracking deliberately stops |
| `recovery` | Bootstrap and qualification origins; no fixture action | Original submitted execution/history observed before any start; same retry1 recovers, full ECS and Service committed proof passes, completed execution replays with unchanged ARN/start/stop/task/result identities; both Cognito identities retained |
| `teardown` | Bootstrap and recovery origins; fresh fixture `inspect` after recovery completes | Primary absent, sentinel unchanged; separate exact sentinel request cleans application rows; only then captured Cognito usernames are deleted and absence read back |

After teardown the manager performs final fixture inspection and reconciliation.
Fixture reconciliation cannot replace a passing application cleanup result.
Inspection with both fixture users absent belongs only to final reconciliation.
Neither a cleanup counter nor a generic exception proves a negative case: the
harness requires the exact immutable execution, complete history, stopped task
and log proof, followed by authenticated unchanged database snapshots. It reports
observed refusal without claiming a structured Service refusal reason code.

Every origin is exact JSON with `repository`, `workflow_path`, `source_sha`,
numeric `run_id`, `run_attempt`, `artifact_id`, and raw lowercase hexadecimal
`artifact_sha256` and `manifest_sha256`. The archive hash must match GitHub's
`sha256:<hash>` digest and downloaded ZIP bytes; the manifest hash covers its raw
file bytes. Imported runs must be completed-success main dispatches with exact
repository/head repository numeric owner identities. Own pre-mutation intent
uploads require the current in-progress run with null conclusion. The reader
checks metadata before and after bounded regular-file ZIP reads. Artifact names
and allowed file names are fixed; legacy lifecycle artifacts and latest/name-only
selection grant no authority.

Fixture records carry the producer-verified raw stack-source file hash, all four
explicit stack producers, the actual single-task launch response and the stopped
task's exact definition, image and action/request override proof. The consumer
does not reconstruct a raw file hash from parsed source rows. Each manager fixture
action starts after the previous relevant run completes.

Bootstrap captures the fixture request string and separate primary, mismatch,
and sentinel application request strings once. Later phases preserve their bytes,
request hashes, lease reservations, original run scope, E2E source, Service image,
state-machine version, fixture definition, and producer selection hashes. A
changed tuple or missing, partial, expired, unavailable, or changed proof stops
the route and preserves evidence for the manager. Creation never reuses an
existing identity, confirms an account, sets a password, authenticates, or calls
an application HTTP route. Automatic finally deletion is forbidden.
Teardown reads and deletes each captured immutable Cognito username, validates its
captured email and subject before deletion, and proves that exact username absent
before marking the account deleted. Missing or changed email aliases cannot prove
the immutable identity's absence.

The qualification interruption is deliberate cessation of result tracking after
an authenticated submission. It does not claim an abrupt operating-system or
runner kill. An ambiguous submission remains a failed checkpoint requiring the
manager's recovery decision. Each phase uploads pending and completed evidence;
failure never grants the next phase authority.

The E2E principal retains contents/Actions-read and OIDC permissions, identity
operations, the fixed cleanup Step Functions capability, and read-only task/log
observations. It receives no Actions-write cleanup token, ECS writer, PassRole,
task-definition registration, fixture dispatch, or Beta lifecycle control.
Runtime remains separately gated by the manager's #104 finalizer review and
confirmed lifecycle gate state. `compatibility.json` is unchanged.
