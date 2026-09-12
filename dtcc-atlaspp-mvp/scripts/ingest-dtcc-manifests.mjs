#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { CANONICAL_VERSION, validatePackageManifest, verifyCanonicalArtifacts } from '../src/lib/datasetPackage.mjs';

const MANIFEST_V2_SCHEMA_VERSION = 'dtcc-dataset-manifest-v2';
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBounds(value) {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isSafeRelativeFile(file) {
  if (file.length === 0) return false;
  if (file.includes('\\')) return false;
  if (isAbsolute(file)) return false;
  if (/^[A-Za-z]:/.test(file)) return false;
  if (file.includes('://')) return false;
  return !file.split('/').some((part) => part.length === 0 || part === '.' || part === '..' || part.startsWith('.'));
}

function isInsidePath(root, path) {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(id) {
  return id
    .split('-')
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatName(manifest) {
  return typeof manifest.format === 'string' && manifest.format.length > 0 ? manifest.format.toLowerCase() : 'unknown';
}

function kindForManifest(manifest) {
  const format = formatName(manifest);
  if (format === 'geojson') return { kind: 'geojson', format, mediaType: manifest.media_type };
  if (format === 'png') {
    if (manifest.data_kind !== 'raster') throw new Error('png manifests must have data_kind raster');
    if (manifest.media_type !== 'image/png') throw new Error('png manifests must have media_type image/png');
    return { kind: 'image', format, mediaType: 'image/png' };
  }
  if (format === 'mp4') {
    if (manifest.data_kind !== 'video') throw new Error('mp4 manifests must have data_kind video');
    if (manifest.media_type !== 'video/mp4') throw new Error('mp4 manifests must have media_type video/mp4');
    return { kind: 'video', format, mediaType: 'video/mp4' };
  }
  return null;
}

function supportedVisualization(value) {
  if (!isRecord(value)) return undefined;
  const out = {};
  for (const key of ['profile', 'width', 'height', 'fps', 'duration']) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function findInputPaths(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  const paths = [];

  for (const item of items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const itemPath = join(dir, item.name);
    if (item.isDirectory()) {
      paths.push(...(await findInputPaths(itemPath)));
    } else if (item.isFile() && (item.name.endsWith('.manifest.json') || item.name.endsWith('.dtccpkg'))) {
      paths.push(itemPath);
    }
  }

  return paths;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readCatalog(catalogPath) {
  if (!existsSync(catalogPath)) return { version: 1, entries: [] };

  const catalog = await readJson(catalogPath);
  if (!isRecord(catalog) || catalog.version !== 1 || !Array.isArray(catalog.entries)) {
    throw new Error(`${catalogPath} must be a version 1 catalog with entries`);
  }

  const seen = new Set();
  for (const entry of catalog.entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error(`${catalogPath} contains a catalog entry without a valid id`);
    }
    if (seen.has(entry.id)) throw new Error(`${catalogPath} contains duplicate catalog id "${entry.id}"`);
    seen.add(entry.id);
  }

  return catalog;
}

async function parseManifest(manifestPath, manifest, datasetsDir) {
  if (!isRecord(manifest)) throw new Error(`${manifestPath} must contain a JSON object`);
  if (manifest.schema_version === MANIFEST_V2_SCHEMA_VERSION || manifest.schema_version === CANONICAL_VERSION) {
    await verifyCanonicalArtifacts(manifest, path => {
      const target = resolve(dirname(manifestPath), path);
      if (statSync(target).size > 256 * 1024 * 1024) throw new Error('Canonical artifact exceeds size limits');
      return readFile(target);
    });
    return parseDatasetManifest({
      manifestPath,
      manifest,
      datasetsDir,
      packageId: slugify(basename(dirname(manifestPath))),
      artifactResolver: (artifactPath) => {
        const manifestDir = resolve(dirname(manifestPath));
        const sourceFile = resolve(manifestDir, artifactPath);
        if (!isInsidePath(manifestDir, sourceFile)) {
          throw new Error(`${manifestPath} artifact path must resolve inside the manifest directory`);
        }
        return { sourceFile };
      },
    });
  }
  if (typeof manifest.file !== 'string' || !isSafeRelativeFile(manifest.file)) {
    throw new Error(`${manifestPath} file must be relative to the manifest directory`);
  }

  const manifestKind = kindForManifest(manifest);
  if (manifestKind === null) {
    return {
      skipped: {
        manifest: manifestPath,
        reason: `format ${formatName(manifest)} is not supported by the Atlas catalog`,
      },
    };
  }

  if (!isBounds(manifest.bounds)) {
    throw new Error(`${manifestPath} bounds must be four finite numbers`);
  }
  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    throw new Error(`${manifestPath} description must be a string when present`);
  }

  const fileName = basename(manifest.file);
  const id = typeof manifest.id === 'string' && manifest.id.trim().length > 0 ? manifest.id.trim() : slugify(fileName);
  if (id.length === 0) throw new Error(`${manifestPath} must provide an id or sluggable file name`);

  const manifestDir = resolve(dirname(manifestPath));
  const sourceFile = resolve(manifestDir, manifest.file);
  if (!isInsidePath(manifestDir, sourceFile)) {
    throw new Error(`${manifestPath} file must resolve inside the manifest directory`);
  }
  const targetFile = resolve(datasetsDir, fileName);
  if (!existsSync(sourceFile)) throw new Error(`${manifestPath} references missing file ${manifest.file}`);

  const entry = {
    id,
    title:
      typeof manifest.title === 'string' && manifest.title.trim().length > 0
        ? manifest.title.trim()
        : titleFromId(id),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    file: relative(datasetsDir, targetFile),
    bounds: manifest.bounds,
    kind: manifestKind.kind,
    format: manifestKind.format,
    ...(manifestKind.mediaType !== undefined ? { mediaType: manifestKind.mediaType } : {}),
  };
  const visualization = supportedVisualization(manifest.visualization);
  if ((manifestKind.kind === 'image' || manifestKind.kind === 'video') && visualization !== undefined) {
    entry.visualization = visualization;
  }

  return {
    entry,
    sourceFile,
    targetFile,
    manifestPath,
  };
}

function parseDatasetManifest({ manifestPath, manifest, datasetsDir, packageId, artifactResolver }) {
  validatePackageManifest(manifest);
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`${manifestPath} Dataset Manifest v2 must include non-empty artifacts`);
  }

  const candidates = [];
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index];
    if (!isRecord(artifact)) throw new Error(`${manifestPath} artifact ${index} must be an object`);
    if (typeof artifact.path !== 'string' || !isSafeRelativeFile(artifact.path)) {
      throw new Error(`${manifestPath} artifact ${index} path must be relative to the package root`);
    }
    for (const key of ['role', 'format', 'media_type', 'data_kind']) {
      if (typeof artifact[key] !== 'string' || artifact[key].trim().length === 0) {
        throw new Error(`${manifestPath} artifact ${index} must include ${key}`);
      }
    }
    const manifestKind = kindForManifest(artifact);
    if (manifestKind === null) continue;
    const primary = artifact.role === 'primary';
    const rank =
      manifestKind.kind === 'image'
        ? primary
          ? 0
          : 3
        : manifestKind.kind === 'video'
          ? primary
            ? 1
            : 4
          : primary
            ? 2
            : 5;
    candidates.push({ artifact, manifestKind, rank, index });
  }

  if (candidates.length === 0) {
    return {
      skipped: {
        manifest: manifestPath,
        reason: 'Dataset Manifest v2 has no displayable image/png, video/mp4, or GeoJSON artifact',
      },
    };
  }

  candidates.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const selected = candidates[0];
  const request = isRecord(manifest.request) ? manifest.request : {};
  const identity = isRecord(manifest.identity) ? manifest.identity : {};
  const metadata = isRecord(manifest.metadata) ? manifest.metadata : {};
  const presentation = isRecord(manifest.presentation) ? manifest.presentation : {};
  const bounds = isBounds(selected.artifact.bounds) ? selected.artifact.bounds : isBounds(request.bounds) ? request.bounds : null;
  if (!bounds) throw new Error(`${manifestPath} Dataset Manifest v2 selected artifact has no four-number bounds`);

  const fileName = basename(selected.artifact.path);
  const id =
    packageId ||
    slugify(
      typeof identity.name === 'string' && identity.name.trim().length > 0
        ? identity.name
        : fileName
    );
  if (id.length === 0) throw new Error(`${manifestPath} must provide a sluggable package name`);

  const title =
    typeof identity.title === 'string' && identity.title.trim().length > 0
      ? identity.title.trim()
      : typeof presentation.headline === 'string' && presentation.headline.trim().length > 0
        ? presentation.headline.trim()
        : typeof identity.name === 'string' && identity.name.trim().length > 0
          ? titleFromId(slugify(identity.name))
          : titleFromId(id);
  const description =
    typeof metadata.description === 'string' && metadata.description.trim().length > 0
      ? metadata.description
      : typeof presentation.summary === 'string' && presentation.summary.trim().length > 0
        ? presentation.summary
        : undefined;

  const targetFile = resolve(datasetsDir, fileName);
  const resolvedArtifact = artifactResolver(selected.artifact.path);
  const entry = {
    id,
    title,
    ...(description !== undefined ? { description } : {}),
    file: relative(datasetsDir, targetFile),
    bounds,
    kind: selected.manifestKind.kind,
    format: selected.manifestKind.format,
    ...(selected.manifestKind.mediaType !== undefined ? { mediaType: selected.manifestKind.mediaType } : {}),
  };
  const visualization = supportedVisualization(presentation.view_hints);
  if ((selected.manifestKind.kind === 'image' || selected.manifestKind.kind === 'video') && visualization !== undefined) {
    entry.visualization = visualization;
  }

  return {
    entry,
    targetFile,
    manifestPath,
    artifactPath: selected.artifact.path,
    ...resolvedArtifact,
  };
}

