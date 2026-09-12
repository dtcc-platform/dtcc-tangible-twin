import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  clearOnlineCatalogSettings,
  fetchOnlineArtifactBlob,
  fetchOnlineArtifactUrl,
  fetchOnlineCatalog,
  fetchOnlineCatalogUrl,
  fetchOnlineConfig,
  fetchOnlineManifestText,
  fetchOnlineManifestUrl,
  fetchOnlineVersionDetail,
  fetchOnlineVersionDetailUrl,
  findOnlineArtifactPath,
  loadOnlineCatalogSettings,
  normalizeOnlineBaseUrl,
  parseOnlineCatalogResponse,
  parseOnlineVersionDetailResponse,
  saveOnlineCatalogSettings,
  type OnlineCatalogEntry,
} from '../src/lib/onlineCatalog';

const entry: OnlineCatalogEntry = {
  id: 'smoke/slice@v 1',
  datasetKey: 'smoke/slice',
  versionId: 'v 1',
  title: 'Smoke Slice',
  bounds: [0, 0, 1, 1],
  kind: 'geojson',
  format: 'geojson',
  mediaType: 'application/geo+json',
};

const baseRow = {
  dataset_key: 'smoke-slice',
  owner_principal_id: 'vasnas',
  latest_committed_version_id: 'v1',
  version_id: 'v1',
  version_number: 1,
  status: 'committed',
  product: 'slice',
  title: 'Smoke Slice',
  bounds_json: '[0.0, 0.0, 1.0, 1.0]',
  total_bytes: 28,
  file_count: 1,
  committed_at: '2026-05-13 12:00:00',
};

describe('online catalog settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips saved settings under namespaced keys', () => {
    saveOnlineCatalogSettings({ baseUrl: 'http://127.0.0.1:8000', token: 'browser-token' });

    expect(localStorage.getItem('dtcc-atlaspp-mvp.onlineCatalog.baseUrl')).toBe('http://127.0.0.1:8000');
    expect(localStorage.getItem('dtcc-atlaspp-mvp.onlineCatalog.token')).toBe('browser-token');
    expect(loadOnlineCatalogSettings()).toEqual({
      baseUrl: 'http://127.0.0.1:8000',
      token: 'browser-token',
    });
  });

  it('clears saved settings', () => {
    saveOnlineCatalogSettings({ baseUrl: 'http://127.0.0.1:8000', token: 'browser-token' });

    clearOnlineCatalogSettings();

    expect(loadOnlineCatalogSettings()).toEqual({ baseUrl: '', token: '' });
  });
});

describe('online catalog URLs', () => {
  it('normalizes a valid base URL by trimming and removing trailing slashes', () => {
    expect(normalizeOnlineBaseUrl('  http://127.0.0.1:8000///  ')).toEqual({
      ok: true,
      value: 'http://127.0.0.1:8000',
    });
  });

  it('rejects invalid base URLs', () => {
    expect(normalizeOnlineBaseUrl('not a url')).toEqual({
      ok: false,
      error: 'online catalog URL is invalid',
    });
  });

  it('builds browse, detail, and manifest URLs with encoded dataset keys and version IDs', () => {
    const baseUrl = 'http://127.0.0.1:8000';

    expect(fetchOnlineCatalogUrl(baseUrl).href).toBe('http://127.0.0.1:8000/v1/datasets?limit=100');
    expect(fetchOnlineVersionDetailUrl(baseUrl, entry).href).toBe(
      'http://127.0.0.1:8000/v1/datasets/smoke%2Fslice/versions/v%201'
    );
    expect(fetchOnlineManifestUrl(baseUrl, entry).href).toBe(
      'http://127.0.0.1:8000/v1/datasets/smoke%2Fslice/versions/v%201/manifest'
    );
  });

  it('preserves path-prefixed base URLs', () => {
    expect(fetchOnlineCatalogUrl('https://example.com/api').href).toBe('https://example.com/api/v1/datasets?limit=100');
  });

  it('encodes artifact paths per segment without collapsing slashes to %2F', () => {
    expect(fetchOnlineArtifactUrl('http://127.0.0.1:8000', entry, 'media/smoke slice.geojson').href).toBe(
      'http://127.0.0.1:8000/v1/datasets/smoke%2Fslice/versions/v%201/files/media/smoke%20slice.geojson'
    );
  });
});

