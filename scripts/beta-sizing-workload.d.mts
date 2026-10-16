export interface SizingFixture {
  id: string; file: string; mime: string; size_class: string;
  bytes: number; width: number; height: number; sha256: string; data: Buffer;
  encoding?: Record<string, unknown>; s1_bytes?: number; derivation?: string;
  source?: string; source_sha256?: string;
}
export interface UploadCase { case_id: string; fixture: string; submission: string; size_class: string }
export interface VtoCase {
  case_id: string; shape: string; base_fixture: string; garment_count: number;
  garment_fixtures: string[]; advanced_settings?: { size: string };
}
export const SIZING_PROVIDER_ENVELOPE: Record<string, unknown>;
export const S1_INPUT_BYTES_MAX: number;
export const S1_INPUT_ENVELOPE: Record<string, unknown>;
export const S1_INPUT_EXCLUDED_FIXTURES: { id: string; bytes: number; sha256: string }[];
export const S1_VTO_GARMENT_POOL: readonly string[];
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
export function loadSizingFixtures(directory: URL): Promise<{ fixtures: Map<string, SizingFixture>; manifestSha256: string; envelopeSha256: string }>;
export function sizingUploadCases(): UploadCase[];
export function sizingVtoCases(): VtoCase[];
export function assertVtoGarmentPoolIsSubmitted(): readonly string[];
export function sizingVtoGarmentUploadCases(): UploadCase[];
export function createSizingVtoGarmentPlan(): SizingVtoGarmentPlan;
export function assertVtoCasesResolvableInPlan(
  plan: SizingVtoGarmentPlan, options?: { requireResolved?: boolean },
): SizingVtoGarmentPlan;
export function orderedSizingGarments(
  fixtures: Map<string, SizingFixture>, count: number,
): { id: string; bytes: number }[];
export function vtoAggregateSubmittedBytes(
  fixtures: Map<string, SizingFixture>, baseFixture: string, garmentIds: readonly string[],
): number;
