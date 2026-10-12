export interface SizingFixture {
  id: string; file: string; mime: string; size_class: string;
  bytes: number; width: number; height: number; sha256: string; data: Buffer;
}
export interface UploadCase { case_id: string; fixture: string; submission: string; size_class: string }
export interface VtoCase { case_id: string; shape: string; base_fixture: string; garment_count: number; advanced_settings?: { size: string } }
export const SIZING_PROVIDER_ENVELOPE: Record<string, unknown>;
export function hashBytes(bytes: string | Buffer): string;
export function loadSizingFixtures(directory: URL): Promise<{ fixtures: Map<string, SizingFixture>; manifestSha256: string; envelopeSha256: string }>;
export function sizingUploadCases(): UploadCase[];
export function sizingVtoCases(): VtoCase[];
