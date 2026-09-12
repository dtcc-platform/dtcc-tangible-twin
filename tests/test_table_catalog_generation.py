from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from dtcc_core.datasets.schema import (
    DatasetContext,
    DatasetIdentity,
    DatasetMetadata,
    DatasetPresentation,
    DatasetProvenance,
    DatasetRequest,
)
from scripts.generate_table_catalog import (
    GenerationError,
    SpecError,
    _module_spec_exists_without_import,
    generate_catalog,
    main,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


DEFAULT_MEDIA_IDS = {
    "calibration_grid",
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
}


def _write_fake_specs(root: Path, *, output_dir: str = "temp/fake") -> None:
    model_dir = root / "table_models" / "fake_model"
    model_dir.mkdir(parents=True)
    (model_dir / "model.yaml").write_text(
        "\n".join(
            [
                "model_id: fake_model",
                "title: Fake model",
                "crs: EPSG:3006",
                "bounds: [10, 20, 30, 40]",
                "physical:",
                "  width_mm: 20",
                "  height_mm: 20",
                "  scale: 1000",
                "catalog:",
                "  dataset_key_prefix: fake-prefix",
                f"  output_dir: {output_dir}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (model_dir / "datasets.yaml").write_text(
        "\n".join(
            [
                "datasets:",
                "  - id: fake_geojson",
                "    dataset: fake_dataset",
                "    title: Fake GeoJSON",
                "    description: Fake generated package.",
                "    params:",
                "      answer: 42",
                "    export:",
                "      format: geojson",
                "      filename: fake.geojson",
                "      media_type: application/geo+json",
                "      data_kind: vector",
                "      crs: EPSG:3006",
                "    table:",
                "      tier: core",
                "      role: overlay",
                "      reason: Test core package generation.",
                "      dataset_key_suffix: fake-geojson",
                "      publish: true",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _write_fake_plot_specs(root: Path, *, output_dir: str = "temp/fake") -> None:
    model_dir = root / "table_models" / "fake_model"
    model_dir.mkdir(parents=True)
    (model_dir / "model.yaml").write_text(
        "\n".join(
            [
                "model_id: fake_model",
                "title: Fake model",
                "crs: EPSG:3006",
                "bounds: [10, 20, 30, 40]",
                "physical:",
                "  width_mm: 20",
                "  height_mm: 20",
                "  scale: 1000",
                "catalog:",
                "  dataset_key_prefix: fake-prefix",
                f"  output_dir: {output_dir}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (model_dir / "datasets.yaml").write_text(
        "\n".join(
            [
                "datasets:",
                "  - id: fake_plot",
                "    dataset: fake_plot_dataset",
                "    title: Fake Plot",
                "    description: Fake rendered media package.",
                "    params: {}",
                "    export:",
                "      format: png",
                "      filename: fake_plot.png",
                "      media_type: image/png",
                "      data_kind: raster",
                "      crs: EPSG:3006",
                "      renderer: plot",
                "      width_px: 320",
                "      height_px: 320",
                "      dpi: 80",
                "    table:",
                "      tier: core",
                "      role: projection",
                "      reason: Test rendered media package generation.",
                "      dataset_key_suffix: fake-plot",
                "      publish: true",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


class FakeDatasetObject:
    def __init__(self, params):
        self.params = params

    def export(self, package_dir: Path, *, format: str):
        package_dir.mkdir(parents=True)
        artifact_dir = package_dir / "artifacts"
        artifact_dir.mkdir()
        artifact_path = artifact_dir / "generated.geojson"
        artifact_path.write_text(
            '{"type":"FeatureCollection","features":[]}\n',
            encoding="utf-8",
        )
        payload = artifact_path.read_bytes()
        manifest = {
            "schema_version": "dtcc-dataset-manifest-v2",
            "identity": {"name": "fake_dataset", "title": "Original title"},
            "metadata": {"description": "Original description"},
            "provenance": {},
            "presentation": {"summary": "Original summary"},
            "request": {
                "dataset_name": "fake_dataset",
                "parameters": dict(self.params),
                "bounds": self.params["bounds"],
            },
            "artifacts": [
                {
                    "path": "artifacts/generated.geojson",
                    "role": "primary",
                    "format": format,
                    "media_type": "application/geo+json",
                    "data_kind": "vector",
                    "crs": "EPSG:3006",
                    "bounds": self.params["bounds"],
                    "size": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            ],
        }
        (package_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
        )


def fake_dataset(**params):
    return FakeDatasetObject(params)


class WrongMediaTypeDatasetObject(FakeDatasetObject):
    def export(self, package_dir: Path, *, format: str):
        super().export(package_dir, format=format)
        manifest_path = package_dir / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["artifacts"][0]["media_type"] = "application/json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2) + "\n",
            encoding="utf-8",
        )


def wrong_media_type_dataset(**params):
    return WrongMediaTypeDatasetObject(params)


class FakeSerializedArgs:
    def __init__(self, params):
        self._params = dict(params)

    def model_dump(self, *, mode: str):
        assert mode == "json"
        return dict(self._params)


class FakeSerializedDataset:
    def __call__(self, **params):
        assert params["format"] == "dtcc"
        return b"fake-protobuf-payload"

    def validate(self, params):
        return FakeSerializedArgs(params)

    def create_context(self, args):
        params = args.model_dump(mode="json")
        return DatasetContext(
            identity=DatasetIdentity(name="fake_serialized", title="Original title"),
            metadata=DatasetMetadata(
                description="Original description",
                crs=["EPSG:3006"],
                formats=["dtcc"],
                data_types=["protobuf"],
                result_kind="protobuf",
                python_return_type="bytes",
            ),
            provenance=DatasetProvenance(
                sources=["fake serialized source"],
                processing_steps=["Build serialized fake dataset"],
            ),
            presentation=DatasetPresentation(summary="Original summary"),
            request=DatasetRequest(
                dataset_name="fake_serialized",
                parameters=params,
                bounds=params["bounds"],
            ),
        )


class FakePlotDatasetObject:
    def __init__(self, params):
        self.params = params
        self.dataset_context = DatasetContext(
            identity=DatasetIdentity(name="fake_plot", title="Original title"),
            metadata=DatasetMetadata(
                description="Original description",
                crs=["EPSG:3006"],
                formats=["png"],
                data_types=["raster"],
                result_kind="raster",
                python_return_type="FakePlotDatasetObject",
            ),
            provenance=DatasetProvenance(
                sources=["fake plot source"],
                processing_steps=["Build fake plot dataset"],
            ),
            presentation=DatasetPresentation(summary="Original summary"),
            request=DatasetRequest(
                dataset_name="fake_plot",
                parameters=params,
                bounds=params["bounds"],
            ),
        )

    def plot(self, *, presentation, show, theme, ax):
        assert presentation is False
        assert show is False
        assert theme == "dark"
        ax.scatter([15, 25], [25, 35], c=["#4cc9f0", "#f72585"])


def fake_plot_dataset(**params):
    return FakePlotDatasetObject(params)


def _read_archive_json(archive_path: Path, member: str):
    with zipfile.ZipFile(archive_path) as archive:
        return json.loads(archive.read(member).decode("utf-8"))


def _archive_names(archive_path: Path) -> set[str]:
    with zipfile.ZipFile(archive_path) as archive:
        return set(archive.namelist())


def test_dry_run_validates_real_specs_without_creating_output(tmp_path):
    output_dir = tmp_path / "dry-run-output"

    report = generate_catalog(
        "gbg_500m_2026_07",
        root_dir=REPO_ROOT,
        output_dir=output_dir,
        dry_run=True,
        env={"VASTTRAFIK_AUTHENTICATION_KEY": "test-key"},
    )

    assert output_dir.exists() is False
    assert report["dry_run"] is True
    assert report["selected_tiers"] == ["core"]
    planned_ids = {item["id"] for item in report["planned"]}
    assert planned_ids == DEFAULT_MEDIA_IDS
    assert not any(
        item.endswith(("_geojson", "_dtcc", "_obj")) for item in planned_ids
    )
    assert {item["tier"] for item in report["planned"]} == {"core"}
    planned_by_id = {item["id"]: item for item in report["planned"]}
    assert planned_by_id["calibration_grid"]["media_type"] == "image/png"
    assert planned_by_id["calibration_grid"]["reason"]
    assert planned_by_id["calibration_grid"]["crs"] == "EPSG:3006"
    assert planned_by_id["smoke_slice"]["media_type"] == "image/png"
    assert planned_by_id["smoke_streamlines_mp4"]["media_type"] == "video/mp4"
    assert planned_by_id["roads"]["requires_network"] is True
    assert planned_by_id["deso_population"]["publish_requested"] is True
    assert planned_by_id["transit_vehicles_buses"]["required_env"] == [
        "VASTTRAFIK_AUTHENTICATION_KEY"
    ]
    assert {item["id"] for item in report["skipped"]} >= {
        "smoke_field_vtu",
        "smoke_field_dtcc",
        "smoke_slice_geojson",
        "smoke_streamlines_geojson",
        "traffic_simulation_dtcc",
    }


def test_include_dev_dry_run_includes_default_and_dev_specs(tmp_path):
    report = generate_catalog(
        "gbg_500m_2026_07",
        root_dir=REPO_ROOT,
        output_dir=tmp_path / "out",
        include="dev",
        dry_run=True,
        env={"VASTTRAFIK_AUTHENTICATION_KEY": "test-key"},
    )

    planned_by_id = {item["id"]: item for item in report["planned"]}

    assert report["selected_tiers"] == ["core", "dev"]
    assert planned_by_id["calibration_grid"]["tier"] == "core"
    assert planned_by_id["roads"]["tier"] == "core"
    assert planned_by_id["weather_temperature"]["requires_network"] is True
    assert planned_by_id["weather_temperature"]["tier"] == "core"
    assert planned_by_id["smoke_slice_geojson"]["tier"] == "dev"
    assert planned_by_id["smoke_streamlines_mp4"]["tier"] == "core"


def test_legacy_tier_alias_is_rejected_by_cli(capsys):
    legacy_alias = "--" + "tier"

    with pytest.raises(SystemExit) as exc_info:
        main(["gbg_500m_2026_07", legacy_alias, "dev", "--dry-run"])

    assert exc_info.value.code == 2
    assert f"unrecognized arguments: {legacy_alias} dev" in capsys.readouterr().err


def test_dependency_probe_does_not_import_parent_package(tmp_path, monkeypatch):
    package_dir = tmp_path / "danger_parent"
    package_dir.mkdir()
    (package_dir / "__init__.py").write_text(
        "raise RuntimeError('parent package was imported')\n",
        encoding="utf-8",
    )
    (package_dir / "child.py").write_text("VALUE = 1\n", encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))

    assert _module_spec_exists_without_import("danger_parent.child") is True


def test_credentialed_tier_skips_missing_credentials_by_default(tmp_path):
    report = generate_catalog(
        "gbg_500m_2026_07",
        root_dir=REPO_ROOT,
        output_dir=tmp_path / "out",
        include="credentialed",
        dry_run=True,
        env={},
    )

    skipped = {item["id"]: item for item in report["skipped"]}

    assert "transit_vehicles_buses" in skipped
    assert "VASTTRAFIK_AUTHENTICATION_KEY" in skipped["transit_vehicles_buses"][
        "reason"
    ]


def test_strict_credentialed_tier_fails_for_missing_credentials(tmp_path):
    with pytest.raises(GenerationError, match="VASTTRAFIK_AUTHENTICATION_KEY"):
        generate_catalog(
            "gbg_500m_2026_07",
            root_dir=REPO_ROOT,
            output_dir=tmp_path / "out",
            include="credentialed",
            dry_run=True,
            strict=True,
            env={},
        )


def test_expensive_tier_requires_explicit_runtime_guard(tmp_path):
    report = generate_catalog(
        "gbg_500m_2026_07",
        root_dir=REPO_ROOT,
        output_dir=tmp_path / "out",
        include="expensive",
        dry_run=True,
        env={},
    )

    skipped = {item["id"]: item for item in report["skipped"]}

    assert "urban_heat_simulation_xdmf" in skipped
    assert "--run-expensive" in skipped["urban_heat_simulation_xdmf"]["reason"]


def test_expensive_tier_dry_run_can_be_enabled(tmp_path):
    report = generate_catalog(
        "gbg_500m_2026_07",
        root_dir=REPO_ROOT,
        output_dir=tmp_path / "out",
        include="expensive",
        run_expensive=True,
        dry_run=True,
        env={},
    )

    planned = {item["id"] for item in report["planned"]}
    skipped = {item["id"]: item for item in report["skipped"]}

    if "urban_heat_simulation_xdmf" in skipped:
        assert "--run-expensive" not in skipped["urban_heat_simulation_xdmf"][
            "reason"
        ]
    else:
        assert "urban_heat_simulation_xdmf" in planned


def test_publish_requires_configuration_before_dry_run():
    with pytest.raises(GenerationError, match="DTCC_UPLOAD_URL"):
        generate_catalog(
            "gbg_500m_2026_07",
            root_dir=REPO_ROOT,
            dry_run=True,
            publish=True,
            env={},
        )


def test_non_empty_output_requires_clean(tmp_path):
    _write_fake_specs(tmp_path, output_dir="out")
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    (output_dir / "existing.txt").write_text("keep\n", encoding="utf-8")

    with pytest.raises(GenerationError, match="Pass --clean"):
        generate_catalog(
            "fake_model",
            root_dir=tmp_path,
            dataset_registry={"fake_dataset": fake_dataset},
        )


def test_fake_dataset_generation_writes_valid_package(tmp_path):
    _write_fake_specs(tmp_path, output_dir="out")

    report = generate_catalog(
        "fake_model",
        root_dir=tmp_path,
        clean=True,
        dataset_registry={"fake_dataset": fake_dataset},
    )

    assert len(report["generated"]) == 1
    generated = report["generated"][0]
    assert generated["dataset_key"] == "fake-prefix-fake-geojson"
    assert generated["package_format"] == "dtccpkg"
    assert generated["manifest"] == "manifest.json"
    assert generated["artifacts"] == ["artifacts/fake.geojson"]

    archive_path = Path(generated["archive_path"])
    assert archive_path == tmp_path / "out" / "fake_geojson.dtccpkg"
    assert generated["package_path"] == str(archive_path)
    assert archive_path.is_file()
    assert not (tmp_path / "out" / "fake_geojson").exists()
    manifest = _read_archive_json(archive_path, "manifest.json")
    assert manifest["identity"]["title"] == "Fake GeoJSON"
    assert manifest["metadata"]["description"] == "Fake generated package."
    assert manifest["request"]["bounds"] == [10.0, 20.0, 30.0, 40.0]
    assert manifest["artifacts"][0]["path"] == "artifacts/fake.geojson"
    assert manifest["artifacts"][0]["media_type"] == "application/geo+json"
    assert manifest["artifacts"][0]["data_kind"] == "vector"
    assert manifest["artifacts"][0]["crs"] == "EPSG:3006"
    assert manifest["presentation"]["view_hints"]["expected_format"] == "geojson"
    assert manifest["presentation"]["view_hints"]["expected_crs"] == "EPSG:3006"
    assert (tmp_path / "out" / "generation_report.json").is_file()
    assert _archive_names(archive_path) == {
        "manifest.json",
        "artifacts/fake.geojson",
    }


def test_plot_renderer_generation_writes_png_package_and_archive(tmp_path):
    _write_fake_plot_specs(tmp_path, output_dir="out")

    report = generate_catalog(
        "fake_model",
        root_dir=tmp_path,
        clean=True,
        dataset_registry={"fake_plot_dataset": fake_plot_dataset},
    )

    generated = report["generated"][0]
    archive_path = Path(generated["archive_path"])
    manifest = _read_archive_json(archive_path, "manifest.json")

    assert archive_path.is_file()
    assert not (tmp_path / "out" / "fake_plot").exists()
    assert "artifacts/fake_plot.png" in _archive_names(archive_path)
    assert manifest["identity"]["title"] == "Fake Plot"
    assert manifest["request"]["bounds"] == [10.0, 20.0, 30.0, 40.0]
    assert manifest["artifacts"][0]["path"] == "artifacts/fake_plot.png"
    assert manifest["artifacts"][0]["media_type"] == "image/png"
    assert manifest["artifacts"][0]["data_kind"] == "raster"


def test_serialized_dataset_generation_writes_manifest_v2_package(tmp_path):
    model_dir = tmp_path / "table_models" / "fake_model"
    model_dir.mkdir(parents=True)
    (model_dir / "model.yaml").write_text(
        "\n".join(
            [
                "model_id: fake_model",
                "title: Fake model",
                "crs: EPSG:3006",
                "bounds: [10, 20, 30, 40]",
                "physical:",
                "  width_mm: 20",
                "  height_mm: 20",
                "  scale: 1000",
                "catalog:",
                "  dataset_key_prefix: fake-prefix",
                "  output_dir: out",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (model_dir / "datasets.yaml").write_text(
        "\n".join(
            [
                "datasets:",
                "  - id: fake_dtcc",
                "    dataset: fake_serialized",
                "    title: Fake Protobuf",
                "    description: Fake generated protobuf package.",
                "    params:",
                "      format: dtcc",
                "    export:",
                "      format: dtcc",
                "      filename: fake.dtcc",
                "      media_type: application/vnd.dtcc.model+protobuf",
                "      data_kind: model",
                "      crs: EPSG:3006",
                "    table:",
                "      tier: core",
                "      role: overlay",
                "      reason: Test serialized payload package generation.",
                "      dataset_key_suffix: fake-dtcc",
                "      publish: true",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    report = generate_catalog(
        "fake_model",
        root_dir=tmp_path,
        clean=True,
        dataset_registry={"fake_serialized": FakeSerializedDataset()},
    )

    generated = report["generated"][0]
    archive_path = Path(generated["archive_path"])
    manifest = _read_archive_json(archive_path, "manifest.json")

    with zipfile.ZipFile(archive_path) as archive:
        assert archive.read("artifacts/fake.dtcc") == b"fake-protobuf-payload"
    assert manifest["schema_version"] == "dtcc-dataset-manifest-v2"
    assert manifest["identity"]["title"] == "Fake Protobuf"
    assert manifest["metadata"]["description"] == "Fake generated protobuf package."
    assert manifest["request"]["bounds"] == [10.0, 20.0, 30.0, 40.0]
    assert manifest["artifacts"][0]["path"] == "artifacts/fake.dtcc"
    assert manifest["artifacts"][0]["media_type"] == "application/vnd.dtcc.model+protobuf"
    assert manifest["artifacts"][0]["data_kind"] == "protobuf"
    assert manifest["artifacts"][0]["crs"] == "EPSG:3006"
    assert manifest["artifacts"][0]["sha256"] == hashlib.sha256(
        b"fake-protobuf-payload"
    ).hexdigest()
    assert archive_path.is_file()
    assert _archive_names(archive_path) == {
        "manifest.json",
        "artifacts/fake.dtcc",
    }


def test_generation_fails_when_artifact_metadata_mismatches_spec(tmp_path):
    _write_fake_specs(tmp_path, output_dir="out")

    with pytest.raises(GenerationError, match="media_type"):
        generate_catalog(
            "fake_model",
            root_dir=tmp_path,
            clean=True,
            dataset_registry={"fake_dataset": wrong_media_type_dataset},
        )
