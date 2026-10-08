# Public evidence contract sources

These files are exact copies of public Infra/Service artifact interfaces. E2E
uses them to validate release selection and deployment evidence without importing
Service application implementation. Relative imports preserve the producer's
dependency layout.

The accepted target contract is [ADR 0021 at Meta
a8eba148cfef4c124c46010276e66e4c8c41e420](https://github.com/git-malu/AnyWear-Meta/blob/a8eba148cfef4c124c46010276e66e4c8c41e420/architecture/ADR/0021-shared-infrastructure-repository.md).
These files are copied from the reviewed #54 Infra source at immutable
revision [`72db6d00201ffbefcd37b8e4f77b4a2d105414b2`](https://github.com/git-malu/AnyWear-Infra/commit/72db6d00201ffbefcd37b8e4f77b4a2d105414b2),
published in [Infra PR #3](https://github.com/git-malu/AnyWear-Infra/pull/3).
All six committed files match that exact producer revision. The five unchanged
contract files retain the original source bytes from Infra `1616783bf604c6c837f32452f039019fc5dd65f5`;
only the native parser is refreshed. Hashes below identify committed producer
bytes; checkout line-ending conversion is not a new contract revision.
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
| `vendor/service-release-attestation.mjs` | `scripts/vendor/service-release-attestation.mjs` | `c02c1691ad12203b6d2bd55bbaf58b25feead3ad2bd76ed8240c3c7369d38c65` |

The two Service helpers are byte-identical to
`.github/scripts/{service-artifact-contract,service-release-attestation}.mjs` at
immutable Service source
[`6a0551b3ea83937d3ac350ee78608784bc2d9dc6`](https://github.com/git-malu/AnyWear-Service/commit/6a0551b3ea83937d3ac350ee78608784bc2d9dc6),
delivered in [Service PR #53](https://github.com/git-malu/AnyWear-Service/pull/53).
The original helpers came from `8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce`;
source `75c65b22a434129ea84749caa8c9e20bb6119843` retained those historical
helper bytes while changing publisher workflow permissions and offline CLI probes.
The current native parser adds strict v0.2 support while preserving exact v0.1.
Native release verification compares the successful GitHub CLI JSON against the
complete signed Service owner/repository/release/tag/commit/asset set. The
publication receipt retains the exact original successful publisher artifact
record and review URL; it does not depend on that artifact remaining available.

The genuine fixture [`../fixtures/github-native-release-verification-v0.2.json`](../fixtures/github-native-release-verification-v0.2.json)
is copied byte-for-byte from Infra `72db6d00201ffbefcd37b8e4f77b4a2d105414b2` path
`test/fixtures/github-native-release-verification-v0.2.json`, which in turn copies
Service `6a0551b3ea83937d3ac350ee78608784bc2d9dc6` path
`.github/fixtures/github-native-release-verification-v0.2.json`. Its 5,681 raw bytes
have SHA-256 `cf0bf9a5550ec9b475cb9b1fea68b793a39a2e640431deb69f075254d23ab0e2`.
[Producer fixture provenance](https://github.com/git-malu/AnyWear-Infra/blob/72db6d00201ffbefcd37b8e4f77b4a2d105414b2/test/fixtures/native-release-source.md)
records original CLI stdout/version, signed payload and complete subjects. This
fixture came from failed publisher `37757528038/1`, release `406660922` with no
publication artifact. That release remains UNSELECTABLE; parser acceptance or
synthetic policy tests do not qualify its cryptography, publication or deployment.
The original v0.1 fixture remains preserved in the producer's fixture set.

Runtime observation separately checks out and executes the exact full Infra SHA
selected in compatibility v2. A vendored validator never substitutes for that
authenticated, compatibility-pinned observer or the completed trusted producer.

## Released source inputs

The coordinated #54 source inputs accepted for later consumption are:

| Repository | Immutable source revision |
| --- | --- |
| Client | `04d931ddd81545731b314d310a26df08cbc89473` |
| Service | `6a0551b3ea83937d3ac350ee78608784bc2d9dc6` |
| Infra | `72db6d00201ffbefcd37b8e4f77b4a2d105414b2` |

These revisions describe source delivery. Compatibility v1 retains its existing
Client and Service runtime pins; a deployed v2 tuple requires separate producer
publication, deployment evidence, and qualification acceptance.

## Offline source acceptance

The actual locked Service builder output from source
`8dfb61b1ff4f671eed27d3a7cb8d315bed3d68ce` is consumed again with clean Infra
source `1616783bf604c6c837f32452f039019fc5dd65f5`. The complete manifest has
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
`2e45b0e661ce9239ff50318754e0ab0465919213d0b1111951ed81e3cc5ec409`.
The original builder output and the new report are retained outside the removable
workspace. The manifest still identifies its actual `8dfb61b` builder source;
this revalidation does not relabel it as an artifact produced at `75c65b2`.
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
