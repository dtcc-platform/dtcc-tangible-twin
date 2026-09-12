from __future__ import annotations

from pathlib import Path

import pytest

from scripts.generate_table_catalog import SpecError, load_specs


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_gbg_table_model_specs_validate():
    model, datasets = load_specs(REPO_ROOT, "gbg_500m_2026_07")

    assert model.model_id == "gbg_500m_2026_07"
    assert model.crs == "EPSG:3006"
    assert model.bounds == (319720.0, 6397660.0, 320220.0, 6398160.0)
    assert model.physical.width_mm == 400
    assert model.physical.height_mm == 400
    assert model.physical.scale == 1250

    ids = {spec.id for spec in datasets}
    assert {
        "calibration_grid",
        "smoke_field_vtu",
        "smoke_field_dtcc",
        "smoke_slice_geojson",
        "smoke_streamlines_geojson",
        "smoke_slice",
        "smoke_streamlines",
        "smoke_streamlines_mp4",
        "building_footprints",
        "roads",
        "space_syntax",
        "deso_population",
        "weather_temperature",
        "air_quality_no2",
        "hydrology_discharge",
        "ocean_sea_level",
        "transit_vehicles_buses",
        "trees",
        "terrain_surface_mesh",
        "city_surface_mesh",
        "traffic_simulation_dtcc",
        "urban_heat_simulation_xdmf",
        "urban_wind_simulation_dtcc",
    } <= ids

    by_id = {spec.id: spec for spec in datasets}
    assert all(spec.table.tier for spec in datasets)
    assert all(spec.table.reason for spec in datasets)
    assert all(spec.export.media_type for spec in datasets)
    assert all(spec.export.data_kind for spec in datasets)
    assert "12.5 m coordinate grid" in by_id["calibration_grid"].description
    assert by_id["calibration_grid"].table.tier == "core"
    assert by_id["calibration_grid"].export.media_type == "image/png"
    assert by_id["calibration_grid"].export.data_kind == "raster"
    assert by_id["calibration_grid"].export.crs == "EPSG:3006"
    assert by_id["smoke_slice"].export.media_type == "image/png"
    assert by_id["smoke_slice"].export.data_kind == "raster"
    assert by_id["smoke_slice"].export.crs == "EPSG:3006"
    assert by_id["smoke_slice_geojson"].export.crs == "EPSG:3006"
    assert "not validated CFD" in by_id["smoke_slice"].description
    assert "not validated CFD" in by_id["smoke_streamlines"].description
    assert "source and license notes" in by_id["building_footprints"].description
    assert by_id["building_footprints"].params["source"] == "LM"
    assert by_id["building_footprints"].table.tier == "core"
    assert by_id["building_footprints"].table.role == "alignment_context"
    assert by_id["building_footprints"].export.crs == "EPSG:3006"
    assert by_id["roads"].table.tier == "core"
    assert by_id["roads"].export.media_type == "image/png"
    assert by_id["space_syntax"].table.tier == "core"
    assert by_id["deso_population"].table.tier == "core"
    assert by_id["weather_temperature"].table.tier == "core"
    assert by_id["air_quality_no2"].table.tier == "core"
    assert by_id["hydrology_discharge"].table.tier == "core"
    assert by_id["ocean_sea_level"].table.tier == "core"
    assert by_id["transit_vehicles_buses"].table.tier == "core"
    assert by_id["transit_vehicles_buses"].table.required_env == (
        "VASTTRAFIK_AUTHENTICATION_KEY",
    )
    assert by_id["trees"].table.tier == "core"
    assert by_id["terrain_surface_mesh"].export.renderer == "mesh_topdown"
    assert by_id["city_surface_mesh"].export.renderer == "mesh_topdown"
    assert by_id["traffic_simulation_dtcc"].table.tier == "simulation"
    assert "dtcc_sim.datasets" in by_id["traffic_simulation_dtcc"].table.required_python


def test_non_core_specs_have_tiers_and_reasons():
    _model, datasets = load_specs(REPO_ROOT, "gbg_500m_2026_07")

    non_core = [spec for spec in datasets if spec.table.tier != "core"]

    assert {
        spec.id for spec in non_core if spec.table.tier == "dev"
    } >= {
        "smoke_field_vtu",
        "smoke_field_dtcc",
        "smoke_slice_geojson",
        "smoke_streamlines_geojson",
    }
    assert "building_footprints" not in {spec.id for spec in non_core}
    assert "roads" not in {spec.id for spec in non_core}
    assert all(spec.table.reason for spec in non_core)


