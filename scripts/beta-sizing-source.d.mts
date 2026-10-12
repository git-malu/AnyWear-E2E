export interface SizingSourceProof {
  schema_version: number; repository: string; e2e_sha: string; tree_sha: string;
  inventory: { path_base64: string; mode: string; type: string; object: string }[];
  benchmark_source_sha256: string; compatibility_blob: string; compatibility_bytes_base64: string;
  compatibility_sha256: string; compatibility: Record<string, unknown>; run_id: string; run_attempt: string;
}
export function captureSizingSource(environment?: NodeJS.ProcessEnv, options?: { root?: string }): SizingSourceProof;
export function validateSizingSource(proof: unknown, binding: { e2eSha: string; runId: string; runAttempt: string; compatibility?: unknown }): true;
