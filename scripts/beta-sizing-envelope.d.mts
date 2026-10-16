export interface SizingInputCaseReference {
  case_id: string; fixture: string; bytes: number; width: number; height: number;
  terminal_state: string; seconds?: number;
}
export interface SizingExcludedFixture {
  id: string; bytes: number; width: number; height: number; sha256: string; size_class: string; reason: string;
}
export interface SizingDeferredVtoShape {
  shape: string; garment_count: number; advanced_settings: { size: string };
  garment_fixtures: readonly string[]; garment_only_bytes: number; base_photo_bytes: number;
  aggregate_submitted_bytes: number; reason: string;
}
export interface SizingInputEnvelope {
  schema_version: number; reference: string; run_url: string; run_id: number; run_attempt: number;
  stage: string; e2e_sha: string; workload: string; input_bytes_max: number; input_bytes_max_basis: string;
  measured_inputs_basis: string; largest_served_case_id: string; largest_served_bytes: number;
  measured_inputs: readonly SizingInputCaseReference[]; excluded_fixtures: readonly SizingExcludedFixture[];
  excluded_reason: string; vto_aggregate_limit: string; vto_shape_naming: string;
  deferred_vto_shape: SizingDeferredVtoShape; description: string;
}
export const S1_INPUT_BYTES_MAX: number;
export const S1_INPUT_ENVELOPE: SizingInputEnvelope;
export const S1_INPUT_ENVELOPE_REFERENCE: Record<string, string | number>;
export const S1_INPUT_MEASURED_BASIS: string;
export const S1_INPUT_MEASURED_CASES: readonly SizingInputCaseReference[];
export const S1_INPUT_EXCLUDED_FIXTURES: readonly SizingExcludedFixture[];
export const S1_VTO_GARMENT_POOL: readonly string[];
export const S1_DEFERRED_VTO_SHAPE: SizingDeferredVtoShape;
export const S1_VTO_SHAPE_NAMING: string;
export const SIZING_VTO_AGGREGATE_LIMIT: string;
export function assertSizingInputEnvelope(bytes: number, label: string, options?: { bound?: number }): number;
export function orderedSizingGarments(
  fixtures: Map<string, { bytes: number }>, count: number,
): { id: string; bytes: number }[];
export function vtoAggregateSubmittedBytes(
  fixtures: Map<string, { bytes: number }>, baseFixture: string, garmentIds: readonly string[],
): number;
export function assertCaseInputsWithinEnvelope(
  fixtures: Map<string, { bytes: number }>, inputs: readonly unknown[], options?: { bound?: number },
): readonly unknown[];
