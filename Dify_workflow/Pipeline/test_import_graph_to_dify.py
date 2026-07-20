from __future__ import annotations

import json
from pathlib import Path

import pytest

from import_graph_to_dify import (
    DifyImportError,
    build_sync_payload,
    import_graph,
    load_graph,
    load_import_config,
)

APP_ID = "a120896d-0344-48f0-9eda-27439a58d6a2"
GRAPH = {
    "nodes": [{"id": "start", "data": {"type": "start"}}],
    "edges": [],
    "viewport": {"x": 0, "y": 0, "zoom": 0.7},
}
DRAFT = {
    "graph": {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
    "features": {"opening_statement": "hello"},
    "environment_variables": [{"name": "env"}],
    "conversation_variables": [],
    "hash": "draft-hash",
}


class FakeClient:
    def __init__(self) -> None:
        self.draft = json.loads(json.dumps(DRAFT))
        self.synced_payload: dict[str, object] | None = None

    def get_draft(self, app_id: str) -> dict[str, object]:
        assert app_id == APP_ID
        return json.loads(json.dumps(self.draft))

    def sync_draft(self, app_id: str, payload: dict[str, object]) -> dict[str, object]:
        assert app_id == APP_ID
        self.synced_payload = json.loads(json.dumps(payload))
        self.draft["graph"] = json.loads(json.dumps(payload["graph"]))
        self.draft["hash"] = "new-hash"
        return {"result": "success", "hash": "new-hash"}


def test_build_sync_payload_preserves_non_graph_fields() -> None:
    payload = build_sync_payload(DRAFT, GRAPH)
    assert payload == {
        "graph": GRAPH,
        "features": {"opening_statement": "hello"},
        "environment_variables": [{"name": "env"}],
        "conversation_variables": [],
        "hash": "draft-hash",
    }


def test_import_backs_up_syncs_and_verifies(tmp_path: Path) -> None:
    client = FakeClient()
    backup_path, result = import_graph(
        client,
        APP_ID,
        GRAPH,
        backup_dir=tmp_path,
        confirmed=True,
    )
    assert json.loads(backup_path.read_text(encoding="utf-8")) == DRAFT
    assert client.synced_payload == build_sync_payload(DRAFT, GRAPH)
    assert result == {"result": "success", "hash": "new-hash"}


def test_dry_run_only_reads_and_backs_up(tmp_path: Path) -> None:
    client = FakeClient()
    backup_path, result = import_graph(
        client,
        APP_ID,
        GRAPH,
        backup_dir=tmp_path,
        dry_run=True,
    )
    assert backup_path.exists()
    assert result is None
    assert client.synced_payload is None


def test_unconfirmed_import_does_not_sync(tmp_path: Path) -> None:
    client = FakeClient()
    with pytest.raises(DifyImportError, match="not confirmed"):
        import_graph(client, APP_ID, GRAPH, backup_dir=tmp_path)
    assert client.synced_payload is None


def test_load_graph_rejects_invalid_shape(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text('{"nodes": []}', encoding="utf-8")
    with pytest.raises(DifyImportError, match="edges"):
        load_graph(path)


def test_load_import_config_accepts_local_defaults(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    config = {
        "base_url": "http://localhost",
        "app_id": APP_ID,
        "graph": "workflow_graphs/sample_graph.json",
        "backup_dir": "workflow_graphs/backups",
        "access_token": "secret",
        "auto_confirm": True,
    }
    path.write_text(json.dumps(config), encoding="utf-8")
    assert load_import_config(path) == config


def test_load_import_config_rejects_invalid_auto_confirm(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text('{"auto_confirm": "yes"}', encoding="utf-8")
    with pytest.raises(DifyImportError, match="auto_confirm"):
        load_import_config(path)