def test_gbg_table_profile_readme_documents_operations():
    readme = (
        REPO_ROOT / "table_models" / "gbg_500m_2026_07" / "README.md"
    ).read_text(encoding="utf-8")

    assert "Bounds: `[319720, 6397660, 320220, 6398160]`" in readme
    assert "python scripts/generate_table_catalog.py gbg_500m_2026_07 --dry-run" in (
        readme
    )
    assert "python scripts/generate_table_catalog.py gbg_500m_2026_07 --clean" in (
        readme
    )
    assert "python scripts/generate_table_catalog.py gbg_500m_2026_07 --include dev --clean" in (
        readme
    )
    assert "--include credentialed --strict --dry-run" in readme
    assert "--include expensive --run-expensive --clean" in readme
    assert "DTCC_UPLOAD_URL" in readme
    assert ".dtccpkg" in readme
    assert "manifest.json" in readme
    assert "smoke_field_vtu" in readme
    assert "roads" in readme
    assert "building_footprints" in readme
    assert "city_surface_mesh" in readme
    assert "Visual Inspection Notes" in readme


def test_dataset_specs_require_tier_and_reason(tmp_path):
    model_dir = tmp_path / "table_models" / "bad_model"
    model_dir.mkdir(parents=True)
    _write_minimal_model(model_dir)
    (model_dir / "datasets.yaml").write_text(
        "\n".join(
            [
                "datasets:",
                "  - id: bad",
                "    dataset: fake",
                "    title: Bad",
                "    description: Bad",
                "    params: {}",
                "    export:",
                "      format: geojson",
                "      filename: bad.geojson",
                "      media_type: application/geo+json",
                "      data_kind: vector",
                "    table:",
                "      role: overlay",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(SpecError, match="missing required field tier"):
        load_specs(tmp_path, "bad_model")


def test_dataset_specs_require_export_media_type_and_data_kind(tmp_path):
    model_dir = tmp_path / "table_models" / "bad_model"
    model_dir.mkdir(parents=True)
    _write_minimal_model(model_dir)
    (model_dir / "datasets.yaml").write_text(
        "\n".join(
            [
                "datasets:",
                "  - id: bad",
                "    dataset: fake",
                "    title: Bad",
                "    description: Bad",
                "    params: {}",
                "    export:",
                "      format: geojson",
                "      filename: bad.geojson",
                "    table:",
                "      tier: core",
                "      role: overlay",
                "      reason: Test missing export metadata.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(SpecError, match="media_type"):
        load_specs(tmp_path, "bad_model")


def test_model_id_must_match_directory(tmp_path):
    model_dir = tmp_path / "table_models" / "bad_model"
    model_dir.mkdir(parents=True)
    (model_dir / "model.yaml").write_text(
        "\n".join(
            [
                "model_id: other",
                "title: Bad",
                "crs: EPSG:3006",
                "bounds: [0, 0, 1, 1]",
                "physical:",
                "  width_mm: 1",
                "  height_mm: 1",
                "  scale: 1",
                "catalog:",
                "  dataset_key_prefix: bad",
                "  output_dir: temp/bad",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (model_dir / "datasets.yaml").write_text("datasets: []\n", encoding="utf-8")

    with pytest.raises(SpecError, match="does not match requested model_id"):
        load_specs(tmp_path, "bad_model")


def test_dataset_spec_cannot_override_model_bounds(tmp_path):
    model_dir = tmp_path / "table_models" / "bad_model"
    model_dir.mkdir(parents=True)
    (model_dir / "model.yaml").write_text(
        "\n".join(
            [
                "model_id: bad_model",
                "title: Bad",
                "crs: EPSG:3006",
                "bounds: [0, 0, 1, 1]",
                "physical:",
                "  width_mm: 1",
                "  height_mm: 1",
                "  scale: 1",
                "catalog:",
                "  dataset_key_prefix: bad",
                "  output_dir: temp/bad",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (model_dir / "datasets.yaml").write_text(
        "\n".join(
            [
                "datasets:",
                "  - id: bad",
                "    dataset: fake",
                "    title: Bad",
                "    description: Bad",
                "    params:",
                "      bounds: [1, 1, 2, 2]",
                "    export:",
                "      format: geojson",
                "      filename: bad.geojson",
                "    table:",
                "      role: overlay",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with pytest.raises(SpecError, match="must not contain bounds"):
        load_specs(tmp_path, "bad_model")


def _write_minimal_model(model_dir: Path) -> None:
    (model_dir / "model.yaml").write_text(
        "\n".join(
            [
                "model_id: bad_model",
                "title: Bad",
                "crs: EPSG:3006",
                "bounds: [0, 0, 1, 1]",
                "physical:",
                "  width_mm: 1",
                "  height_mm: 1",
                "  scale: 1",
                "catalog:",
                "  dataset_key_prefix: bad",
                "  output_dir: temp/bad",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
