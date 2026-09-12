<script lang="ts">
  import type { CatalogEntry } from './catalog';
  import {
    findManifestArtifact,
    isDtccManifestFile,
    isDtccPackageFile,
    parseDtccManifestText,
    resolveDtccManifestFolder,
    resolveDtccManifestFiles,
    resolveDtccPackageFiles,
    type DtccManifest,
    type DtccManifestFileSelection,
  } from './dtccManifest';
  import { validateGeoJSON, defaultStyle, featureCollectionBbox, type FeatureCollection } from './geojson';
  import {
    clearOnlineCatalogSettings,
    fetchOnlineArtifactBlob,
    fetchOnlineCatalog,
    fetchOnlineManifestText,
    fetchOnlineVersionDetail,
    findOnlineArtifactPath,
    loadOnlineCatalogSettings,
    normalizeOnlineBaseUrl,
    saveOnlineCatalogSettings,
    fetchOnlineConfig,
    type OnlineCatalogEntry,
    type OnlineCatalogSettings,
  } from './onlineCatalog';
  import { fetchStaticCatalog, loadImage, loadStaticSample, loadVideo } from './sampleCatalog';
  import type { Bbox, Dataset, DatasetContent } from './storage';

  type ControlPanelStatus = {
    samples: Array<{ id: string; title: string; kind: 'geojson' | 'image' | 'video' }>;
    samplesLoaded: boolean;
    samplesError: string | null;
    onlineDatasets: Array<{ id: string; title: string; kind: 'geojson' | 'image' | 'video'; format: 'geojson' | 'png' | 'mp4' }>;
    busy: boolean;
    busyReason?: 'staticSample' | 'folderManifest' | 'onlineCatalog' | 'onlineDataset' | 'remoteSample';
    error: string | null;
  };

  let {
    dataset,
    nextDisabled = false,
    autoHide = true,
    backHidden = false,
    onLoadDataset,
    onLoadSample = () => {},
    onClearDataset,
    onSetColor,
    onNext,
    onBack,
    onControlStatus = () => {},
    onSaveDefault,
    canSaveDefault = false,
    externalDatasetChangeRevision = 0,
    externalOnlineDatasetRequest = null,
  } = $props<{
    dataset: Dataset | null;
    nextDisabled?: boolean;
    autoHide?: boolean;
    backHidden?: boolean;
    onLoadDataset: (d: { filename: string; geojson: FeatureCollection; style: { color: string }; bounds: Bbox }) => void;
    onLoadSample?: (d: {
      filename: string;
      bounds: Bbox;
      catalogId?: string;
      title: string;
      description?: string;
      content: DatasetContent;
      persist?: boolean;
    }) => void;
    onClearDataset: () => void;
    onSetColor: (color: string) => void;
    onNext: () => void;
    onBack?: () => void;
    onControlStatus?: (status: ControlPanelStatus) => void;
    // Snapshot the current dataset + calibration as the startup default (#8).
    onSaveDefault?: () => void;
    canSaveDefault?: boolean;
    externalDatasetChangeRevision?: number;
    externalOnlineDatasetRequest?: { id: string; revision: number } | null;
  }>();

  let visible = $state(true);
  let hideTimer: number | null = null;
  let error = $state<string | null>(null);
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let folderInput = $state<HTMLInputElement | null>(null);
  let catalogEntries = $state<CatalogEntry[]>([]);
  let catalogLoaded = $state(false);
  let catalogError = $state<string | null>(null);
  let sampleLoading = $state(false);
  let pendingManifest = $state<DtccManifest | null>(null);
  let folderManifestSelections = $state<DtccManifestFileSelection[]>([]);
  let selectedFolderManifestId = $state('');
  let onlineBaseUrl = $state('');
  let onlineToken = $state('');
  let onlineEntries = $state<OnlineCatalogEntry[]>([]);
  // 'configured' when /datasets/online-config.json supplied the settings:
  // the manual URL/token inputs are hidden and the catalog list loads
  // automatically. 'resolving' until the config probe finishes, so the
  // manual inputs never flash on configured deployments.
  let onlineMode = $state<'resolving' | 'configured' | 'manual'>('resolving');
  let onlineAutoError = $state<string | null>(null);
  let onlineConfigSettings: OnlineCatalogSettings | null = null;
  let selectedOnlineId = $state('');
  let onlineListLoading = $state(false);
  let onlineDatasetLoading = $state(false);
  let onlineListGeneration = 0;
  let onlineDatasetGeneration = 0;
  let handledExternalOnlineDatasetRevision = 0;
  let localObjectUrl: string | null = null;

  type DatasetSource = 'fetch' | 'local' | 'samples';
  type PanelPosition = { x: number; y: number };
  type PanelDrag = {
    pointerId: number;
    offsetX: number;
    offsetY: number;
    target: HTMLElement;
  };

  const PANEL_POSITION_KEY = 'dtcc-atlaspp-mvp.controlPanelPosition';
  const PANEL_MARGIN = 16;

  let panelEl = $state<HTMLElement | null>(null);
  let position = $state<PanelPosition | null>(null);
  let panelDrag = $state<PanelDrag | null>(null);
  let activeDatasetSource = $state<DatasetSource>('fetch');
  const panelStyle = $derived(position ? `left: ${position.x}px; top: ${position.y}px;` : undefined);

  function clearHideTimer() {
    if (hideTimer != null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function pauseAutoHide() {
    visible = true;
    clearHideTimer();
  }

  function isPanelPosition(value: unknown): value is PanelPosition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.x === 'number' &&
      Number.isFinite(candidate.x) &&
      typeof candidate.y === 'number' &&
      Number.isFinite(candidate.y)
    );
  }

  function loadPanelPosition(): PanelPosition | null {
    const raw = localStorage.getItem(PANEL_POSITION_KEY);
    if (raw == null) return null;
    try {
      const parsed = JSON.parse(raw);
      return isPanelPosition(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function clampPanelPosition(next: PanelPosition): PanelPosition {
    const rect = panelEl?.getBoundingClientRect();
    const width = rect?.width ?? 320;
    const height = rect?.height ?? 0;
    const maxX = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
    const maxY = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);

    return {
      x: Math.min(Math.max(next.x, PANEL_MARGIN), maxX),
      y: Math.min(Math.max(next.y, PANEL_MARGIN), maxY),
    };
  }

  function savePanelPosition(next: PanelPosition) {
    const clamped = clampPanelPosition(next);
    position = clamped;
    localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(clamped));
  }

  function reclampSavedPanelPosition() {
    if (!position) return;
    const clamped = clampPanelPosition(position);
    if (clamped.x === position.x && clamped.y === position.y) return;
    position = clamped;
    localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(clamped));
  }

  function isInteractivePanelTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      !!target.closest('button,input,select,textarea,a,[role="button"]')
    );
  }

  function startPanelDrag(e: PointerEvent) {
    if (e.button !== 0) return;
    if (!panelEl || isInteractivePanelTarget(e.target)) return;

    e.preventDefault();
    const rect = panelEl.getBoundingClientRect();
    const origin = clampPanelPosition(position ?? { x: rect.left, y: rect.top });
    const target = e.currentTarget as HTMLElement;

    position = origin;
    panelDrag = {
      pointerId: e.pointerId,
      offsetX: e.clientX - origin.x,
      offsetY: e.clientY - origin.y,
      target,
    };
    target.setPointerCapture(e.pointerId);
    pauseAutoHide();
  }

  function movePanel(e: PointerEvent) {
    if (!panelDrag || e.pointerId !== panelDrag.pointerId) return;
    position = clampPanelPosition({
      x: e.clientX - panelDrag.offsetX,
      y: e.clientY - panelDrag.offsetY,
    });
    pauseAutoHide();
  }

  function endPanelDrag(e: PointerEvent) {
    if (!panelDrag || e.pointerId !== panelDrag.pointerId) return;
    const drag = panelDrag;
    if (drag.target.hasPointerCapture(e.pointerId)) {
      drag.target.releasePointerCapture(e.pointerId);
    }
    panelDrag = null;
    if (position) savePanelPosition(position);
    resetTimer();
  }

  function openFilePicker() {
    pauseAutoHide();
    if (!fileInput) return;
    fileInput.value = '';
    fileInput.click();
  }

  function openFolderPicker() {
    pauseAutoHide();
    if (!folderInput) return;
    folderInput.value = '';
    folderInput.click();
  }

  function resetTimer() {
    visible = true;
    clearHideTimer();
    if (!autoHide) return;
    hideTimer = window.setTimeout(() => (visible = false), 5000);
  }

  function setDatasetSource(source: DatasetSource) {
    activeDatasetSource = source;
    pauseAutoHide();
  }

  const activeCatalogEntry = $derived(
    catalogEntries.find((entry) => entry.id === dataset?.catalogId) ?? null
  );
  const selectedOnlineEntry = $derived(
    onlineEntries.find((entry) => entry.id === selectedOnlineId) ?? null
  );
  const selectedCatalogId = $derived(activeCatalogEntry?.id ?? '');
  const colorValue = $derived(dataset?.content.kind === 'geojson' ? dataset.content.style.color : '#38bdf8');

  $effect(() => {
    if (!autoHide) {
      visible = true;
      clearHideTimer();
      return;
    }
    window.addEventListener('pointermove', resetTimer);
    resetTimer();
    return () => {
      window.removeEventListener('pointermove', resetTimer);
      clearHideTimer();
    };
  });

  $effect(() => {
    const saved = loadPanelPosition();
    if (saved) position = clampPanelPosition(saved);

    function onResize() {
      reclampSavedPanelPosition();
    }

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  });

  $effect(() => {
    if (!panelEl) return;
    const observer = new ResizeObserver(reclampSavedPanelPosition);
    observer.observe(panelEl);
    return () => observer.disconnect();
  });

  $effect(() => {
    let cancelled = false;

    async function loadCatalog() {
      catalogLoaded = false;
      catalogError = null;
      const result = await fetchStaticCatalog();
      if (cancelled) return;
      if (result.ok) {
        catalogEntries = result.value.entries;
      } else {
        catalogEntries = [];
        catalogError = result.error;
      }
      catalogLoaded = true;
    }

    loadCatalog();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const saved = loadOnlineCatalogSettings();
    onlineBaseUrl = saved.baseUrl;
    onlineToken = saved.token;
  });

  // Deployment config takes precedence over saved manual settings; either
  // way the catalog list is fetched automatically on mount so end users (and
  // the iPad remote, which cannot enter URL/token) get a populated picker
  // without clicking Fetch. Failures stay quiet — the projector must keep
  // working offline with the Samples/Local tabs.
  $effect(() => {
    let cancelled = false;

    async function initOnlineCatalog() {
      const config = await fetchOnlineConfig();
      if (cancelled) return;
      if (config) {
        onlineMode = 'configured';
        onlineConfigSettings = config;
        // The in-memory settings drive dataset selection fetches; they are
        // deliberately never persisted, so deleting or rotating the config
        // file fully revokes the token on the next load.
        onlineBaseUrl = config.baseUrl;
        onlineToken = config.token;
        await handleOnlineFetch({ quiet: true, settings: config });
      } else {
        onlineMode = 'manual';
        const saved = loadOnlineCatalogSettings();
        if (saved.baseUrl.trim().length > 0 && saved.token.trim().length > 0) {
          await handleOnlineFetch({ quiet: true, settings: saved });
        }
      }
    }

    initOnlineCatalog();
    return () => {
      cancelled = true;
    };
  });

  function revokeLocalObjectUrl() {
    if (!localObjectUrl) return;
    URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = null;
  }

  function rememberLocalObjectUrl(src: string) {
    revokeLocalObjectUrl();
    localObjectUrl = src;
  }

  function isMediaArtifactFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.png') || name.endsWith('.mp4') || file.type === 'image/png' || file.type === 'video/mp4';
  }

  function isGeoJsonFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return (name.endsWith('.geojson') || name.endsWith('.json')) && !isDtccManifestFile(file);
  }

  function clearFolderManifestSelections() {
    folderManifestSelections = [];
    selectedFolderManifestId = '';
  }

  function clearOnlineDatasetSelection() {
    selectedOnlineId = '';
    onlineDatasetGeneration++;
    onlineDatasetLoading = false;
  }

  $effect(() => {
    onControlStatus({
      samples: catalogEntries.map((entry) => ({ id: entry.id, title: entry.title, kind: entry.kind })),
      samplesLoaded: catalogLoaded,
      samplesError: catalogError,
      onlineDatasets: onlineEntries.map((entry) => ({ id: entry.id, title: entry.title, kind: entry.kind, format: entry.format })),
      busy: sampleLoading || onlineListLoading || onlineDatasetLoading,
      busyReason: sampleLoading ? 'staticSample' : onlineDatasetLoading ? 'onlineDataset' : onlineListLoading ? 'onlineCatalog' : undefined,
      error,
    });
  });

  $effect(() => {
    if (externalDatasetChangeRevision === 0) return;
    pendingManifest = null;
    clearFolderManifestSelections();
    clearOnlineDatasetSelection();
    revokeLocalObjectUrl();
  });

  $effect(() => {
    const request = externalOnlineDatasetRequest;
    if (!request || request.revision === handledExternalOnlineDatasetRevision) return;
    const entry = onlineEntries.find((candidate) => candidate.id === request.id);
    if (!entry) {
      if (onlineEntries.length > 0) {
        handledExternalOnlineDatasetRevision = request.revision;
        error = `unknown online dataset ${request.id}`;
      }
      return;
    }

    handledExternalOnlineDatasetRevision = request.revision;
    selectedOnlineId = entry.id;
    error = null;
    pendingManifest = null;
    clearFolderManifestSelections();
    onlineDatasetLoading = true;
    const generation = ++onlineDatasetGeneration;
    loadOnlineDataset(entry, generation)
      .catch((err) => {
        if (generation === onlineDatasetGeneration) error = (err as Error).message;
      })
      .finally(() => {
        if (generation === onlineDatasetGeneration) {
          onlineDatasetLoading = false;
          resetTimer();
        }
      });
  });

  function folderManifestId(selection: DtccManifestFileSelection, index: number): string {
    return selection.manifestPath ?? `${selection.manifest.title}-${index}`;
  }

  async function loadFolderManifestSelection(selection: DtccManifestFileSelection) {
    if (!selection.artifact) {
      error = `manifest references ${selection.missingArtifact}; selected folder does not include it`;
      return;
    }
    error = null;
    await loadManifestArtifact(selection.manifest, selection.artifact);
  }

  // `settings` pins the quiet auto-fetch to validated config/saved values so
  // it never races in-progress typing, never rewrites the inputs, and never
  // persists anything; only an explicit manual Fetch saves settings.
  async function handleOnlineFetch({
    quiet = false,
    settings,
  }: { quiet?: boolean; settings?: OnlineCatalogSettings } = {}) {
    error = null;
    onlineAutoError = null;
    if (!quiet) {
      pendingManifest = null;
      clearFolderManifestSelections();
    }

    const normalized = normalizeOnlineBaseUrl(settings?.baseUrl ?? onlineBaseUrl);
    if (!normalized.ok) {
      if (!quiet) error = normalized.error;
      return;
    }
    const token = (settings?.token ?? onlineToken).trim();
    if (token.length === 0) {
      if (!quiet) error = 'enter online catalog URL and browse token';
      return;
    }

    if (!settings) {
      onlineBaseUrl = normalized.value;
      onlineToken = token;
      saveOnlineCatalogSettings({ baseUrl: normalized.value, token });
    }

    const generation = ++onlineListGeneration;
    onlineListLoading = true;
    selectedOnlineId = '';
    onlineDatasetGeneration++;
    onlineDatasetLoading = false;
    try {
      const result = await fetchOnlineCatalog({ baseUrl: normalized.value, token });
      if (generation !== onlineListGeneration) return;
      if (!result.ok) {
        onlineEntries = [];
        if (quiet) onlineAutoError = result.error;
        else error = result.error;
        return;
      }
      onlineEntries = result.value;
    } finally {
      if (generation === onlineListGeneration) {
        onlineListLoading = false;
        resetTimer();
      }
    }
  }

  function handleOnlineClear() {
    error = null;
    onlineBaseUrl = '';
    onlineToken = '';
    onlineEntries = [];
    selectedOnlineId = '';
    onlineListLoading = false;
    onlineDatasetLoading = false;
    onlineListGeneration++;
    onlineDatasetGeneration++;
    clearOnlineCatalogSettings();
    resetTimer();
  }

  async function loadOnlineDataset(entry: OnlineCatalogEntry, generation: number) {
    const settings = { baseUrl: onlineBaseUrl, token: onlineToken };

    const detail = await fetchOnlineVersionDetail(settings, entry);
    if (generation !== onlineDatasetGeneration) return;
    if (!detail.ok) {
      error = detail.error;
      return;
    }

    const manifestText = await fetchOnlineManifestText(settings, entry);
    if (generation !== onlineDatasetGeneration) return;
    if (!manifestText.ok) {
      error = manifestText.error;
      return;
    }

    const manifest = parseDtccManifestText('online manifest', manifestText.value);
    if (!manifest.ok) {
      error = manifest.error;
      return;
    }

    const artifactPath = findOnlineArtifactPath(detail.value, manifest.value.file);
    if (!artifactPath.ok) {
      error = artifactPath.error;
      return;
    }

    const artifact = await fetchOnlineArtifactBlob(settings, entry, artifactPath.value, manifestText.value);
    if (generation !== onlineDatasetGeneration) return;
    if (!artifact.ok) {
      error = artifact.error;
      return;
    }

    if (manifest.value.kind === 'geojson') {
      const result = validateGeoJSON(await artifact.value.text());
      if (generation !== onlineDatasetGeneration) return;
      if (!result.ok) {
        error = result.error;
        return;
      }
      revokeLocalObjectUrl();
      onLoadSample({
        filename: manifest.value.artifactName,
        bounds: manifest.value.bounds,
        title: manifest.value.title,
        ...(manifest.value.description !== undefined ? { description: manifest.value.description } : {}),
        content: { kind: 'geojson', geojson: result.value, style: defaultStyle() },
      });
      return;
    }

    const src = URL.createObjectURL(artifact.value);
    if (manifest.value.kind === 'image') {
      try {
        await loadImage(src);
      } catch (err) {
        URL.revokeObjectURL(src);
        throw err;
      }
      if (generation !== onlineDatasetGeneration) {
        URL.revokeObjectURL(src);
        return;
      }
      rememberLocalObjectUrl(src);
      onLoadSample({
        filename: manifest.value.artifactName,
        bounds: manifest.value.bounds,
        title: manifest.value.title,
        ...(manifest.value.description !== undefined ? { description: manifest.value.description } : {}),
        content: { kind: 'image', src, mediaType: 'image/png' },
        persist: false,
      });
      return;
    }

    try {
      await loadVideo(src);
    } catch (err) {
      URL.revokeObjectURL(src);
      throw err;
    }
    if (generation !== onlineDatasetGeneration) {
      URL.revokeObjectURL(src);
      return;
    }
    rememberLocalObjectUrl(src);
    onLoadSample({
      filename: manifest.value.artifactName,
      bounds: manifest.value.bounds,
      title: manifest.value.title,
      ...(manifest.value.description !== undefined ? { description: manifest.value.description } : {}),
      content: { kind: 'video', src, mediaType: 'video/mp4', muted: true, autoplay: true, loop: true },
      persist: false,
    });
  }

  async function handleOnlineDatasetChange(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    const entry = onlineEntries.find((candidate) => candidate.id === id);
    if (!entry) return;

    selectedOnlineId = id;
    error = null;
    pendingManifest = null;
    clearFolderManifestSelections();
    onlineDatasetLoading = true;
    const generation = ++onlineDatasetGeneration;
    try {
      await loadOnlineDataset(entry, generation);
    } catch (err) {
      if (generation === onlineDatasetGeneration) {
        error = (err as Error).message;
      }
    } finally {
      if (generation === onlineDatasetGeneration) {
        onlineDatasetLoading = false;
        resetTimer();
      }
    }
  }

  async function handleSampleChange(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    const entry = catalogEntries.find((candidate) => candidate.id === id);
    if (!entry) return;

    error = null;
    pendingManifest = null;
    clearFolderManifestSelections();
    clearOnlineDatasetSelection();
    sampleLoading = true;
    try {
      const result = await loadStaticSample(entry);
      if (!result.ok) {
        error = result.error;
        return;
      }
      revokeLocalObjectUrl();
      onLoadSample(result.payload);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      sampleLoading = false;
      resetTimer();
    }
  }

  async function handleGeoJsonFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      error = 'file too large (>10 MB); simplify the GeoJSON first';
      return;
    }
    const text = await file.text();
    const result = validateGeoJSON(text);
    if (!result.ok) {
      error = result.error;
      return;
    }
    const bounds = featureCollectionBbox(result.value);
    if (!bounds) {
      error = 'GeoJSON has no projectable coordinates';
      return;
    }
    clearFolderManifestSelections();
    clearOnlineDatasetSelection();
    revokeLocalObjectUrl();
    onLoadDataset({
      filename: file.name,
      geojson: result.value,
      style: defaultStyle(),
      bounds,
    });
  }

  async function loadManifestArtifact(manifest: DtccManifest, artifact: File) {
    pendingManifest = null;
    clearOnlineDatasetSelection();

    if (manifest.kind === 'geojson') {
      if (artifact.size > 10 * 1024 * 1024) {
        error = 'file too large (>10 MB); simplify the GeoJSON first';
        return;
      }
      const result = validateGeoJSON(await artifact.text());
      if (!result.ok) {
        error = result.error;
        return;
      }
      revokeLocalObjectUrl();
      onLoadSample({
        filename: artifact.name,
        bounds: manifest.bounds,
        title: manifest.title,
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        content: { kind: 'geojson', geojson: result.value, style: defaultStyle() },
      });
      return;
    }

    if (manifest.kind === 'image') {
      const src = URL.createObjectURL(artifact);
      try {
        await loadImage(src);
      } catch (err) {
        URL.revokeObjectURL(src);
        throw err;
      }
      rememberLocalObjectUrl(src);
      onLoadSample({
        filename: artifact.name,
        bounds: manifest.bounds,
        title: manifest.title,
        ...(manifest.description !== undefined ? { description: manifest.description } : {}),
        content: { kind: 'image', src, mediaType: 'image/png' },
        persist: false,
      });
      return;
    }

    const src = URL.createObjectURL(artifact);
    try {
      await loadVideo(src);
    } catch (err) {
      URL.revokeObjectURL(src);
      throw err;
    }
    rememberLocalObjectUrl(src);
    onLoadSample({
      filename: artifact.name,
      bounds: manifest.bounds,
      title: manifest.title,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      content: { kind: 'video', src, mediaType: 'video/mp4', muted: true, autoplay: true, loop: true },
      persist: false,
    });
  }

  async function handleFiles(inputFiles: FileList | File[]) {
    const files = Array.from(inputFiles);
    if (files.length === 0) return;

    error = null;
    clearFolderManifestSelections();

    try {
      if (pendingManifest) {
        const artifact = findManifestArtifact(files, pendingManifest);
        if (artifact) {
          await loadManifestArtifact(pendingManifest, artifact);
          return;
        }
        if (!files.some(isDtccManifestFile)) {
          if (files.length === 1 && isGeoJsonFile(files[0])) {
            pendingManifest = null;
            await handleGeoJsonFile(files[0]);
            return;
          }
          error = `manifest references ${pendingManifest.file}; select that file too`;
          return;
        }
      }

      if (files.some(isDtccPackageFile)) {
        const selection = await resolveDtccPackageFiles(files);
        if (!selection.ok) {
          error = selection.error;
          return;
        }
        folderManifestSelections = selection.value;
        if (selection.value.length === 1) {
          selectedFolderManifestId = folderManifestId(selection.value[0], 0);
          await loadFolderManifestSelection(selection.value[0]);
        } else {
          selectedFolderManifestId = '';
        }
        return;
      }

      if (files.some(isDtccManifestFile)) {
        const selection = await resolveDtccManifestFiles(files);
        if (!selection.ok) {
          error = selection.error;
          return;
        }
        if (!selection.value.artifact) {
          if (selection.value.manifest.kind === 'geojson') {
            pendingManifest = selection.value.manifest;
            error = `manifest references ${selection.value.missingArtifact}; select that GeoJSON file too`;
          } else {
            pendingManifest = null;
            error = `manifest references ${selection.value.missingArtifact}; pick the containing folder to load its media artifact`;
          }
          return;
        }
        await loadManifestArtifact(selection.value.manifest, selection.value.artifact);
        return;
      }

      const file = files[0];
      if (isMediaArtifactFile(file)) {
        error = `${file.name} needs its .dtccpkg or manifest file`;
        return;
      }
      await handleGeoJsonFile(file);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function handleFolderFiles(inputFiles: FileList | File[]) {
    const files = Array.from(inputFiles);
    if (files.length === 0) return;

    error = null;
    pendingManifest = null;

    try {
      const selection = await resolveDtccManifestFolder(files);
      if (!selection.ok) {
        clearFolderManifestSelections();
        error = selection.error;
        return;
      }

      folderManifestSelections = selection.value;
      if (selection.value.length === 1) {
        selectedFolderManifestId = folderManifestId(selection.value[0], 0);
        await loadFolderManifestSelection(selection.value[0]);
      } else {
        selectedFolderManifestId = '';
      }
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function handleFolderManifestChange(e: Event) {
    const id = (e.currentTarget as HTMLSelectElement).value;
    const index = folderManifestSelections.findIndex((selection, i) => folderManifestId(selection, i) === id);
    if (index === -1) return;

    selectedFolderManifestId = id;
    await loadFolderManifestSelection(folderManifestSelections[index]);
    resetTimer();
  }

  function handleClear() {
    error = null;
    pendingManifest = null;
    clearFolderManifestSelections();
    clearOnlineDatasetSelection();
    revokeLocalObjectUrl();
    onClearDataset();
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const files = e.dataTransfer?.files;
    if (files?.length) void handleFiles(files);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    activeDatasetSource = 'local';
    dragging = true;
  }

  function onDragLeave() {
    dragging = false;
  }

  async function onFileInput(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) await handleFiles(files);
    resetTimer();
  }

  async function onFolderInput(e: Event) {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) await handleFolderFiles(files);
    resetTimer();
  }

  $effect(() => {
    return () => revokeLocalObjectUrl();
  });
</script>

{#if visible}
  <section
    bind:this={panelEl}
    class="fixed {position === null ? 'bottom-4 right-4' : ''} w-80 bg-white/95 text-dtcc-dark rounded-lg shadow-xl p-4 pointer-events-auto z-50"
    style={panelStyle}
    aria-label="DTCC Atlas++ controls"
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    ondrop={onDrop}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <header
      class="flex items-center justify-between mb-2 cursor-move select-none touch-none"
      onpointerdown={startPanelDrag}
      onpointermove={movePanel}
      onpointerup={endPanelDrag}
      onpointercancel={endPanelDrag}
    >
      <h2 class="text-sm font-semibold">DTCC Atlas++ MVP</h2>
      {#if autoHide}
        <button class="text-xs text-dtcc-muted cursor-pointer" onclick={() => (visible = false)}>hide</button>
      {/if}
    </header>

    <div class="mb-3 border-t border-dtcc-border pt-3">
      <div class="flex gap-1 rounded bg-dtcc-gray-light p-1" role="tablist" aria-label="Dataset source">
        <button
          id="dataset-source-fetch-tab"
          type="button"
          role="tab"
          aria-selected={activeDatasetSource === 'fetch'}
          aria-controls="dataset-source-fetch"
          class="flex-1 rounded px-2 py-1 text-xs font-medium {activeDatasetSource === 'fetch' ? 'bg-dtcc-muted text-white' : 'text-dtcc-dark'}"
          onclick={() => setDatasetSource('fetch')}
        >
          Fetch
        </button>
        <button
          id="dataset-source-local-tab"
          type="button"
          role="tab"
          aria-selected={activeDatasetSource === 'local'}
          aria-controls="dataset-source-local"
          class="flex-1 rounded px-2 py-1 text-xs font-medium {activeDatasetSource === 'local' ? 'bg-dtcc-muted text-white' : 'text-dtcc-dark'}"
          onclick={() => setDatasetSource('local')}
        >
          Local
        </button>
        <button
          id="dataset-source-samples-tab"
          type="button"
          role="tab"
          aria-selected={activeDatasetSource === 'samples'}
          aria-controls="dataset-source-samples"
          aria-disabled={catalogEntries.length === 0}
          disabled={catalogEntries.length === 0}
          class="flex-1 rounded px-2 py-1 text-xs font-medium disabled:opacity-40 {activeDatasetSource === 'samples' ? 'bg-dtcc-muted text-white' : 'text-dtcc-dark'}"
          onclick={() => setDatasetSource('samples')}
        >
          Samples
        </button>
      </div>
      {#if catalogLoaded && catalogError}
        <p class="text-xs text-dtcc-red mt-2">{catalogError}</p>
      {/if}
    </div>

    {#if activeDatasetSource === 'fetch'}
      <div
        id="dataset-source-fetch"
        role="tabpanel"
        aria-labelledby="dataset-source-fetch-tab"
        class="mb-3"
      >
        <div class="text-xs font-medium mb-2">Online catalog</div>
        {#if onlineMode === 'configured'}
          {#if onlineListLoading && onlineEntries.length === 0}
            <p class="text-xs text-dtcc-muted">Loading datasets...</p>
          {:else if onlineEntries.length === 0}
            <p class="text-xs text-dtcc-muted">Online catalog unavailable</p>
            {#if onlineAutoError}
              <p class="text-xs text-dtcc-muted opacity-70">{onlineAutoError}</p>
            {/if}
            <button
              type="button"
              class="px-3 py-1 mt-1 text-xs rounded bg-dtcc-gray-light"
              onclick={() => onlineConfigSettings && handleOnlineFetch({ quiet: true, settings: onlineConfigSettings })}
            >
              Retry
            </button>
          {/if}
        {:else if onlineMode === 'resolving'}
          <p class="text-xs text-dtcc-muted">Loading datasets...</p>
        {:else}
        <label class="block text-xs text-dtcc-muted mb-1" for="online-catalog-url">Catalog URL</label>
        <input
          id="online-catalog-url"
          class="w-full text-xs rounded border border-dtcc-border bg-white px-2 py-1 mb-2"
          type="url"
          autocomplete="off"
          value={onlineBaseUrl}
          oninput={(e) => (onlineBaseUrl = (e.currentTarget as HTMLInputElement).value)}
        />
        <label class="block text-xs text-dtcc-muted mb-1" for="online-catalog-token">Browse token</label>
        <input
          id="online-catalog-token"
          class="w-full text-xs rounded border border-dtcc-border bg-white px-2 py-1 mb-2"
          type="password"
          autocomplete="off"
          value={onlineToken}
          oninput={(e) => (onlineToken = (e.currentTarget as HTMLInputElement).value)}
        />
        <div class="flex gap-2">
          <button
            type="button"
            class="px-3 py-1 text-xs rounded bg-dtcc-gray-light disabled:opacity-40"
            disabled={onlineListLoading}
            onclick={() => handleOnlineFetch()}
          >
            {onlineListLoading ? 'Fetching...' : 'Fetch'}
          </button>
          <button
            type="button"
            class="px-3 py-1 text-xs rounded bg-dtcc-gray-light"
            onclick={handleOnlineClear}
          >
            Clear
          </button>
        </div>
        {/if}
        {#if onlineEntries.length > 0}
          <label class="block text-xs font-medium mb-1 mt-2" for="online-dataset">Online dataset</label>
          <select
            id="online-dataset"
            class="w-full text-xs rounded border border-dtcc-border bg-white px-2 py-1 disabled:opacity-60"
            value={selectedOnlineId}
            disabled={onlineDatasetLoading}
            onchange={handleOnlineDatasetChange}
          >
            <option value="" disabled>{onlineDatasetLoading ? 'Loading...' : 'Select online dataset...'}</option>
            {#each onlineEntries as entry}
              <option value={entry.id}>{entry.title} ({entry.format.toUpperCase()})</option>
            {/each}
          </select>
          {#if onlineDatasetLoading}
            <p class="text-xs text-dtcc-muted mt-1">Loading...</p>
          {:else if selectedOnlineEntry}
            <p class="text-xs text-dtcc-muted mt-1">
              {selectedOnlineEntry.format.toUpperCase()}
              {selectedOnlineEntry.totalBytes ? ` - ${selectedOnlineEntry.totalBytes} bytes` : ''}
              {selectedOnlineEntry.fileCount ? ` - ${selectedOnlineEntry.fileCount} file${selectedOnlineEntry.fileCount === 1 ? '' : 's'}` : ''}
            </p>
          {/if}
        {/if}
      </div>
    {:else if activeDatasetSource === 'local'}
      <div
        id="dataset-source-local"
        role="tabpanel"
        aria-labelledby="dataset-source-local-tab"
        class="mb-3"
      >
        {#if folderManifestSelections.length > 1}
          <div class="mb-3">
            <label class="block text-xs font-medium mb-1" for="folder-manifest">Folder manifest</label>
            <select
              id="folder-manifest"
              class="w-full text-xs rounded border border-dtcc-border bg-white px-2 py-1"
              value={selectedFolderManifestId}
              onchange={handleFolderManifestChange}
            >
              <option value="" disabled>Select a manifest...</option>
              {#each folderManifestSelections as selection, i}
                <option value={folderManifestId(selection, i)}>
                  {selection.manifest.title} ({selection.manifest.format.toUpperCase()})
                </option>
              {/each}
            </select>
          </div>
        {/if}

        <div
          role="region"
          aria-label="Dataset drop zone"
          class="border-2 border-dashed rounded p-4 text-center text-sm transition-colors {dragging ? 'border-dtcc-orange bg-dtcc-orange/10' : 'border-dtcc-border'}"
        >
          {#if pendingManifest}
            <div class="font-medium truncate">Pick {pendingManifest.artifactName}</div>
            <div class="text-xs text-dtcc-muted mt-1">Referenced by {pendingManifest.title}</div>
          {:else if dataset}
            <div class="font-medium truncate">{dataset.filename}</div>
            <div class="text-xs text-dtcc-muted mt-1">Drop a new file to replace</div>
          {:else}
            <div class="font-medium">Drop a .dtccpkg, .geojson, or dtcc manifest here</div>
          {/if}
          <button
            type="button"
            class="text-xs text-dtcc-orange cursor-pointer underline mt-1 inline-block focus:outline-none focus:ring-2 focus:ring-dtcc-orange rounded"
            onclick={openFilePicker}
          >
            {pendingManifest ? `or pick ${pendingManifest.artifactName}` : dataset ? 'or pick different files' : 'or pick files'}
          </button>
          <button
            type="button"
            class="text-xs text-dtcc-orange cursor-pointer underline mt-1 ml-2 inline-block focus:outline-none focus:ring-2 focus:ring-dtcc-orange rounded"
            onclick={openFolderPicker}
          >
            pick a folder
          </button>
          <input
            bind:this={fileInput}
            type="file"
            multiple
            accept=".dtccpkg,.geojson,.json,.manifest.json,application/geo+json,application/json,application/zip"
            aria-label="Dataset files"
            class="sr-only"
            oncancel={resetTimer}
            onchange={onFileInput}
          />
          <input
            bind:this={folderInput}
            type="file"
            multiple
            webkitdirectory
            aria-label="Dataset folder"
            class="sr-only"
            oncancel={resetTimer}
            onchange={onFolderInput}
          />
        </div>
      </div>
    {:else if activeDatasetSource === 'samples' && catalogEntries.length > 0}
      <div
        id="dataset-source-samples"
        role="tabpanel"
        aria-labelledby="dataset-source-samples-tab"
        class="mb-3"
      >
        <label class="block text-xs font-medium mb-1" for="sample-dataset">Sample dataset</label>
        <select
          id="sample-dataset"
          class="w-full text-xs rounded border border-dtcc-border bg-white px-2 py-1 disabled:opacity-60"
          value={selectedCatalogId}
          disabled={sampleLoading}
          onchange={handleSampleChange}
        >
          <option value="" disabled>{sampleLoading ? 'Loading...' : 'Select a sample...'}</option>
          {#each catalogEntries as entry}
            <option value={entry.id}>{entry.title} ({entry.format.toUpperCase()})</option>
          {/each}
        </select>
        {#if sampleLoading}
          <p class="text-xs text-dtcc-muted mt-1">Loading...</p>
        {:else if activeCatalogEntry?.description}
          <p class="text-xs text-dtcc-muted mt-1">{activeCatalogEntry.description}</p>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="text-xs text-dtcc-red mt-2">{error}</p>
    {/if}

    {#if dataset === null || dataset.content.kind === 'geojson'}
      <div class="mt-3 flex items-center gap-2">
        <label class="text-xs flex items-center gap-2">
          Color
          <input
            type="color"
            value={colorValue}
            disabled={!dataset}
            onchange={(e) => onSetColor((e.currentTarget as HTMLInputElement).value)}
          />
        </label>
      </div>
    {/if}

    <div class="mt-3 flex gap-2">
      {#if onBack && !backHidden}
        <button
          class="px-3 py-1 text-xs rounded bg-dtcc-gray-light"
          onclick={onBack}
        >Back</button>
      {/if}
      <button
        class="px-3 py-1 text-xs rounded bg-dtcc-muted text-white disabled:opacity-40"
        disabled={nextDisabled}
        onclick={onNext}
      >Next</button>
      <button class="px-3 py-1 text-xs rounded bg-dtcc-gray-light disabled:opacity-40" disabled={!dataset} onclick={handleClear}>Clear</button>
      {#if onSaveDefault}
        <button
          class="px-3 py-1 text-xs rounded bg-dtcc-gray-light disabled:opacity-40"
          disabled={!canSaveDefault}
          title="Use the current dataset and calibration on every startup"
          onclick={onSaveDefault}
        >Set startup default</button>
      {/if}
    </div>
  </section>
{/if}
