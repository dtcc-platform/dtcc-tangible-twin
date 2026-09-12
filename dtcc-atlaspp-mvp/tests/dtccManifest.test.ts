import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  findManifestArtifact,
  isDtccManifestFile,
  isDtccPackageFile,
  parseDtccManifestText,
  resolveDtccManifestFolder,
  resolveDtccManifestFiles,
  resolveDtccPackageFiles,
} from '../src/lib/dtccManifest';

it.skipIf(!process.env.DTCC_CORE_CONTRACT_DIR)('opens the real Core canonical package and selects its PNG', async () => {
  const bytes = readFileSync(`${process.env.DTCC_CORE_CONTRACT_DIR}/canonical.dtccpkg`);
  const result = await resolveDtccPackageFiles([new File([new Uint8Array(bytes)], 'canonical.dtccpkg')]);
  if (!result.ok) throw new Error(result.error);
  expect(result.value[0].manifest.format).toBe('png');
  expect(result.value[0].manifest.title).toBe('Canonical raster contract fixture');
  expect(result.value[0].artifact).not.toBeNull();
});

it('verifies canonical artifact bytes for single and folder selections', async () => {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = {
    schema_version: 'dtcc-dataset-manifest-v3',
    identity: { name: 'canonical', title: 'Canonical' },
    request: { bounds: [0, 0, 2, 2] },
    artifacts: [
      { path: 'artifacts/model.dtcc', role: 'canonical_model', format: 'dtcc',
        media_type: 'application/vnd.dtcc.model+protobuf', data_kind: 'model',
        model_type: 'Raster', model_schema_version: 6, size: 5, sha256: digest('model') },
      { path: 'artifacts/preview.png', role: 'derived', derived_from: 'artifacts/model.dtcc',
        format: 'png', media_type: 'image/png', data_kind: 'raster', size: 3, sha256: digest('png') },
    ],
  };
  const files = [file('manifest.json', JSON.stringify(manifest)), file('model.dtcc', 'model'), file('preview.png', 'png')];
  expect((await resolveDtccManifestFiles(files)).ok).toBe(true);
  const corrupt = [files[0], file('model.dtcc', 'wrong'), files[2]];
  const result = await resolveDtccManifestFiles(corrupt);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain('sha256');
  expect((await resolveDtccManifestFolder(corrupt)).ok).toBe(false);
  manifest.schema_version = 'dtcc-dataset-manifest-v999';
  expect(parseDtccManifestText('manifest.json', JSON.stringify(manifest)).ok).toBe(false);
});

function file(name: string, contents: string, type = ''): File {
  return new File([contents], name, { type });
}

function folderFile(path: string, contents: string, type = ''): File {
  const f = file(path.split('/').pop() ?? path, contents, type);
  Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
}

function dtccPackage(name: string, entries: Record<string, string>): File {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [entryName, contents] of Object.entries(entries)) {
    const nameBytes = Buffer.from(entryName, 'utf8');
    const data = Buffer.from(contents, 'utf8');
    const compressed = deflateRawSync(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, nameBytes, compressed);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return new File([new Uint8Array(Buffer.concat([...localParts, centralDirectory, end]))], name, { type: 'application/zip' });
}

const smokeStreamlinesManifest = {
  name: 'smoke',
  title: 'Smoke',
  description: 'Synthetic analytical velocity-field simulation.',
  file: 'smoke_streamlines.png',
  format: 'png',
  media_type: 'image/png',
  data_kind: 'raster',
  product: 'streamlines',
  bounds: [319720, 6397660, 320220, 6398160],
  visualization: { profile: 'table', width: 1920, height: 1920 },
};

const smokeSliceManifestV2 = {
  schema_version: 'dtcc-dataset-manifest-v2',
  identity: { name: 'smoke', title: 'Smoke Slice' },
  metadata: { description: 'Synthetic analytical velocity-field simulation.' },
  provenance: {},
  presentation: { summary: 'A projected smoke slice.', view_hints: { profile: 'table', width: 320, height: 180 } },
  request: { dataset_name: 'smoke', parameters: { product: 'slice' }, bounds: [0, 0, 10, 20] },
  artifacts: [
    {
      path: 'artifacts/smoke_slice.vtu',
      role: 'primary',
      format: 'vtu',
      media_type: 'application/vnd.vtk.vtu+xml',
      data_kind: 'mesh',
    },
    {
      path: 'artifacts/smoke_slice.png',
      role: 'primary',
      format: 'png',
      media_type: 'image/png',
      data_kind: 'raster',
      bounds: [1, 2, 3, 4],
    },
    {
      path: 'artifacts/smoke_slice.geojson',
      role: 'auxiliary',
      format: 'geojson',
      media_type: 'application/geo+json',
      data_kind: 'vector',
    },
  ],
};

