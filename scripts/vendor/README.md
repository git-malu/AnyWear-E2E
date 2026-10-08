# Public evidence contract sources

These files are exact copies of public Infra/Service artifact interfaces. E2E
uses them to validate release selection and deployment evidence without importing
Service application implementation. Relative imports preserve the producer's
dependency layout.

The accepted target contract is [ADR 0021 at Meta
a8eba148cfef4c124c46010276e66e4c8c41e420](https://github.com/git-malu/AnyWear-Meta/blob/a8eba148cfef4c124c46010276e66e4c8c41e420/architecture/ADR/0021-shared-infrastructure-repository.md).
These files are copied from the coordinated #54 Infra source at immutable
revision [`88679b61630bc2344258cafb0d35b4d0b02e3a0d`](https://github.com/git-malu/AnyWear-Infra/commit/88679b61630bc2344258cafb0d35b4d0b02e3a0d),
published in [Infra PR #1](https://github.com/git-malu/AnyWear-Infra/pull/1).
All six committed files are byte-identical to the prior reviewed Infra revision
`0c514d52f68726cda140200b2ecb2a4c504c635e` and to the E2E Git blobs. Hashes below
identify committed producer bytes; checkout line-ending conversion is not a new
contract revision.
The byte hashes identify this exact source snapshot; they do not release the
runtime activation gate. The manager must still review the resulting deployment
tuple and writer window before any runtime execution.

| E2E file | Producer path in Infra | SHA-256 of copied bytes |
| --- | --- | --- |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `87d0530cb4cc63608f96113b5c20af073e67af74c044f1ffa1c9f83d1fb434bd` |
| `json-contract.mjs` | `scripts/json-contract.mjs` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` |
| `artifact-consumer.mjs` | `scripts/artifact-consumer.mjs` | `6aa2391cfa54d3e77a98385fbbd321b4c4d452814adc07a8c3727d11c49c6b7d` |
| `publication-acceptance.mjs` | `scripts/publication-acceptance.mjs` | `e531a7b61679ef593ef28dc0d6a2926ea3cb8c52f4f88ff3f5f0fd9ccfd737dc` |
| `vendor/service-artifact-contract.mjs` | `scripts/vendor/service-artifact-contract.mjs` | `57fbd454b90fae6de856d05bb612a8c9b5b8d9e130e0521093fee0bf7e9422de` |
| `vendor/service-release-attestation.mjs` | `scripts/vendor/service-release-attestation.mjs` | `cd8235e75ace18eb40728e61bea99d2bc149ba1d44963683df9729035b30e02f` |

The two Service helpers are byte-identical to
`.github/scripts/{service-artifact-contract,service-release-attestation}.mjs` at
immutable Service source
[`8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce`](https://github.com/git-malu/AnyWear-Service/commit/8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce),
delivered for source review in [Service PR #50](https://github.com/git-malu/AnyWear-Service/pull/50).
Native release verification compares the successful GitHub CLI JSON against the
complete signed Service owner/repository/release/tag/commit/asset set. The
publication receipt retains the exact original successful publisher artifact
record and review URL; it does not depend on that artifact remaining available.

Runtime observation separately checks out and executes the exact full Infra SHA
selected in compatibility v2. A vendored validator never substitutes for that
authenticated, compatibility-pinned observer or the completed trusted producer.

## Offline source acceptance

The actual locked Service builder output from source
`8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce` is consumed again with clean Infra
source `88679b61630bc2344258cafb0d35b4d0b02e3a0d`. The complete manifest has
raw SHA-256 `beed1d70d328193de6a616e3b492e22ed64bee4cd2dcc049218d5d515b0be878`.
The acceptance command is
`node scripts/verify-artifact-builder-fixture.mjs <actual-builder-output> <Infra-checkout>`;
the original output directory is retained by the issue owner outside the removable
workspace. Its report records the exact Infra HEAD, checkout cleanliness, contract
file bytes and original asset hashes. All four asset tamper cases and all four
missing-asset cases are rejected. The real schema version is 16, with 18 SQL
migration hashes and a minimum migration count of 18. Hypothetical next-version
prefix checks pass in both directions, and a conflicting SQL hash is rejected.
The final `offline-contract-result.json` has raw SHA-256
`d3b8b9c2fe21d1244e668c18a1a1af8e784a0c8359cee5a1fb7b30c4465f6223`.
Its deployment-contract checkout hash is
`107c0691b8d7f918c386351b984b741f5f164cdb0b4d6f7d932f18fb38a1ff19`
because that Infra working copy uses CRLF; the committed LF hash is the
`87d0530...` value above, verified against both repositories' Git blobs.

This source acceptance retains `publication_verified:false` and
`deployment_qualified:false`. Run IDs, image digest, release identity and runtime
observations in this fixture are offline inputs. The new App preflight and live
Foundation external-role ownership changes at the Infra revision are reviewed
separately; this public-contract check does not establish App access, Foundation
rollout safety, a publication receipt or a deployed suite result. Compatibility v1
and its existing Client/Service pins remain unchanged.
