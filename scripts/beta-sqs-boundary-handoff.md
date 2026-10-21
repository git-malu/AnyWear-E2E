# Beta SQS Boundary Consumer: Source Only

Wire producer: Service PR [#42](https://github.com/git-malu/AnyWear-Service/pull/42),
immutable source `80bb9deebec57e6c302439c2a6030c1744ef7a9e`.
This prospective producer remains unmerged. Since AnyWear #180 the qualification path
reads the live deployed tuple and does not read the retained compatibility pin; this module
does not claim that Beta runs the prospective wire contract.

`beta-sqs-boundary-protocol.mjs` independently consumes a strict supported Beta subset
of the producer schema, sorted-key JSON bytes, SHA256 intent/document hashes and Ed25519
signing bytes; exhaustive schema equivalence is not claimed. Its fail-closed consumer
restrictions include immutable Beta account/region/auto-tagging ARN, same original
attestation throughout the chain, safe integer sequences, canonical 64-byte signatures,
plain bounded JSON and a worker ARN in the Beta account/region. Canonical document
bytes/signatures are verified; `proofDigest` and `task-listener-credential` are schema
and correlation fields, not real STS/SigV4 authentication or proof of receipt origin.
An ACK with refreshed attestation timestamps/proof is currently refused and requires
separate producer/consumer review, not an automatic relaxation of the exact-proof chain.

`createBetaSqsBoundaryConsumer` cannot construct a live signer because the immutable
source trust root is absent. Neither environment values nor caller-supplied keys can
configure that root. No key is provisioned, generated, loaded or written by the modules.

`createSourceOnlyBoundarySession` is an explicitly offline wire-contract fixture.
It accepts only in-memory Ed25519 KeyObjects and a clock, with no transport callback,
AWS SDK, CLI, secret loader, persistent store or executor dependency. It signs ARM and
FIRE only; ACK must verify against a different fixture listener key and key ID. Fixtures
do not establish reviewed live trust. The module releases its private-key reference on
close, absolute expiry, clock regression or the first FIRE. It cannot zeroize KeyObject
memory or remove references retained by its caller. Signer restoration APIs always refuse.
Response loss or closure during FIRE remains unknown and cannot be reclassified as a
successful recovery. FIRE emission/outcomes in these tests are local protocol fixtures,
not a durable intent or an upstream SQS mutation. No persistent cross-process replay
protection is claimed by this offline session.

## Held Gates

- Reviewed immutable public trust root and memory-only live signer provisioning.
- Real worker task/listener STS and SigV4 attestation, legitimate first-worker receipt
  provenance, fixed upstream routing, fresh SELECT-only owned processing audit and
  real task/owner/token/lease correlation. E2E never obtains an observer main-queue receipt.
- Authenticated private control namespace and IAM denial of worker/API control writes
  and deletes, reviewed durable conditional-create/readback ARM/ACK/FIRE and upstream
  pending/outcome records, response-loss reconciliation and restart disarm.
- Independently approved two-worker layout/scaling and durable recovery; current
  desired counts, credentials, adapters, workflows and readiness flags are untouched.
- Prewarmed bounded read-only audit timing for the actual +30-second F5 renewal and
  separately reviewed short-visibility bound. Missing the deadline must refuse.
- Protected exclusive Beta window, known terminal/stopped proof before cleanup or
  paid-baseline restoration, and actual F2/F5 evidence. Neither case is live-passing;
  controlled shortening is not natural visibility expiry or F4 DB ownership loss.

Source checks: `node --test scripts/beta-sqs-boundary-*.test.mjs` and `pnpm check`.
These run script regressions and test discovery only, not cloud or browser E2E.
