import type { Bbox } from './storage';
import { CANONICAL_VERSION, validatePackageManifest, verifyCanonicalArtifacts } from './datasetPackage.mjs';

export type ManifestInputResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type ManifestVisualization = {
  profile?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
};

export type DtccManifest = {
  file: string;
  artifactName: string;
  title: string;
  description?: string;
  bounds: Bbox;
  kind: 'geojson' | 'image' | 'video';
  format: 'geojson' | 'png' | 'mp4';
  mediaType?: 'application/geo+json' | 'application/json' | 'image/png' | 'video/mp4';
  visualization?: ManifestVisualization;
};

export type DtccManifestFileSelection = {
  manifest: DtccManifest;
  artifact: File | null;
  missingArtifact: string | null;
  manifestPath?: string;
};

const MANIFEST_V2_SCHEMA_VERSION = 'dtcc-dataset-manifest-v2';
type ManifestKind = Pick<DtccManifest, 'kind' | 'format' | 'mediaType'>;
type DisplayCandidate = {
  artifact: Record<string, unknown> & { path: string };
  kind: ManifestKind;
  rank: number;
  index: number;
};
type ZipEntry = {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBbox(value: unknown): value is Bbox {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isSafeRelativeFile(file: string): boolean {
  if (file.length === 0) return false;
  if (file.includes('\\')) return false;
  if (file.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  if (file.includes('://')) return false;
  return !file.split('/').some((part) => part.length === 0 || part === '.' || part === '..' || part.startsWith('.'));
}

function basename(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

function fileRelativePath(file: File): string | null {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return typeof relativePath === 'string' && relativePath.length > 0 ? relativePath.replace(/\\/g, '/') : null;
}

function dirname(file: string): string {
  const i = file.lastIndexOf('/');
  return i === -1 ? '' : file.slice(0, i);
}

function joinRelativePath(base: string, file: string): string {
  return base.length > 0 ? `${base}/${file}` : file;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatName(manifest: Record<string, unknown>): string {
  return typeof manifest.format === 'string' && manifest.format.length > 0 ? manifest.format.toLowerCase() : 'unknown';
}

function parseVisualizationMetadata(value: unknown, manifestPath: string): ManifestInputResult<ManifestVisualization | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: `${manifestPath} visualization must be an object when present` };

  const out: ManifestVisualization = {};
  if (value.profile !== undefined) {
    if (typeof value.profile !== 'string') {
      return { ok: false, error: `${manifestPath} visualization.profile must be a string` };
    }
    out.profile = value.profile;
  }
  for (const key of ['width', 'height', 'fps', 'duration'] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      return { ok: false, error: `${manifestPath} visualization.${key} must be a finite number` };
    }
    out[key] = value[key];
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

function kindForManifest(manifest: Record<string, unknown>): ManifestInputResult<{
  kind: DtccManifest['kind'];
  format: DtccManifest['format'];
  mediaType?: DtccManifest['mediaType'];
}> {
  const format = formatName(manifest);
  if (format === 'geojson') {
    const mediaType =
      manifest.media_type === 'application/geo+json' || manifest.media_type === 'application/json'
        ? manifest.media_type
        : undefined;
    return { ok: true, value: { kind: 'geojson', format, ...(mediaType !== undefined ? { mediaType } : {}) } };
  }
  if (format === 'png') {
    if (manifest.data_kind !== 'raster') return { ok: false, error: 'png manifests must have data_kind raster' };
    if (manifest.media_type !== 'image/png') return { ok: false, error: 'png manifests must have media_type image/png' };
    return { ok: true, value: { kind: 'image', format, mediaType: 'image/png' } };
  }
  if (format === 'mp4') {
    if (manifest.data_kind !== 'video') return { ok: false, error: 'mp4 manifests must have data_kind video' };
    if (manifest.media_type !== 'video/mp4') return { ok: false, error: 'mp4 manifests must have media_type video/mp4' };
    return { ok: true, value: { kind: 'video', format, mediaType: 'video/mp4' } };
  }
  return { ok: false, error: `format ${format} is not supported by the Atlas wizard` };
}

export function isDtccManifestFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.manifest.json') || name === 'manifest.json';
}

export function isDtccPackageFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.dtccpkg');
}

export function parseDtccManifestText(manifestPath: string, text: string): ManifestInputResult<DtccManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `JSON parse error: ${(err as Error).message}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: `${manifestPath} must contain a JSON object` };
  if (parsed.schema_version === MANIFEST_V2_SCHEMA_VERSION || parsed.schema_version === CANONICAL_VERSION) {
    try {
      validatePackageManifest(parsed);
      return parseDatasetManifest(manifestPath, parsed);
    } catch (error) {
      return { ok: false, error: `${manifestPath}: ${(error as Error).message}` };
    }
  }
  if (parsed.schema_version !== undefined || parsed.artifacts !== undefined || parsed.identity !== undefined) {
    return { ok: false, error: `${manifestPath} Dataset Manifest v2 must declare schema_version ${MANIFEST_V2_SCHEMA_VERSION}` };
  }
  if (typeof parsed.file !== 'string' || !isSafeRelativeFile(parsed.file)) {
    return { ok: false, error: `${manifestPath} file must be relative to the manifest directory` };
  }
  if (!isBbox(parsed.bounds)) return { ok: false, error: `${manifestPath} bounds must be four finite numbers` };
  if (parsed.description !== undefined && typeof parsed.description !== 'string') {
    return { ok: false, error: `${manifestPath} description must be a string when present` };
  }

  const manifestKind = kindForManifest(parsed);
  if (!manifestKind.ok) return manifestKind;

  const artifactName = basename(parsed.file);
  const id =
    typeof parsed.id === 'string' && parsed.id.trim().length > 0
      ? parsed.id.trim()
      : slugify(typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name : artifactName);
  const title =
    typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title.trim() : titleFromId(id);
  const visualization = parseVisualizationMetadata(parsed.visualization, manifestPath);
  if (!visualization.ok) return visualization;

  return {
    ok: true,
    value: {
      file: parsed.file,
      artifactName,
      title,
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      bounds: parsed.bounds,
      ...manifestKind.value,
      ...(visualization.value !== undefined ? { visualization: visualization.value } : {}),
    },
  };
}

function parseDatasetManifest(manifestPath: string, manifest: Record<string, unknown>): ManifestInputResult<DtccManifest> {
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { ok: false, error: `${manifestPath} Dataset Manifest v2 must include non-empty artifacts` };
  }

  const candidates: DisplayCandidate[] = [];
  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = artifacts[i];
    if (!isRecord(artifact)) return { ok: false, error: `${manifestPath} artifact ${i} must be an object` };
    if (typeof artifact.path !== 'string' || !isSafeRelativeFile(artifact.path)) {
      return { ok: false, error: `${manifestPath} artifact ${i} path must be relative to the package root` };
    }
    const artifactPath = artifact.path;
    for (const key of ['role', 'format', 'media_type', 'data_kind'] as const) {
      if (typeof artifact[key] !== 'string' || artifact[key].trim().length === 0) {
        return { ok: false, error: `${manifestPath} artifact ${i} must include ${key}` };
      }
    }

    const kind = kindForManifest(artifact);
    if (!kind.ok) continue;
    const role = typeof artifact.role === 'string' ? artifact.role.trim() : '';
    const primary = role === 'primary';
    const rank =
      kind.value.kind === 'image'
        ? primary
          ? 0
          : 3
        : kind.value.kind === 'video'
          ? primary
            ? 1
            : 4
          : primary
            ? 2
            : 5;
    candidates.push({ artifact: { ...artifact, path: artifactPath }, kind: kind.value, rank, index: i });
  }

  if (candidates.length === 0) {
    return { ok: false, error: `${manifestPath} Dataset Manifest v2 has no displayable image/png, video/mp4, or GeoJSON artifact` };
  }

  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const selected = candidates[0];
  const request = isRecord(manifest.request) ? manifest.request : {};
  const identity = isRecord(manifest.identity) ? manifest.identity : {};
  const metadata = isRecord(manifest.metadata) ? manifest.metadata : {};
  const presentation = isRecord(manifest.presentation) ? manifest.presentation : {};
  const bounds = isBbox(selected.artifact.bounds) ? selected.artifact.bounds : isBbox(request.bounds) ? request.bounds : null;
  if (!bounds) return { ok: false, error: `${manifestPath} Dataset Manifest v2 selected artifact has no four-number bounds` };

  const title =
    typeof identity.title === 'string' && identity.title.trim().length > 0
      ? identity.title.trim()
      : typeof presentation.headline === 'string' && presentation.headline.trim().length > 0
        ? presentation.headline.trim()
        : typeof identity.name === 'string' && identity.name.trim().length > 0
          ? titleFromId(slugify(identity.name))
          : titleFromId(slugify(basename(selected.artifact.path)));
  const description =
    typeof metadata.description === 'string' && metadata.description.trim().length > 0
      ? metadata.description
      : typeof presentation.summary === 'string' && presentation.summary.trim().length > 0
        ? presentation.summary
        : undefined;
  const visualization = parseVisualizationMetadata(presentation.view_hints, manifestPath);
  if (!visualization.ok) return visualization;

  return {
    ok: true,
    value: {
      file: selected.artifact.path,
      artifactName: basename(selected.artifact.path),
      title,
      ...(description !== undefined ? { description } : {}),
      bounds,
      ...selected.kind,
      ...(visualization.value !== undefined ? { visualization: visualization.value } : {}),
    },
  };
}

export async function readDtccManifestFile(file: File): Promise<ManifestInputResult<DtccManifest>> {
  return parseDtccManifestText(fileRelativePath(file) ?? file.name, await file.text());
}

function manifestArtifactPath(manifestFile: File, manifest: DtccManifest): string | null {
  const manifestPath = fileRelativePath(manifestFile);
  return manifestPath ? joinRelativePath(dirname(manifestPath), manifest.file) : null;
}

function unsupportedManifestError(error: string): boolean {
  return error.startsWith('format ') && error.includes(' is not supported by the Atlas wizard');
}

export function findManifestArtifact(files: File[], manifest: DtccManifest, manifestFile?: File): File | null {
  const expectedPath = manifestFile ? manifestArtifactPath(manifestFile, manifest) : null;
  if (expectedPath) {
    return files.find((file) => !isDtccManifestFile(file) && fileRelativePath(file) === expectedPath) ?? null;
  }

  const relativeMatch = files.find(
    (file) => !isDtccManifestFile(file) && fileRelativePath(file) === manifest.file
  );
  if (relativeMatch) return relativeMatch;

  return files.find((file) => !isDtccManifestFile(file) && file.name === manifest.artifactName) ?? null;
}

async function verifyManifestFiles(manifestFile: File, files: File[]): Promise<ManifestInputResult<void>> {
  try {
    const raw = JSON.parse(await manifestFile.text());
    if (raw.schema_version === CANONICAL_VERSION) {
      const byPath = new Map<string, File[]>();
      const byName = new Map<string, File[]>();
      for (const file of files) {
        const relative = fileRelativePath(file);
        const index = relative ? byPath : byName;
        const key = relative ?? file.name;
        index.set(key, [...(index.get(key) ?? []), file]);
      }
      await verifyCanonicalArtifacts(raw, async (path) => {
        const manifestPath = fileRelativePath(manifestFile);
        const expected = manifestPath ? joinRelativePath(dirname(manifestPath), path) : path;
        const matches = byPath.get(expected) ?? (!manifestPath ? byName.get(basename(path)) : undefined) ?? [];
        if (matches.length !== 1) throw new Error(`Missing or ambiguous canonical artifact: ${path}`);
        if (matches[0].size > 256 * 1024 * 1024) throw new Error('Canonical artifact exceeds size limits');
        return new Uint8Array(await matches[0].arrayBuffer());
      });
    }
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function resolveDtccManifestFiles(files: File[]): Promise<ManifestInputResult<DtccManifestFileSelection>> {
  if (files.some(isDtccPackageFile)) {
    const packages = await resolveDtccPackageFiles(files);
    if (!packages.ok) return packages;
    if (packages.value.length !== 1) return { ok: false, error: 'select exactly one .dtccpkg package' };
    return { ok: true, value: packages.value[0] };
  }

  const manifestFile = files.find(isDtccManifestFile);
  if (!manifestFile) return { ok: false, error: 'selection does not include a dtcc manifest' };

  const manifest = await readDtccManifestFile(manifestFile);
  if (!manifest.ok) return manifest;

  const verified = await verifyManifestFiles(manifestFile, files);
  if (!verified.ok) return verified;

  const artifact = findManifestArtifact(files, manifest.value, manifestFile);
  return {
    ok: true,
    value: {
      manifest: manifest.value,
      artifact,
      missingArtifact: artifact ? null : manifest.value.file,
    },
  };
}

export async function resolveDtccPackageFiles(files: File[]): Promise<ManifestInputResult<DtccManifestFileSelection[]>> {
  const packageFiles = files.filter(isDtccPackageFile);
  if (packageFiles.length === 0) return { ok: false, error: 'selection does not include a .dtccpkg package' };

  const extractedFiles: File[] = [];
  for (const packageFile of packageFiles) {
    const extracted = await extractDtccPackage(packageFile);
    if (!extracted.ok) return extracted;
    extractedFiles.push(...extracted.value);
  }
  return resolveDtccManifestFolder(extractedFiles);
}

export async function resolveDtccManifestFolder(files: File[]): Promise<ManifestInputResult<DtccManifestFileSelection[]>> {
  if (files.some(isDtccPackageFile)) return resolveDtccPackageFiles(files);

  const manifestFiles = files.filter(isDtccManifestFile);
  if (manifestFiles.length === 0) return { ok: false, error: 'folder does not include a dtcc manifest' };

  const selections: DtccManifestFileSelection[] = [];
  for (const manifestFile of manifestFiles) {
    const manifest = await readDtccManifestFile(manifestFile);
    if (!manifest.ok) {
      if (unsupportedManifestError(manifest.error)) continue;
      return manifest;
    }

    const verified = await verifyManifestFiles(manifestFile, files);
    if (!verified.ok) return verified;
    const manifestPath = fileRelativePath(manifestFile);
    const artifact = findManifestArtifact(files, manifest.value, manifestFile);
    const expectedPath = manifestArtifactPath(manifestFile, manifest.value) ?? manifest.value.file;
    selections.push({
      manifest: manifest.value,
      artifact,
      missingArtifact: artifact ? null : expectedPath,
      ...(manifestPath !== null ? { manifestPath } : {}),
    });
  }

  if (selections.length === 0) {
    return { ok: false, error: 'folder does not include a supported dtcc manifest' };
  }

  return { ok: true, value: selections };
}

async function extractDtccPackage(packageFile: File): Promise<ManifestInputResult<File[]>> {
  if (packageFile.size > 256 * 1024 * 1024) return { ok: false, error: 'Package exceeds 256 MiB limit' };
  const bytes = new Uint8Array(await packageFile.arrayBuffer());
  const entries = readZipEntries(bytes, packageFile.name);
  if (!entries.ok) return entries;

  if (entries.value.length > 10000 || new Set(entries.value.map(e => e.name)).size !== entries.value.length ||
      entries.value.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > 256 * 1024 * 1024) {
    return { ok: false, error: 'Package has duplicate members or exceeds size limits' };
  }
  const files: File[] = [];
  for (const entry of entries.value) {
    if (!isSafeRelativeFile(entry.name)) {
      return { ok: false, error: `${packageFile.name} contains unsafe member ${entry.name}` };
    }
    const data = await readZipEntry(bytes, entry, packageFile.name);
    if (!data.ok) return data;
    files.push(fileFromPackageMember(packageFile.name, entry.name, data.value));
  }

  const manifestFile = files.find(file => file.name === 'manifest.json');
  if (!manifestFile) return { ok: false, error: `${packageFile.name} does not contain manifest.json` };
  try {
    const manifest = JSON.parse(await manifestFile.text());
    if (manifest.schema_version === CANONICAL_VERSION) {
      validatePackageManifest(manifest);
      const expected = new Set(['manifest.json', ...manifest.artifacts.map((a: { path: string }) => a.path)]);
      if (entries.value.length !== expected.size || entries.value.some(entry => !expected.has(entry.name))) {
        return { ok: false, error: 'Canonical archive members must match the manifest exactly' };
      }
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, value: files };
}

function readZipEntries(bytes: Uint8Array, packageName: string): ManifestInputResult<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEndOffset = Math.max(0, bytes.length - 65557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minEndOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) return { ok: false, error: `${packageName} is not a valid .dtccpkg zip archive` };

  const entryCount = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);
  if (
    centralDirectoryOffset === 0xffffffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize > bytes.length
  ) {
    return { ok: false, error: `${packageName} uses an unsupported ZIP64 or truncated central directory` };
  }

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      return { ok: false, error: `${packageName} has a malformed central directory` };
    }
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + filenameLength;
    if (nameEnd > bytes.length) return { ok: false, error: `${packageName} has a truncated file name` };
    const name = decoder.decode(bytes.slice(nameStart, nameEnd));
    if (!name.endsWith('/')) {
      entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return { ok: true, value: entries };
}

async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  packageName: string
): Promise<ManifestInputResult<Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || view.getUint32(offset, true) !== ZIP_LOCAL_FILE_HEADER) {
    return { ok: false, error: `${packageName} has a malformed local file header for ${entry.name}` };
  }
  const filenameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + filenameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) return { ok: false, error: `${packageName} has truncated data for ${entry.name}` };
  const compressed = bytes.slice(dataStart, dataEnd);

  if (entry.compressionMethod === ZIP_STORED) {
    if (compressed.byteLength !== entry.uncompressedSize) {
      return { ok: false, error: `${packageName} has an invalid stored size for ${entry.name}` };
    }
    return { ok: true, value: compressed };
  }
  if (entry.compressionMethod !== ZIP_DEFLATED) {
    return { ok: false, error: `${packageName} uses unsupported ZIP compression for ${entry.name}` };
  }
  if (typeof DecompressionStream !== 'function') {
    return { ok: false, error: 'this browser cannot open compressed .dtccpkg archives' };
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > entry.uncompressedSize) {
        await reader.cancel();
        return { ok: false, error: `${packageName} exceeds declared size for ${entry.name}` };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, error: `${packageName} cannot decompress ${entry.name}: ${(error as Error).message}` };
  }
  const inflated = new Uint8Array(size);
  let writeOffset = 0;
  for (const chunk of chunks) { inflated.set(chunk, writeOffset); writeOffset += chunk.byteLength; }
  if (inflated.byteLength !== entry.uncompressedSize) {
    return { ok: false, error: `${packageName} has an invalid deflated size for ${entry.name}` };
  }
  return { ok: true, value: inflated };
}

function fileFromPackageMember(packageName: string, memberName: string, bytes: Uint8Array): File {
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const file = new File([data], basename(memberName), { type: contentTypeForPath(memberName) });
  Object.defineProperty(file, 'webkitRelativePath', {
    value: `${packageName}/${memberName}`,
    configurable: true,
  });
  return file;
}

function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.geojson')) return 'application/geo+json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return '';
}