describe('parseOnlineCatalogResponse', () => {
  it('maps supported GeoJSON, PNG, and MP4 rows', () => {
    const result = parseOnlineCatalogResponse({
      items: [
        { ...baseRow, format: 'geojson', media_type: 'application/geo+json', data_kind: 'vector' },
        {
          ...baseRow,
          dataset_key: 'smoke-png',
          version_id: 'v2',
          format: 'png',
          media_type: 'image/png',
          data_kind: 'raster',
        },
        {
          ...baseRow,
          dataset_key: 'smoke-mp4',
          version_id: 'v3',
          format: 'mp4',
          media_type: 'video/mp4',
          data_kind: 'video',
        },
      ],
      next_cursor: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((mapped) => [mapped.id, mapped.kind, mapped.format, mapped.mediaType])).toEqual([
      ['smoke-slice@v1', 'geojson', 'geojson', 'application/geo+json'],
      ['smoke-png@v2', 'image', 'png', 'image/png'],
      ['smoke-mp4@v3', 'video', 'mp4', 'video/mp4'],
    ]);
    expect(result.value[0].bounds).toEqual([0, 0, 1, 1]);
    expect(result.value[0].totalBytes).toBe(28);
    expect(result.value[0].fileCount).toBe(1);
  });

  it('filters unsupported formats and rows with unusable bounds', () => {
    const result = parseOnlineCatalogResponse({
      items: [
        { ...baseRow, dataset_key: 'vtu', format: 'vtu', media_type: 'model/vtu', data_kind: 'mesh' },
        {
          ...baseRow,
          dataset_key: 'bad-bounds',
          format: 'geojson',
          media_type: 'application/geo+json',
          data_kind: 'vector',
          bounds_json: '[0, 1]',
        },
        {
          ...baseRow,
          dataset_key: 'nan-bounds',
          format: 'geojson',
          media_type: 'application/geo+json',
          data_kind: 'vector',
          bounds_json: '[0, 1, 2, null]',
        },
        { ...baseRow, dataset_key: 'good', format: 'geojson', media_type: 'application/json', data_kind: 'vector' },
      ],
      next_cursor: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((mapped) => mapped.datasetKey)).toEqual(['good']);
  });

  it('returns an empty supported-list error when no supported rows remain', () => {
    const result = parseOnlineCatalogResponse({
      items: [{ ...baseRow, format: 'dtcc', media_type: 'application/vnd.dtcc.model+protobuf', data_kind: 'model' }],
      next_cursor: null,
    });

    expect(result).toEqual({
      ok: false,
      error: 'online catalog has no supported GeoJSON, PNG, or MP4 datasets',
    });
  });

  it('rejects malformed catalog response shapes', () => {
    expect(parseOnlineCatalogResponse({ items: 'nope' })).toEqual({
      ok: false,
      error: 'online catalog response is invalid',
    });
  });
});

describe('online catalog network helpers', () => {
  it('discovers a canonical preview and rejects a corrupted downloaded artifact', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const manifest = {
      schema_version: 'dtcc-dataset-manifest-v3', identity: { name: 'test', title: 'Test' },
      request: { bounds: [0, 0, 1, 1] }, artifacts: [
        { path: 'artifacts/model.dtcc', role: 'canonical_model', format: 'dtcc',
          media_type: 'application/vnd.dtcc.model+protobuf', data_kind: 'model',
          model_type: 'Raster', model_schema_version: 6, size: 5, sha256: digest('model') },
        { path: 'artifacts/preview.png', role: 'derived', derived_from: 'artifacts/model.dtcc',
          format: 'png', media_type: 'image/png', data_kind: 'raster', size: 3, sha256: digest('png') },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (url) => String(url).endsWith('/manifest')
      ? new Response(JSON.stringify(manifest))
      : new Response(JSON.stringify({ items: [{ ...baseRow, format: 'dtcc', data_kind: 'model' }] }))));
    const settings = { baseUrl: 'https://example.test', token: 'test-token' };
    const listed = await fetchOnlineCatalog(settings);
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value[0].format).toBe('png');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('png')));
    expect((await fetchOnlineArtifactBlob(settings, listed.value[0], 'artifacts/preview.png', JSON.stringify(manifest))).ok).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad')));
    const invalid = await fetchOnlineArtifactBlob(settings, listed.value[0], 'artifacts/preview.png', JSON.stringify(manifest));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toContain('sha256');
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends bearer auth and parses the online catalog list', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ ...baseRow, format: 'geojson', media_type: 'application/geo+json', data_kind: 'vector' }],
            next_cursor: null,
          })
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchOnlineCatalog({ baseUrl: 'http://127.0.0.1:8000', token: 'browser-token' });

    expect(result.ok).toBe(true);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect((calledUrl as URL).href).toBe('http://127.0.0.1:8000/v1/datasets?limit=100');
    expect(calledInit).toEqual({ headers: { Authorization: 'Bearer browser-token' } });
  });

  it('returns useful errors for non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })));

    await expect(fetchOnlineCatalog({ baseUrl: 'http://127.0.0.1:8000', token: 'bad' })).resolves.toEqual({
      ok: false,
      error: 'online catalog fetch failed (401 Unauthorized)',
    });
  });

  it('omits the status text spacing when the browser response has no statusText', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401, statusText: '' })));

    await expect(fetchOnlineCatalog({ baseUrl: 'http://127.0.0.1:8000', token: 'bad' })).resolves.toEqual({
      ok: false,
      error: 'online catalog fetch failed (401)',
    });
  });

  it('prefixes network failures with an online catalog message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    await expect(fetchOnlineCatalog({ baseUrl: 'http://127.0.0.1:8000', token: 'bad' })).resolves.toEqual({
      ok: false,
      error: 'online catalog request failed: Failed to fetch',
    });
  });

  it('parses version detail file records', () => {
    const result = parseOnlineVersionDetailResponse({
      version: {},
      files: [{ path: 'media/smoke.geojson' }],
    });

    expect(result).toEqual({ ok: true, value: [{ path: 'media/smoke.geojson' }] });
  });

  it('fetches version detail with bearer auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ version: {}, files: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchOnlineVersionDetail({ baseUrl: 'http://127.0.0.1:8000', token: 'browser-token' }, entry)
    ).resolves.toEqual({ ok: true, value: [] });

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect((calledUrl as URL).href).toBe('http://127.0.0.1:8000/v1/datasets/smoke%2Fslice/versions/v%201');
    expect(calledInit).toEqual({ headers: { Authorization: 'Bearer browser-token' } });
  });

  it('returns manifest/detail mismatch when the referenced artifact is absent', () => {
    expect(findOnlineArtifactPath([{ path: 'other.geojson' }], 'media/smoke.geojson')).toEqual({
      ok: false,
      error: 'manifest references media/smoke.geojson; online version does not include it',
    });
  });

  it('fetches manifest text with bearer auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"file":"media/smoke.geojson"}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchOnlineManifestText({ baseUrl: 'http://127.0.0.1:8000', token: 'browser-token' }, entry)
    ).resolves.toEqual({
      ok: true,
      value: '{"file":"media/smoke.geojson"}',
    });

    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect((calledUrl as URL).href).toBe('http://127.0.0.1:8000/v1/datasets/smoke%2Fslice/versions/v%201/manifest');
    expect(calledInit).toEqual({ headers: { Authorization: 'Bearer browser-token' } });
  });

  it('fetches artifact blobs with bearer auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(new Blob(['{}'], { type: 'application/geo+json' }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const blobResult = await fetchOnlineArtifactBlob(
      { baseUrl: 'http://127.0.0.1:8000', token: 'browser-token' },
      entry,
      'media/smoke.geojson'
    );

    expect(blobResult.ok).toBe(true);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect((calledUrl as URL).href).toBe(
      'http://127.0.0.1:8000/v1/datasets/smoke%2Fslice/versions/v%201/files/media/smoke.geojson'
    );
    expect(calledInit).toEqual({ headers: { Authorization: 'Bearer browser-token' } });
  });
});

describe('fetchOnlineConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns normalized settings from the deployment config file', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ baseUrl: 'https://catalog.example/', token: ' browse-tok ' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchOnlineConfig()).toEqual({ baseUrl: 'https://catalog.example', token: 'browse-tok' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/datasets/online-config.json');
  });

  it('returns null when the config file is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    expect(await fetchOnlineConfig()).toBeNull();
  });

  it('returns null when the config shape is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ baseUrl: 'https://catalog.example' }))));
    expect(await fetchOnlineConfig()).toBeNull();
  });

  it('returns null when the base URL is invalid or the token empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ baseUrl: 'not a url', token: 'tok' }))));
    expect(await fetchOnlineConfig()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ baseUrl: 'https://catalog.example', token: '  ' }))));
    expect(await fetchOnlineConfig()).toBeNull();
  });

  it('returns null when the config request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await fetchOnlineConfig()).toBeNull();
  });
});
