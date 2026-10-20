export interface SizingFixture {
  id: string; file: string; mime: string; size_class: string;
  bytes: number; width: number; height: number; sha256: string; data: Buffer;
  encoding?: Record<string, unknown>; s1_bytes?: number; derivation?: string;
  source?: string; source_sha256?: string;
}
export interface SizingDiagnosticFixture {
  case_id: string; file: string; mime: string; bytes: number; sha256: string;
  expected_failure_code: string; qualifying: false; data: Buffer;
  source?: string; source_sha256?: string; derivation?: string;
}
export interface SizingFixtureSet {
  fixtures: Map<string, SizingFixture>; manifestSha256: string; envelopeSha256: string;
  envelopeMode: string; diagnostic: SizingDiagnosticFixture;
}
export interface UploadCase { case_id: string; fixture: string; submission: string; size_class: string }
export interface VtoCase {
  case_id: string; shape: string; base_fixture: string; garment_count: number;
  garment_fixtures: string[]; advanced_settings?: { size: string };
}
export const SIZING_PROVIDER_ENVELOPE: Record<string, unknown>;
export const S1_INPUT_BYTES_MAX: number;
export const S1_INPUT_ENVELOPE: Record<string, unknown>;
export const S1_INPUT_EXCLUDED_FIXTURES: { id: string; bytes: number; sha256: string; reason: string }[];
export const S1_VTO_GARMENT_POOL: readonly string[];
export const VTO_GARMENT_FORMATS: readonly string[];
export const S1_DEFERRED_VTO_SHAPE: Record<string, unknown>;
export const S1_VTO_SHAPE_NAMING: string;
export const SIZING_VTO_AGGREGATE_LIMIT: string;
export interface SizingVtoGarmentPlan {
  schema_version: number;
  issue: number;
  pool: string[];
  submitted_fixtures: string[];
  fixture_case_ids: Record<string, string[]>;
  item_resource_id: Map<string, string>;
  resolveGarmentId(caseId: string, fixture: string): string;
}
export function hashBytes(bytes: string | Buffer): string;
export function loadSizingFixtures(
  directory: URL, mode?: string,
): Promise<SizingFixtureSet>;
export function sizingUploadCases(mode?: string): UploadCase[];
export function sizingVtoCases(): VtoCase[];
export function assertVtoGarmentPoolIsSubmitted(
  fixtures?: Map<string, { mime?: string }>, mode?: string,
): readonly string[];
export function sequentialGarmentUploads(fixtures?: Map<string, { mime?: string }>, mode?: string): string[];
export function sizingVtoGarmentUploadCases(mode?: string): UploadCase[];
export function createSizingVtoGarmentPlan(mode?: string): SizingVtoGarmentPlan;
export function assertVtoCasesResolvableInPlan(
  plan: SizingVtoGarmentPlan, options?: { requireResolved?: boolean },
): SizingVtoGarmentPlan;
export function orderedSizingGarments(
  fixtures: Map<string, SizingFixture>, count: number,
): { id: string; bytes: number }[];
export function vtoAggregateSubmittedBytes(
  fixtures: Map<string, SizingFixture>, baseFixture: string, garmentIds: readonly string[],
): number;