async function parsePackage(packagePath, datasetsDir) {
  if (statSync(packagePath).size > 256 * 1024 * 1024) throw new Error('Package exceeds size limits');
  const bytes = await readFile(packagePath);
  const entries = readZipEntries(bytes, packagePath);
  if (bytes.byteLength > 256 * 1024 * 1024 || entries.length > 10000 ||
      new Set(entries.map(e => e.name)).size !== entries.length ||
      entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > 256 * 1024 * 1024) {
    throw new Error('Package has duplicate members or exceeds size limits');
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const manifestEntry = byName.get('manifest.json');
  if (!manifestEntry) throw new Error(`${packagePath} is missing manifest.json`);
  const manifest = JSON.parse(readZipEntry(bytes, manifestEntry, packagePath).toString('utf8'));
  validatePackageManifest(manifest);
  if (manifest.schema_version === CANONICAL_VERSION) {
    const expected = new Set(['manifest.json', ...manifest.artifacts.map(a => a.path)]);
    if (entries.length !== expected.size || entries.some(entry => !expected.has(entry.name))) {
      throw new Error('Canonical archive members must match the manifest exactly');
    }
  }
  await verifyCanonicalArtifacts(manifest, path => {
    const entry = byName.get(path);
    if (!entry) throw new Error(`Missing canonical package artifact: ${path}`);
    return readZipEntry(bytes, entry, packagePath);
  });
  return parseDatasetManifest({
    manifestPath: `${packagePath}!/manifest.json`,
    manifest,
    datasetsDir,
    packageId: slugify(basename(packagePath).replace(/\.dtccpkg$/i, '')),
    artifactResolver: (artifactPath) => {
      const artifactEntry = byName.get(artifactPath);
      if (!artifactEntry) throw new Error(`${packagePath} references missing artifact ${artifactPath}`);
      return { artifactBytes: readZipEntry(bytes, artifactEntry, packagePath) };
    },
  });
}

function readZipEntries(bytes, packagePath) {
  const minEndOffset = Math.max(0, bytes.length - 65557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minEndOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset === -1) throw new Error(`${packagePath} is not a valid .dtccpkg zip archive`);

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    centralDirectoryOffset === 0xffffffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize > bytes.length
  ) {
    throw new Error(`${packagePath} uses an unsupported ZIP64 or truncated central directory`);
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER) {
      throw new Error(`${packagePath} has a malformed central directory`);
    }
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const filenameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + filenameLength;
    if (nameEnd > bytes.length) throw new Error(`${packagePath} has a truncated file name`);
    const name = bytes.subarray(nameStart, nameEnd).toString('utf8');
    if (!name.endsWith('/')) {
      if (!isSafeRelativeFile(name)) throw new Error(`${packagePath} contains unsafe member ${name}`);
      entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(bytes, entry, packagePath) {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length || bytes.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER) {
    throw new Error(`${packagePath} has a malformed local file header for ${entry.name}`);
  }
  const filenameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + filenameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error(`${packagePath} has truncated data for ${entry.name}`);
  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === ZIP_STORED) {
    if (compressed.byteLength !== entry.uncompressedSize) {
      throw new Error(`${packagePath} has an invalid stored size for ${entry.name}`);
    }
    return compressed;
  }
  if (entry.compressionMethod !== ZIP_DEFLATED) {
    throw new Error(`${packagePath} uses unsupported ZIP compression for ${entry.name}`);
  }
  const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
  if (inflated.byteLength !== entry.uncompressedSize) {
    throw new Error(`${packagePath} has an invalid deflated size for ${entry.name}`);
  }
  return inflated;
}

