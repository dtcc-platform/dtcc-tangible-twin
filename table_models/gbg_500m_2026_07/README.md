# Gothenburg 500 m Table Profile

This profile describes the 500 m x 500 m Gothenburg tangible-table model used
by the Atlas projector workflow.

## Physical Model

- Model id: `gbg_500m_2026_07`
- CRS: `EPSG:3006`
- Bounds: `[319720, 6397660, 320220, 6398160]`
- Physical table size: `400 mm x 400 mm`
- Scale: `1:1250`
- Output directory: `temp/table_catalog/gbg_500m_2026_07`

Generated output under `temp/` is local build evidence and must not be
committed.

## Generate Packages

The default catalog is media-first: each default dataset becomes one canonical
`.dtccpkg` Dataset Manifest v2 archive. The archive is a zip file with
`manifest.json` and one table-facing artifact under `artifacts/`:

```text
temp/table_catalog/gbg_500m_2026_07/roads.dtccpkg
  manifest.json
  artifacts/roads.png
```

The generator uses temporary package directories internally while validating,
but only `.dtccpkg` files and `generation_report.json` remain in the output
directory. Publishing extracts each `.dtccpkg` and uploads the manifest plus
artifact files through `dtcc-upload`.

Preview the default catalog without writing output:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --dry-run
```

Generate the default catalog:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --clean
```

Generate the larger development catalog:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --include dev --clean
```

Check credentialed/live entries and fail if credentials are missing:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --include credentialed --strict --dry-run
```

Check simulation entries without running them:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --include simulation --dry-run
```

Run expensive entries only after accepting their runtime/dependency cost:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --include expensive --run-expensive --clean
```

Publishing is explicit. `--publish` requires `DTCC_UPLOAD_URL` and
`DTCC_UPLOAD_TOKEN`, and each dataset still respects its own `table.publish`
flag.

```bash
DTCC_UPLOAD_URL=https://upload.example DTCC_UPLOAD_TOKEN=... \
  python scripts/generate_table_catalog.py gbg_500m_2026_07 --publish --clean
```

## Dataset Sets

| Set | Dataset ids | Purpose |
|---|---|---|
| default | `calibration_grid`, `smoke_slice`, `smoke_streamlines`, `smoke_streamlines_mp4`, `building_footprints`, `roads`, `space_syntax`, `deso_population`, `weather_temperature`, `air_quality_no2`, `hydrology_discharge`, `ocean_sea_level`, `transit_vehicles_buses`, `trees`, `terrain_surface_mesh`, `city_surface_mesh` | Canonical table media packages for every current `dtcc-core` demo story, rendered against the printed-model bounds. |
| `dev` | `smoke_slice_geojson`, `smoke_streamlines_geojson`, `smoke_field_vtu`, `smoke_field_dtcc` | Raw/debug smoke artifacts for local package inspection and serializer checks. |
| `credentialed` | no additional dataset ids; default `transit_vehicles_buses` requires `VASTTRAFIK_AUTHENTICATION_KEY` | Credential checks for the default live-bus layer. |
| `simulation` | `traffic_simulation_dtcc` | dtcc-sim traffic assignment context when `dtcc_sim.datasets` is available. |
| `expensive` | `urban_heat_simulation_xdmf`, `urban_wind_simulation_dtcc` | Manual solver entries for local inspection and artifact experiments. |

Every entry in `datasets.yaml` declares an internal tier, table role, inclusion reason,
export format, filename, media type, data kind, CRS when relevant, and publish
behavior.

The default projection artifacts deliberately use the physical model bounds
from `model.yaml`. Sparse live/station datasets may therefore be visually empty
when no current observation falls inside the 500 m printed area; their metadata
and warnings remain part of the package.

## Demo Mapping

The simple public demos live in `dtcc-core/demos/`. They teach the API; this
profile deploys concrete table artifacts.

| Dataset id | Demo or reason |
|---|---|
| `calibration_grid` | `dtcc-core/demos/calibration_grid.py` |
| `smoke_field_vtu`, `smoke_field_dtcc`, `smoke_slice_geojson`, `smoke_streamlines_geojson`, `smoke_slice`, `smoke_streamlines`, `smoke_streamlines_mp4` | `dtcc-core/demos/smoke.py` |
| `building_footprints` | `dtcc-core/demos/building_footprints.py` |
| `roads` | `dtcc-core/demos/roads.py` |
| `space_syntax` | `dtcc-core/demos/space_syntax.py` |
| `deso_population` | `dtcc-core/demos/deso.py` |
| `weather_temperature` | `dtcc-core/demos/weather.py` |
| `air_quality_no2` | `dtcc-core/demos/air_quality.py` |
| `hydrology_discharge` | `dtcc-core/demos/hydrology.py` |
| `ocean_sea_level` | `dtcc-core/demos/ocean.py` |
| `transit_vehicles_buses` | `dtcc-core/demos/transit_vehicles.py` |
| `trees` | `dtcc-core/demos/trees.py` |
| `terrain_surface_mesh` | `dtcc-core/demos/terrain_surface_mesh.py` |
| `city_surface_mesh` | `dtcc-core/demos/city_meshes.py` |
| `traffic_simulation_dtcc` | No duplicate core demo; simulation examples belong in `dtcc-sim`. |
| `urban_heat_simulation_xdmf`, `urban_wind_simulation_dtcc` | No duplicate core demo; these require the explicit FEniCS environment in `dtcc-sim`. |

## Responsibility

Dataset maintainers own dataset definitions, correctness, metadata,
provenance, tests, and demos.

Table profile maintainers own `model.yaml`, `datasets.yaml`, table roles,
dataset set choices, and visual inspection.

The release/operator role runs the generator and publishes packages
intentionally.

The physical model owner updates `model.yaml` when the printed model changes.

## Visual Inspection Notes

- Calibration grid: verify the outer grid frame covers the printed model
  square, grid spacing is uniform, and no axis is flipped, shifted, or
  stretched.
- Smoke slice PNG: verify the image fills the table frame and remains a
  synthetic UX fixture. It is not CFD validation.
- Smoke streamlines PNG: verify streamline direction is readable at table
  scale and does not hide the calibration frame during setup.
- Smoke MP4: verify the loop plays smoothly and matches the streamlines PNG
  extent.
- Building footprints and roads: verify real geometry sits on the physical
  model before treating it as alignment or context evidence.
- DeSO, station, and live datasets: verify sparse or empty in-model coverage,
  legends, timestamps, units, warnings, and limitation text are visible in the
  UI.
- Live transit: verify missing credentials fail or skip loudly, and live
  points show timestamp/staleness metadata when credentials are configured.
- Simulation and expensive entries: verify the solver/runtime environment
  before generation, and visually inspect field ranges before publishing.

## Physical Model Changes

When the printed model changes, update `model.yaml` first, then rerun:

```bash
python scripts/generate_table_catalog.py gbg_500m_2026_07 --dry-run
python scripts/generate_table_catalog.py gbg_500m_2026_07 --include dev --dry-run
```

Only publish after the generated bounds, CRS, scale, and visual inspection
notes match the new physical model.
