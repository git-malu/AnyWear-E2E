# Public evidence contract sources

These files are exact copies of public Infra/Service interfaces. E2E consumes public contracts without importing Service application implementation. Relative imports preserve the producer dependency layout. The source record is this README.

## Direct selection source

The staged source integration consumes immutable [Infra `5815bfb39010d356bde44c070c53d9aceccb9504`](https://github.com/git-malu/AnyWear-Infra/commit/5815bfb39010d356bde44c070c53d9aceccb9504) under the [owner source allocation](https://github.com/git-malu/AnyWear/issues/54#issuecomment-6060314076). Final producer/consumer source acceptance requires checked and independently reviewed intended revisions. Source availability does not select a runtime compatibility tuple or authorize live qualification.

All five contract files match the exact Infra source bytes:

| E2E file | Producer path in Infra | Raw SHA-256 |
| --- | --- | --- |
| `deployment-contract.mjs` | `scripts/deployment-contract.mjs` | `933d04088f1b65a58718657299028610ab1cc28e208ca8544e49ba7f46301df8` |
| `json-contract.mjs` | `scripts/json-contract.mjs` | `c3a59c0645b352b54b012af2adadfdc98773f79702fb6619beb029e83bf63047` |
| `artifact-consumer.mjs` | `scripts/artifact-consumer.mjs` | `83f4ba2be6325a96178687f24443460c6509c000556d6804acf294620fc0b499` |
| `vendor/service-artifact-contract.mjs` | `scripts/vendor/service-artifact-contract.mjs` | `57fbd454b90fae6de856d05bb612a8c9b5b8d9e130e0521093fee0bf7e9422de` |
| `vendor/service-release-attestation.mjs` | `scripts/vendor/service-release-attestation.mjs` | `c02c1691ad12203b6d2bd55bbaf58b25feead3ad2bd76ed8240c3c7369d38c65` |

Both Service helpers remain byte-identical to authoritative [Service `6a0551b3ea83937d3ac350ee78608784bc2d9dc6`](https://github.com/git-malu/AnyWear-Service/commit/6a0551b3ea83937d3ac350ee78608784bc2d9dc6), paths `.github/scripts/{service-artifact-contract,service-release-attestation}.mjs`. The native parser retains both strict v0.1 and v0.2 predicates, the original signed statement and complete owner/repository/release/tag/target/asset bindings. Receipt-only `publication-acceptance.mjs` is retired from the executable consumer closure. Historical records below retain their original meaning.

The genuine [v0.2 fixture](../fixtures/github-native-release-verification-v0.2.json) remains unchanged, copied from Infra path `test/fixtures/github-native-release-verification-v0.2.json`, which retains Service's exact 5,681 bytes with raw SHA-256 `cf0bf9a5550ec9b475cb9b1fea68b793a39a2e640431deb69f075254d23ab0e2`. Failed publisher `37757528038/1`, release `406660922` remains UNSELECTABLE. The fixture and synthetic policy tests prove no successful cryptographic verification or deployment. Legacy v0.1 producer fixtures are preserved.

## Runtime trust boundary

Selector, deployment and operation runtime records use Infra schema v2. Historical receipt-bearing v1 records are rejected as runtime inputs, never converted into a new accepted record. The actual selection must be a regular tracked canonical `selections/*.json` blob, bound to its raw SHA-256 and the explicit full `compatibility.infra.sha`. The reviewed origin, root, commit, clean tracked/untracked state, replacement refs and hidden index flags are checked by the pinned loader before and after verification.

E2E executes the separately checked-out, compatibility-pinned Infra consumer with `--selection <repository-relative file> --selection-sha256 <raw hash> --trusted-infra-root <absolute checkout> --infra-sha <full compatibility pin> --output-dir <external output>`. It loads the committed selector and compares its complete release/components against the deployment record. A temporary reconstructed JSON object is a comparison value only. The vendored validator is not the runtime trust source.

Direct verification retains the completed-success publisher/main/workflow/run/attempt/head-owner identities, immutable release/tag/source/manifest, API asset IDs/names/sizes/digests, native release verification and all five asset verifications, original native statement equality and full component/schema hashes. Service reads use only the Service App reader. Runtime no longer depends on the Actions publication ZIP, candidate, receipt or Issue approval record. The observer uses the same actual committed selection file/hash, with its expected deployment record as a comparison value.

Compatibility v1 and its existing Client/Service pins remain unchanged in this source delivery. The later deployed v2 tuple and observed system qualification require separate acceptance. #87 retains 8 core / 16 tool / 2 deferred SQS files and its existing workflow/package taxonomy.

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