describe('dtcc manifest input helpers', () => {
  it('parses a dtcc-core PNG manifest for direct wizard loading', () => {
    const result = parseDtccManifestText(
      'smoke_streamlines.manifest.json',
      JSON.stringify(smokeStreamlinesManifest)
    );

    expect(result).toEqual({
      ok: true,
      value: {
        file: 'smoke_streamlines.png',
        artifactName: 'smoke_streamlines.png',
        title: 'Smoke',
        description: 'Synthetic analytical velocity-field simulation.',
        bounds: [319720, 6397660, 320220, 6398160],
        kind: 'image',
        format: 'png',
        mediaType: 'image/png',
        visualization: { profile: 'table', width: 1920, height: 1920 },
      },
    });
  });

  it('matches a parsed manifest to its user-provided artifact file', () => {
    const manifest = parseDtccManifestText(
      'smoke_streamlines.manifest.json',
      JSON.stringify(smokeStreamlinesManifest)
    );
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const artifact = file('smoke_streamlines.png', 'png', 'image/png');
    expect(findManifestArtifact([file('smoke_streamlines.manifest.json', '{}'), artifact], manifest.value)).toBe(
      artifact
    );
  });

  it('matches folder artifacts relative to their manifest directory', () => {
    const nestedManifest = { ...smokeStreamlinesManifest, file: 'media/smoke_streamlines.png' };
    const manifest = parseDtccManifestText('exports/smoke_streamlines.manifest.json', JSON.stringify(nestedManifest));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const manifestFile = folderFile('exports/smoke_streamlines.manifest.json', JSON.stringify(nestedManifest));
    const wrongArtifact = folderFile('other/media/smoke_streamlines.png', 'png', 'image/png');
    const artifact = folderFile('exports/media/smoke_streamlines.png', 'png', 'image/png');

    expect(findManifestArtifact([wrongArtifact, artifact], manifest.value, manifestFile)).toBe(artifact);
  });

  it('parses Dataset Manifest v2 artifacts and chooses a displayable primary image', () => {
    const result = parseDtccManifestText('manifest.json', JSON.stringify(smokeSliceManifestV2));

    expect(result).toEqual({
      ok: true,
      value: {
        file: 'artifacts/smoke_slice.png',
        artifactName: 'smoke_slice.png',
        title: 'Smoke Slice',
        description: 'Synthetic analytical velocity-field simulation.',
        bounds: [1, 2, 3, 4],
        kind: 'image',
        format: 'png',
        mediaType: 'image/png',
        visualization: { profile: 'table', width: 320, height: 180 },
      },
    });
  });

  it('matches Dataset Manifest v2 package folders by artifact path', () => {
    const manifest = parseDtccManifestText('exports/smoke/manifest.json', JSON.stringify(smokeSliceManifestV2));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const manifestFile = folderFile('exports/smoke/manifest.json', JSON.stringify(smokeSliceManifestV2));
    const wrongArtifact = folderFile('exports/other/artifacts/smoke_slice.png', 'png', 'image/png');
    const artifact = folderFile('exports/smoke/artifacts/smoke_slice.png', 'png', 'image/png');

    expect(findManifestArtifact([wrongArtifact, artifact], manifest.value, manifestFile)).toBe(artifact);
  });

  it('identifies dtcc-core manifest files by sidecar suffix', () => {
    expect(isDtccManifestFile(file('smoke_streamlines.manifest.json', '{}'))).toBe(true);
    expect(isDtccManifestFile(file('manifest.json', '{}'))).toBe(true);
    expect(isDtccManifestFile(file('plain.geojson', '{}'))).toBe(false);
    expect(isDtccPackageFile(file('smoke_slice.dtccpkg', 'zip'))).toBe(true);
  });

  it('resolves a .dtccpkg package into its manifest and artifact', async () => {
    const packageFile = dtccPackage('smoke_slice.dtccpkg', {
      'manifest.json': JSON.stringify(smokeSliceManifestV2),
      'artifacts/smoke_slice.png': 'png',
      'artifacts/smoke_slice.vtu': 'vtu',
    });

    const result = await resolveDtccPackageFiles([packageFile]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].manifest.title).toBe('Smoke Slice');
    expect(result.value[0].manifest.file).toBe('artifacts/smoke_slice.png');
    expect(result.value[0].artifact?.name).toBe('smoke_slice.png');
    expect(await result.value[0].artifact?.text()).toBe('png');
  });

  it('resolves a single .dtccpkg through the file-selection helper', async () => {
    const packageFile = dtccPackage('smoke_slice.dtccpkg', {
      'manifest.json': JSON.stringify(smokeSliceManifestV2),
      'artifacts/smoke_slice.png': 'png',
    });

    const result = await resolveDtccManifestFiles([packageFile]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.artifact?.name).toBe('smoke_slice.png');
  });

  it('reports the exact missing artifact for a lone manifest selection', async () => {
    const result = await resolveDtccManifestFiles([
      file('smoke_streamlines.manifest.json', JSON.stringify(smokeStreamlinesManifest)),
    ]);

    expect(result).toEqual({
      ok: true,
      value: {
        manifest: {
          file: 'smoke_streamlines.png',
          artifactName: 'smoke_streamlines.png',
          title: 'Smoke',
          description: 'Synthetic analytical velocity-field simulation.',
          bounds: [319720, 6397660, 320220, 6398160],
          kind: 'image',
          format: 'png',
          mediaType: 'image/png',
          visualization: { profile: 'table', width: 1920, height: 1920 },
        },
        artifact: null,
        missingArtifact: 'smoke_streamlines.png',
      },
    });
  });

  it('resolves every supported manifest from a selected folder', async () => {
    const windStreamlinesManifest = {
      ...smokeStreamlinesManifest,
      name: 'wind',
      title: 'Wind',
      file: 'media/wind_streamlines.mp4',
      format: 'mp4',
      media_type: 'video/mp4',
      data_kind: 'video',
      visualization: { profile: 'table', width: 1920, height: 1080, fps: 12, duration: 4 },
    };
    const smokeManifestFile = folderFile(
      'exports/smoke/smoke_streamlines.manifest.json',
      JSON.stringify(smokeStreamlinesManifest)
    );
    const windManifestFile = folderFile(
      'exports/wind/wind_streamlines.manifest.json',
      JSON.stringify(windStreamlinesManifest)
    );
    const smokeArtifact = folderFile('exports/smoke/smoke_streamlines.png', 'png', 'image/png');
    const windArtifact = folderFile('exports/wind/media/wind_streamlines.mp4', 'mp4', 'video/mp4');

    const result = await resolveDtccManifestFolder([
      smokeManifestFile,
      windManifestFile,
      smokeArtifact,
      windArtifact,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.map((selection) => selection.manifest.title)).toEqual(['Smoke', 'Wind']);
    expect(result.value.map((selection) => selection.artifact)).toEqual([smokeArtifact, windArtifact]);
  });

  it.each([
    ['unsafe artifact path', { file: '../smoke_streamlines.png' }, /file must be relative/],
    ['Windows-style traversal path', { file: '..\\smoke_streamlines.png' }, /file must be relative/],
    ['Windows drive path', { file: 'C:\\Users\\victim\\secret.png' }, /file must be relative/],
    ['malformed bounds', { bounds: [319720, 6397660, 320220] }, /bounds must be four finite numbers/],
    ['unsupported format', { format: 'vtu', media_type: 'model\/vtu' }, /format vtu is not supported/],
    ['PNG with wrong data_kind', { data_kind: 'video' }, /png manifests must have data_kind raster/],
    ['PNG with wrong media_type', { media_type: 'video\/mp4' }, /png manifests must have media_type image\/png/],
    [
      'MP4 with wrong data_kind',
      { format: 'mp4', file: 'smoke_streamlines.mp4', data_kind: 'raster', media_type: 'video/mp4' },
      /mp4 manifests must have data_kind video/,
    ],
    [
      'MP4 with wrong media_type',
      { format: 'mp4', file: 'smoke_streamlines.mp4', data_kind: 'video', media_type: 'image/png' },
      /mp4 manifests must have media_type video\/mp4/,
    ],
  ])('rejects %s', (_name, overrides, errorPattern) => {
    const result = parseDtccManifestText(
      'smoke_streamlines.manifest.json',
      JSON.stringify({ ...smokeStreamlinesManifest, ...overrides })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(errorPattern);
  });

  it('rejects Dataset Manifest v2 packages without displayable artifacts', () => {
    const result = parseDtccManifestText(
      'manifest.json',
      JSON.stringify({
        ...smokeSliceManifestV2,
        artifacts: [
          {
            path: 'artifacts/smoke_slice.vtu',
            role: 'primary',
            format: 'vtu',
            media_type: 'application/vnd.vtk.vtu+xml',
            data_kind: 'mesh',
          },
        ],
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no displayable/);
  });

  it('rejects malformed visualization metadata', () => {
    const result = parseDtccManifestText(
      'smoke_streamlines.manifest.json',
      JSON.stringify({ ...smokeStreamlinesManifest, visualization: { profile: 'table', width: '1920' } })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/visualization.width must be a finite number/);
  });
});