function mergeCatalogEntries(existingEntries, importedEntries) {
  const entries = [...existingEntries];
  const indexes = new Map(entries.map((entry, index) => [entry.id, index]));

  for (const entry of importedEntries) {
    const index = indexes.get(entry.id);
    if (index === undefined) {
      indexes.set(entry.id, entries.length);
      entries.push(entry);
    } else {
      entries[index] = entry;
    }
  }

  return entries;
}

export async function ingestManifests({ sourceDir, datasetsDir, catalogPath }) {
  const resolvedSourceDir = resolve(sourceDir);
  const resolvedDatasetsDir = resolve(datasetsDir);
  const resolvedCatalogPath = resolve(catalogPath);
  const inputPaths = await findInputPaths(resolvedSourceDir);
  const imported = [];
  const skipped = [];
  const seenImportedIds = new Map();

  for (const inputPath of inputPaths) {
    const parsed = inputPath.endsWith('.dtccpkg')
      ? await parsePackage(inputPath, resolvedDatasetsDir)
      : await parseManifest(inputPath, await readJson(inputPath), resolvedDatasetsDir);
    if (parsed.skipped) {
      skipped.push(parsed.skipped);
      continue;
    }

    const previousPath = seenImportedIds.get(parsed.entry.id);
    if (previousPath !== undefined) {
      throw new Error(`duplicate imported catalog id "${parsed.entry.id}" in ${previousPath} and ${manifestPath}`);
    }
    seenImportedIds.set(parsed.entry.id, parsed.manifestPath);
    imported.push(parsed);
  }

  await mkdir(resolvedDatasetsDir, { recursive: true });
  for (const item of imported) {
    if (item.artifactBytes) {
      await writeFile(item.targetFile, item.artifactBytes);
    } else if (item.sourceFile !== item.targetFile) {
      await copyFile(item.sourceFile, item.targetFile);
    }
  }

  const existingCatalog = await readCatalog(resolvedCatalogPath);
  const entries = mergeCatalogEntries(
    existingCatalog.entries,
    imported.map((item) => item.entry)
  );
  const catalog = { version: 1, entries };
  await writeFile(resolvedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  return {
    imported: imported.map((item) => item.entry),
    skipped,
    catalog,
  };
}

function usage() {
  return [
    'Usage: npm run catalog:ingest -- <manifest-dir> [--datasets-dir public/datasets] [--catalog public/datasets/catalog.json]',
    '',
    'Scans recursively for dtcc-core .dtccpkg packages and legacy *.manifest.json files, copies GeoJSON/PNG/MP4 artifacts into public/datasets,',
    'and upserts compatible entries into catalog.json. Unsupported formats are skipped with a warning.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  let sourceDir;
  let datasetsDir = resolve(process.cwd(), 'public', 'datasets');
  let catalogPath = join(datasetsDir, 'catalog.json');

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--datasets-dir') {
      const value = args.shift();
      if (!value) throw new Error('--datasets-dir requires a value');
      datasetsDir = resolve(value);
      if (catalogPath.endsWith(join('public', 'datasets', 'catalog.json'))) {
        catalogPath = join(datasetsDir, 'catalog.json');
      }
      continue;
    }
    if (arg === '--catalog') {
      const value = args.shift();
      if (!value) throw new Error('--catalog requires a value');
      catalogPath = resolve(value);
      continue;
    }
    if (arg?.startsWith('--')) throw new Error(`unknown option ${arg}`);
    if (sourceDir !== undefined) throw new Error(`unexpected argument ${arg}`);
    sourceDir = arg;
  }

  if (!sourceDir) throw new Error(usage());
  return { sourceDir, datasetsDir, catalogPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await ingestManifests(options);

  for (const skipped of result.skipped) {
    console.warn(`Skipped ${skipped.manifest}: ${skipped.reason}`);
  }
  console.log(`Imported ${result.imported.length} dataset package(s) into ${resolve(options.catalogPath)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
