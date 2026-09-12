import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { ingestManifests } from '../scripts/ingest-dtcc-manifests.mjs';

const tempRoots = [];

it.skipIf(!process.env.DTCC_CORE_CONTRACT_DIR)('imports the real canonical Core preview through the catalogue entry point', async () => {
  const root = makeTempRoot();
  const sourceDir = join(root, 'input');
  const datasetsDir = join(root, 'datasets');
  const catalogPath = join(datasetsDir, 'catalog.json');
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, 'canonical.dtccpkg'), readFileSync(join(process.env.DTCC_CORE_CONTRACT_DIR, 'canonical.dtccpkg')));
  const result = await ingestManifests({ sourceDir, datasetsDir, catalogPath });
  expect(result.imported).toHaveLength(1);
  const catalog = readJson(catalogPath);
  expect(catalog.entries[0].title).toBe('Canonical raster contract fixture');
  expect(catalog.entries[0].format).toBe('png');
  expect(existsSync(join(datasetsDir, catalog.entries[0].file))).toBe(true);
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'atlas-catalog-ingest-'));
  tempRoots.push(root);
  return root;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
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
  return Buffer.concat([...localParts, centralDirectory, end]);
}

describe('ingestManifests', () => {
  it('imports Dataset Manifest v2 entries from .dtccpkg packages', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });
    writeJson(catalogPath, { version: 1, entries: [] });

    writeFileSync(
      join(sourceDir, 'roads.dtccpkg'),
      zip({
        'manifest.json': JSON.stringify({
          schema_version: 'dtcc-dataset-manifest-v2',
          identity: { name: 'roads', title: 'Roads PNG' },
          metadata: { description: 'Rendered road network.' },
          provenance: {},
          presentation: { view_hints: { profile: 'table', width: 320, height: 240 } },
          request: { bounds: [319720, 6397660, 320220, 6398160] },
          artifacts: [
            {
              path: 'artifacts/roads.png',
              role: 'primary',
              format: 'png',
              media_type: 'image/png',
              data_kind: 'raster',
              bounds: [319720, 6397660, 320220, 6398160],
            },
          ],
        }),
        'artifacts/roads.png': 'png',
      })
    );

    const result = await ingestManifests({ sourceDir, datasetsDir, catalogPath });

    expect(result.skipped).toEqual([]);
    expect(result.imported).toEqual([
      {
        id: 'roads',
        title: 'Roads PNG',
        description: 'Rendered road network.',
        file: 'roads.png',
        bounds: [319720, 6397660, 320220, 6398160],
        kind: 'image',
        format: 'png',
        mediaType: 'image/png',
        visualization: { profile: 'table', width: 320, height: 240 },
      },
    ]);
    expect(readFileSync(join(datasetsDir, 'roads.png'), 'utf8')).toBe('png');
    expect(readJson(catalogPath).entries[0].id).toBe('roads');
  });

  it('copies GeoJSON, PNG, and MP4 artifacts and upserts catalog entries from dtcc manifests', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });

    writeJson(catalogPath, {
      version: 1,
      entries: [
        {
          id: 'existing',
          title: 'Existing',
          file: 'existing.geojson',
          bounds: [1, 2, 3, 4],
        },
      ],
    });
    writeFileSync(join(sourceDir, 'smoke_slice.geojson'), '{"type":"FeatureCollection","features":[]}\n', 'utf8');
    writeJson(join(sourceDir, 'smoke_slice.manifest.json'), {
      name: 'smoke',
      title: 'Smoke Slice',
      description: 'Smoke data prepared for Atlas++.',
      file: 'smoke_slice.geojson',
      format: 'geojson',
      data_kind: 'vector',
      product: 'slice',
      bounds: [319720, 6397660, 320220, 6398160],
    });
    writeFileSync(join(sourceDir, 'smoke_streamlines.png'), 'png', 'utf8');
    writeJson(join(sourceDir, 'smoke_streamlines.manifest.json'), {
      title: 'Smoke Streamlines PNG',
      file: 'smoke_streamlines.png',
      format: 'png',
      media_type: 'image/png',
      data_kind: 'raster',
      product: 'streamlines',
      bounds: [319720, 6397660, 320220, 6398160],
      visualization: { profile: 'table', width: 320, height: 240 },
    });
    writeFileSync(join(sourceDir, 'smoke_streamlines.mp4'), 'mp4', 'utf8');
    writeJson(join(sourceDir, 'smoke_streamlines_video.manifest.json'), {
      id: 'smoke-streamlines-video',
      title: 'Smoke Streamlines MP4',
      file: 'smoke_streamlines.mp4',
      format: 'mp4',
      media_type: 'video/mp4',
      data_kind: 'video',
      product: 'streamlines',
      bounds: [319720, 6397660, 320220, 6398160],
      visualization: { profile: 'table', width: 320, height: 240, fps: 12, duration: 2 },
    });

    const result = await ingestManifests({ sourceDir, datasetsDir, catalogPath });

    expect(result.imported.map((entry) => entry.id)).toEqual([
      'smoke-slice',
      'smoke-streamlines',
      'smoke-streamlines-video',
    ]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(datasetsDir, 'smoke_slice.geojson'))).toBe(true);
    expect(existsSync(join(datasetsDir, 'smoke_streamlines.png'))).toBe(true);
    expect(existsSync(join(datasetsDir, 'smoke_streamlines.mp4'))).toBe(true);

    const catalog = readJson(catalogPath);
    expect(catalog).toEqual({
      version: 1,
      entries: [
        {
          id: 'existing',
          title: 'Existing',
          file: 'existing.geojson',
          bounds: [1, 2, 3, 4],
        },
        {
          id: 'smoke-slice',
          title: 'Smoke Slice',
          description: 'Smoke data prepared for Atlas++.',
          file: 'smoke_slice.geojson',
          bounds: [319720, 6397660, 320220, 6398160],
          kind: 'geojson',
          format: 'geojson',
        },
        {
          id: 'smoke-streamlines',
          title: 'Smoke Streamlines PNG',
          file: 'smoke_streamlines.png',
          bounds: [319720, 6397660, 320220, 6398160],
          kind: 'image',
          format: 'png',
          mediaType: 'image/png',
          visualization: { profile: 'table', width: 320, height: 240 },
        },
        {
          id: 'smoke-streamlines-video',
          title: 'Smoke Streamlines MP4',
          file: 'smoke_streamlines.mp4',
          bounds: [319720, 6397660, 320220, 6398160],
          kind: 'video',
          format: 'mp4',
          mediaType: 'video/mp4',
          visualization: { profile: 'table', width: 320, height: 240, fps: 12, duration: 2 },
        },
      ],
    });
  });

  it('updates an existing entry without duplicating it', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });

    writeJson(catalogPath, {
      version: 1,
      entries: [
        {
          id: 'smoke-slice',
          title: 'Old Smoke Slice',
          file: 'old.geojson',
          bounds: [0, 0, 1, 1],
        },
      ],
    });
    writeFileSync(join(sourceDir, 'smoke_slice.geojson'), '{"type":"FeatureCollection","features":[]}\n', 'utf8');
    writeJson(join(sourceDir, 'smoke_slice.manifest.json'), {
      id: 'smoke-slice',
      title: 'Smoke Slice',
      file: 'smoke_slice.geojson',
      format: 'geojson',
      bounds: [319720, 6397660, 320220, 6398160],
    });

    await ingestManifests({ sourceDir, datasetsDir, catalogPath });

    const catalog = readJson(catalogPath);
    expect(catalog.entries.filter((entry) => entry.id === 'smoke-slice')).toHaveLength(1);
    expect(catalog.entries[0]).toEqual({
      id: 'smoke-slice',
      title: 'Smoke Slice',
      file: 'smoke_slice.geojson',
      bounds: [319720, 6397660, 320220, 6398160],
      kind: 'geojson',
      format: 'geojson',
    });
  });

  it('skips unsupported manifest formats without copying artifacts', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });
    writeJson(catalogPath, { version: 1, entries: [] });
    writeFileSync(join(sourceDir, 'field.vtu'), 'vtu', 'utf8');
    writeJson(join(sourceDir, 'field.manifest.json'), {
      title: 'Smoke Field VTU',
      file: 'field.vtu',
      format: 'vtu',
      media_type: 'model/vnd.vtu',
      bounds: [319720, 6397660, 320220, 6398160],
    });

    const result = await ingestManifests({ sourceDir, datasetsDir, catalogPath });

    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([
      {
        manifest: join(sourceDir, 'field.manifest.json'),
        reason: 'format vtu is not supported by the Atlas catalog',
      },
    ]);
    expect(existsSync(join(datasetsDir, 'field.vtu'))).toBe(false);
  });

  it('rejects supported media manifests with mismatched media_type', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });
    writeJson(catalogPath, { version: 1, entries: [] });
    writeFileSync(join(sourceDir, 'smoke.png'), 'png', 'utf8');
    writeJson(join(sourceDir, 'smoke.manifest.json'), {
      title: 'Smoke PNG',
      file: 'smoke.png',
      format: 'png',
      media_type: 'video/mp4',
      data_kind: 'raster',
      bounds: [319720, 6397660, 320220, 6398160],
    });

    await expect(ingestManifests({ sourceDir, datasetsDir, catalogPath })).rejects.toThrow(/media_type/);
  });

  it('rejects manifests without numeric four-value bounds', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });
    writeJson(catalogPath, { version: 1, entries: [] });
    writeFileSync(join(sourceDir, 'smoke_slice.geojson'), '{"type":"FeatureCollection","features":[]}\n', 'utf8');
    writeJson(join(sourceDir, 'smoke_slice.manifest.json'), {
      title: 'Smoke Slice',
      file: 'smoke_slice.geojson',
      format: 'geojson',
      bounds: [319720, 6397660, 320220],
    });

    await expect(ingestManifests({ sourceDir, datasetsDir, catalogPath })).rejects.toThrow(/bounds/);
  });

  it('rejects Windows-style traversal before resolving the artifact path', async () => {
    const root = makeTempRoot();
    const sourceDir = join(root, 'exports');
    const datasetsDir = join(root, 'public', 'datasets');
    const catalogPath = join(datasetsDir, 'catalog.json');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(datasetsDir, { recursive: true });
    writeJson(catalogPath, { version: 1, entries: [] });
    writeJson(join(sourceDir, 'smoke.manifest.json'), {
      title: 'Smoke PNG',
      file: '..\\secret.png',
      format: 'png',
      media_type: 'image/png',
      data_kind: 'raster',
      bounds: [319720, 6397660, 320220, 6398160],
    });

    await expect(ingestManifests({ sourceDir, datasetsDir, catalogPath })).rejects.toThrow(/file must be relative/);
  });
});
