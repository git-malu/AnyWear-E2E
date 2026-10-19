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
export interface SizingWideningCandidate {
  bound_bytes: number; fixture: string; case_ids: readonly string[]; prior_bound_bytes: number;
  authorising_issue: number; status: string;
}
export interface SizingDiagnosticProbe {
  case_id: string; fixture: string; mime: string; expected_failure_code: string;
  expected_executions: number; expected_provider_calls: number; status_when_not_run: string;
  qualifying: boolean; purpose: string;
}
export interface SizingEnvelopeRecord {
  envelope_mode: string; candidate_bound_bytes: number; prior_bound_bytes: number;
}
export interface SizingInputEnvelope {
  schema_version: number; reference: string; run_url: string; run_id: number; run_attempt: number;
  stage: string; e2e_sha: string; workload: string; input_bytes_max: number; input_bytes_max_basis: string;
  measured_inputs_basis: string; largest_served_case_id: string; largest_served_bytes: number;
  measured_inputs: readonly SizingInputCaseReference[]; excluded_fixtures: readonly SizingExcludedFixture[];
  excluded_reason: string; widening_candidate: SizingWideningCandidate;
  vto_aggregate_limit: string; vto_shape_naming: string;
  deferred_vto_shape: SizingDeferredVtoShape; description: string;
}
export const S1_INPUT_BYTES_MAX: number;
export const S1_INPUT_ENVELOPE: SizingInputEnvelope;
export const S1_INPUT_ENVELOPE_REFERENCE: Record<string, string | number>;
export const S1_INPUT_MEASURED_BASIS: string;
export const S1_INPUT_MEASURED_CASES: readonly SizingInputCaseReference[];
export const S1_INPUT_EXCLUDED_FIXTURES: readonly SizingExcludedFixture[];
export const S1_WIDENING_CANDIDATE: SizingWideningCandidate;
export const S1_GARMENT_PNG_FIXTURE: string;
export const S1_DIAGNOSTIC_PROBE: SizingDiagnosticProbe;
export const SIZING_ENVELOPE_MODE_DEMONSTRATED: 'demonstrated';
export const SIZING_ENVELOPE_MODE_WIDENING_CANDIDATE: 'widening-candidate';
export const SIZING_ENVELOPE_MODES: readonly string[];
export const SIZING_ENVELOPE_MODE_ENV: string;
export const S1_VTO_GARMENT_POOL: readonly string[];
export const S1_DEFERRED_VTO_SHAPE: SizingDeferredVtoShape;
export const S1_VTO_SHAPE_NAMING: string;
export const SIZING_VTO_AGGREGATE_LIMIT: string;
export function assertSizingEnvelopeMode(mode: string): string;
export function resolveSizingEnvelopeMode(value?: string | undefined): string;
export function assertSizingEnvelopeModeScope(mode: string, scope?: { operation?: string; stage?: string }): string;
export function sizingCaseInputBound(
  mode: string, caseId: string | undefined, fixtureId: string, options?: { bound?: number },
): number;
export function sizingEnvelopeRecord(mode?: string): SizingEnvelopeRecord;
export function assertSizingInputEnvelope(bytes: number, label: string, options?: { bound?: number }): number;
export function orderedSizingGarments(
  fixtures: Map<string, { bytes: number }>, count: number,
): { id: string; bytes: number }[];
export function vtoAggregateSubmittedBytes(
  fixtures: Map<string, { bytes: number }>, baseFixture: string, garmentIds: readonly string[],
): number;
export function assertCaseInputsWithinEnvelope(
  fixtures: Map<string, { bytes: number }>, inputs: readonly unknown[],
  options?: { mode?: string; bound?: number },
): readonly unknown[];
