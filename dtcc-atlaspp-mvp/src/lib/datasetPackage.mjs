// Shared by the browser and catalogue importer. Native model semantics belong
// to Core; these consumers verify the package envelope and artifact bytes.
export const CANONICAL_VERSION = 'dtcc-dataset-manifest-v3';

export function validatePackageManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Dataset manifest must be an object');
  }
  if (manifest.schema_version === 'dtcc-dataset-manifest-v2') return;
  if (manifest.schema_version !== CANONICAL_VERSION) throw new Error('Unsupported dataset manifest version');
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Canonical package requires artifacts');
  const paths = new Set();
  let totalSize = 0;
  for (const artifact of manifest.artifacts) {
    const path = artifact?.path;
    if (typeof path !== 'string' || path === 'manifest.json' || /[\\:\x00-\x1f]/.test(path) ||
        path.split('/').some(part => !part || part.startsWith('.')) || paths.has(path)) {
      throw new Error('Invalid or duplicate canonical artifact path');
    }
    paths.add(path);
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 ||
        typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      throw new Error('Canonical artifacts require size and sha256');
    }
    totalSize += artifact.size;
  }
  if (manifest.artifacts.length > 9999 || totalSize > 256 * 1024 * 1024) throw new Error('Canonical package exceeds size limits');
  const models = manifest.artifacts.filter(artifact => artifact.role === 'canonical_model');
  if (models.length !== 1) throw new Error('Canonical package requires exactly one canonical_model artifact');
  const model = models[0];
  if (model.format !== 'dtcc' || model.media_type !== 'application/vnd.dtcc.model+protobuf' ||
      model.data_kind !== 'model' || typeof model.model_type !== 'string' || !model.model_type.trim() ||
      !Number.isSafeInteger(model.model_schema_version) || model.model_schema_version <= 0 || model.derived_from != null) {
    throw new Error('Invalid canonical model declaration');
  }
  for (const artifact of manifest.artifacts) {
    if (artifact !== model && (artifact.role !== 'derived' || artifact.derived_from !== model.path)) {
      throw new Error('Derived artifacts must reference the canonical model');
    }
  }
}

export async function verifyCanonicalArtifacts(manifest, readArtifact) {
  validatePackageManifest(manifest);
  if (manifest.schema_version !== CANONICAL_VERSION) return;
  if (!globalThis.crypto?.subtle) throw new Error('Canonical package verification requires HTTPS or localhost');
  for (const artifact of manifest.artifacts) {
    const bytes = await readArtifact(artifact.path);
    await verifyArtifact(artifact, bytes);
  }
}

export async function verifyArtifact(artifact, bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Canonical package verification requires HTTPS or localhost');
  if (bytes.byteLength !== artifact.size) throw new Error(`Artifact size mismatch: ${artifact.path}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hex !== artifact.sha256) throw new Error(`Artifact sha256 mismatch: ${artifact.path}`);
}
