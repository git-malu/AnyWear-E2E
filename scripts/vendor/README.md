# Public evidence contract sources

These files are exact copies of public Infra/Service artifact interfaces. E2E
uses them to validate release selection and deployment evidence without importing
Service application implementation. Relative imports preserve the producer's
dependency layout.

The accepted target contract is [ADR 0021 at Meta
a8eba148cfef4c124c46010276e66e4c8c41e420](https://github.com/git-malu/AnyWear-Meta/blob/a8eba148cfef4c124c46010276e66e4c8c41e420/architecture/ADR/0021-shared-infrastructure-repository.md).
These files are copied from the coordinated #54 Infra source at immutable
revision [`0c514d52f68726cda140200b2ecb2a4c504c635e`](https://github.com/git-malu/AnyWear-Infra/commit/0c514d52f68726cda140200b2ecb2a4c504c635e).
The byte hashes identify this exact source snapshot; they do not release the
runtime activation gate. The manager must still review the resulting deployment
tuple and writer window before any runtime execution.

| E2E file | Producer path in Infra | SHA-256 of copied bytes |
| --- | --- | --- |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `107c0691b8d7f918c386351b984b741f5f164cdb0b4d6f7d932f18fb38a1ff19` |
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
