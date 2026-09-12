export const CANONICAL_VERSION: string;
export function validatePackageManifest(manifest: unknown): void;
export function verifyArtifact(artifact: { path: string; size: number; sha256: string }, bytes: Uint8Array): Promise<void>;
export function verifyCanonicalArtifacts(
  manifest: unknown,
  readArtifact: (path: string) => Promise<Uint8Array> | Uint8Array,
): Promise<void>;
