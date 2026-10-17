import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { byteHash, parseStrictJson, payloadDigest } from './evidence-contract.mjs';
import { assertSchemaCompatibility, validateManifest, verifyAssetBytes } from './vendor/vendor/service-artifact-contract.mjs';
import { assertSelectionManifest } from './vendor/artifact-consumer.mjs';
import { qualificationFixture } from './fixtures/infra-qualification.mjs';
import { buildQualificationRecord, verifyQualificationRecord } from './qualification-record.mjs';

// This checks actual builder bytes against public contracts. All release IDs,
// deployment observations and run identities below are explicitly offline mocks.
// It never publishes artifacts, calls cloud APIs or qualifies a deployment.
export async function verifyArtifactBuilderFixture(artifactDirectory, infraDirectory, outputDirectory) {
  const manifestBytes = await readFile(resolve(artifactDirectory, 'service-artifacts.json'));
  const manifest = validateManifest(parseStrictJson(manifestBytes));
  if (manifest.kind !== 'source-build') throw new Error('Real locked source-builder output required');
  const assets = {};
  for (const component of [...Object.values(manifest.components.lambdas), manifest.components.runtime_policy, manifest.components.schema]) {
    assets[component.file] = await readFile(resolve(artifactDirectory, component.file));
  }
  const { schema } = verifyAssetBytes(manifest, assets);
  for (const filename of Object.keys(assets)) {
    const tampered = { ...assets, [filename]: Buffer.concat([assets[filename], Buffer.from('tampered')]) };
    const missing = { ...assets }; delete missing[filename];
    for (const invalid of [tampered, missing]) {
      let rejected = false;
      try { verifyAssetBytes(manifest, invalid); } catch { rejected = true; }
      if (!rejected) throw new Error(`Altered/missing actual builder asset was accepted: ${filename}`);
    }
  }
  const fixture = qualificationFixture();
  const { deployment, compatibility } = fixture;
  const source = manifest.components.image.service_sha;
  const infraSha = execFileSync('git', ['-C', infraDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const components = structuredClone(manifest.components);
  Object.values(components.lambdas).forEach((component, index) => { component.asset_id = 20 + index; });
  components.runtime_policy.asset_id = 22; components.schema.asset_id = 23;
  const release = { ...deployment.selection.release, manifest_sha256: byteHash(manifestBytes) };
  const selector = { schema_version: 2, record_type: 'anywear_infra_selection', release, ...components };
  assertSelectionManifest(selector, manifest);

  await mkdir(outputDirectory, { recursive: true });
  const selectorPath = resolve(outputDirectory, 'offline-selection.json');
  await writeFile(selectorPath, `${JSON.stringify(selector, null, 2)}\n`);
  // Execute the Infra consumer's public validators in its own source checkout.
  // No Service route, database or other implementation modules are imported.
  execFileSync(process.execPath, ['--input-type=module', '-e', [
    "import {readFileSync} from 'node:fs'; import {resolve} from 'node:path'; import {pathToFileURL} from 'node:url';",
    'const [infra, artifacts, selection] = process.argv.slice(1);',
    "const consumer = await import(pathToFileURL(resolve(infra, 'scripts/artifact-consumer.mjs')));",
    "const contract = await import(pathToFileURL(resolve(infra, 'scripts/vendor/service-artifact-contract.mjs')));",
    "const manifest = contract.validateManifest(contract.parseStrictJson(readFileSync(resolve(artifacts, 'service-artifacts.json'))));",
    'consumer.assertSelectionManifest(contract.parseStrictJson(readFileSync(selection)), manifest);',
    'const assets = Object.fromEntries([...Object.values(manifest.components.lambdas), manifest.components.runtime_policy, manifest.components.schema].map(c => [c.file, readFileSync(resolve(artifacts, c.file))]));',
    'contract.verifyAssetBytes(manifest, assets);',
    "for (const filename of Object.keys(assets)) { const missing={...assets};delete missing[filename]; const tampered={...assets,[filename]:Buffer.concat([assets[filename],Buffer.from('tampered')])}; for (const invalid of [missing,tampered]) { let rejected=false;try{contract.verifyAssetBytes(manifest,invalid)}catch{rejected=true}if(!rejected)throw new Error('Altered actual builder asset accepted'); } }",
  ].join('\n'), infraDirectory, artifactDirectory, selectorPath], { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

  compatibility.service.sha = source; compatibility.infra.sha = infraSha;
  compatibility.service_artifacts.manifest_sha256 = byteHash(manifestBytes);
  deployment.infra.sha = infraSha;
  deployment.selection = { file: 'selections/offline-fixture.json', sha256: payloadDigest(selector), release, components };
  for (const stack of deployment.stacks) stack.source_sha = stack.source_repository === compatibility.infra.repository ? infraSha : source;
  deployment.observed.service_sha = source;
  deployment.observed.image_digest = components.image.digest;
  for (const service of Object.values(deployment.observed.ecs)) service.image_digest = components.image.digest;
  deployment.observed.lambdas['pre-sign-up'].code_sha256 = components.lambdas.pre_sign_up.code_sha256;
  deployment.observed.lambdas['post-confirmation'].code_sha256 = components.lambdas.post_confirmation.code_sha256;
  deployment.observed.policy_content_sha256 = components.runtime_policy.content_sha256;
  const migrations = schema.migrations.map(migration => ({ id: migration.sha256, created_at: migration.created_at }));
  Object.assign(deployment.schema, { selected_journal_sha256: components.schema.journal_sha256,
    observed_applied_journal_sha256: payloadDigest(migrations), selected_migration_ids: migrations,
    applied_migration_ids: structuredClone(migrations), selected_current_version: schema.current_version,
    minimum_schema_version: schema.minimum_version, minimum_migration_count: schema.minimum_migration_count,
    applied_schema_version: schema.current_version });
  Object.assign(deployment.schema.verification, { source_sha: infraSha, service_sha: source, image_digest: components.image.digest });
  deployment.schema.verification.executor.sha = infraSha;
  compatibility.deployment.record_sha256 = byteHash(`${JSON.stringify(deployment, null, 2)}\n`);
  for (const evidence of Object.values(fixture.evidence)) {
    evidence.compatibility = structuredClone(compatibility); evidence.deployment = structuredClone(deployment);
    evidence.service_artifacts = structuredClone(compatibility.service_artifacts);
    evidence.service.source_commit = source; evidence.service.image_digest = components.image.digest;
    const priorVerification = evidence.authenticated.schema.verification;
    evidence.authenticated = structuredClone({ stacks: deployment.stacks, observed: deployment.observed, schema: deployment.schema });
    evidence.authenticated.schema.verification.executor = priorVerification.executor;
    evidence.authenticated.schema.verification.task_arn = priorVerification.task_arn;
  }
  const record = buildQualificationRecord(fixture.input, compatibility, fixture.evidence, new Date('2026-10-08T00:20:00Z'), fixture.environment, fixture.report);
  verifyQualificationRecord(record);
  // Exercise forward compatibility using the actual complete SQL-hash prefix.
  // The appended migration/current version are explicitly hypothetical inputs.
  const futureMigration = { id: byteHash('offline hypothetical next migration'), created_at: migrations.at(-1).created_at + 1 };
  const next = [...migrations, futureMigration];
  assertSchemaCompatibility(migrations, next, schema.current_version + 1, schema.minimum_version, schema.minimum_migration_count);
  assertSchemaCompatibility(next, migrations, schema.current_version, schema.minimum_version, schema.minimum_migration_count);
  const drifted = structuredClone(migrations); drifted[0].id = byteHash('offline conflicting migration');
  let driftRejected = false;
  try { assertSchemaCompatibility(migrations, drifted, schema.current_version, schema.minimum_version, schema.minimum_migration_count); }
  catch { driftRejected = true; }
  if (!driftRejected) throw new Error('Actual migration prefix drift was accepted');
  // Run the same edge cases in Infra's public contract, using original asset bytes.
  execFileSync(process.execPath, ['--input-type=module', '-e', [
    "import {readFileSync} from 'node:fs'; import {resolve} from 'node:path'; import {pathToFileURL} from 'node:url';",
    'const [infra, artifacts] = process.argv.slice(1);',
    "const contract = await import(pathToFileURL(resolve(infra, 'scripts/vendor/service-artifact-contract.mjs')));",
    "const s = contract.validateSchemaAsset(contract.parseStrictJson(readFileSync(resolve(artifacts, 'service-schema.json'))));",
    'const selected = s.migrations.map(m => ({id:m.sha256, created_at:m.created_at}));',
    "const future = [...selected, {id:contract.sha256('offline hypothetical next migration'), created_at:selected.at(-1).created_at+1}];",
    'contract.assertSchemaCompatibility(selected,future,s.current_version+1,s.minimum_version,s.minimum_migration_count);',
    'contract.assertSchemaCompatibility(future,selected,s.current_version,s.minimum_version,s.minimum_migration_count);',
  ].join('\n'), infraDirectory, artifactDirectory], { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const report = { schema_version: 1, record_type: 'anywear_offline_builder_contract_check',
    result: 'passed', service_sha: source, infra_head: infraSha,
    infra_worktree_clean: execFileSync('git', ['-C', infraDirectory, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim() === '',
    infra_contract_sha256: Object.fromEntries(await Promise.all(['json-contract.mjs', 'deployment-contract.mjs', 'artifact-consumer.mjs',
      'vendor/service-artifact-contract.mjs', 'vendor/service-release-attestation.mjs']
      .map(async file => [file, byteHash(await readFile(resolve(infraDirectory, 'scripts', file)))]))),
    manifest_sha256: byteHash(manifestBytes), asset_sha256: Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, byteHash(bytes)])),
    minimum_migration_count: schema.minimum_migration_count, migration_count: migrations.length,
    hypothetical_schema_edges: { current_image_next_database: 'passed', next_image_current_database: 'passed', prefix_drift: 'rejected' },
    asset_integrity_cases: { tampered_assets_rejected: Object.keys(assets).length, missing_assets_rejected: Object.keys(assets).length },
    publication_verified: false, deployment_qualified: false };
  await writeFile(resolve(outputDirectory, 'offline-contract-result.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [artifacts, infra, output] = process.argv.slice(2);
  if (!artifacts || !infra) throw new Error('Usage: node scripts/verify-artifact-builder-fixture.mjs <actual-builder-output> <Infra-checkout> [output-directory]');
  console.log(JSON.stringify(await verifyArtifactBuilderFixture(resolve(artifacts), resolve(infra), resolve(output ?? '.qualification-inputs/builder-fixture')), null, 2));
}
