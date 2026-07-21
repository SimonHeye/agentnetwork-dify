from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from import_graph_to_dify import (
    DifyImportError,
    build_sync_payload,
    import_graph,
    load_graph,
    load_import_config,
)
from Pipeline.group_registry import (
    GroupRegistryError,
    load_group_registry,
    resolve_group_name,
    validate_group_registry,
)
from Pipeline.pipeline import (
    default_source_map_path,
    pseudocode_file_to_workflow_artifacts,
    pseudocode_file_to_workflow_graph,
    pseudocode_to_workflow_artifacts,
    pseudocode_to_workflow_graph,
    write_workflow_graph,
)
from Pipeline.source_map import SourceMapError, build_source_map, canonical_json_sha256, write_source_map
from T1_parser.pseudocode_parser import compile_to_semantics
from T2_workflowgraph import build_workflow_graph

ROOT_DIR = Path(__file__).resolve().parents[1]
SAMPLE_PATH = ROOT_DIR / "T1_parser" / "sample.py"
APP_ID = "a120896d-0344-48f0-9eda-27439a58d6a2"
MODEL_CONFIG = {
    "provider": "test-provider",
    "name": "test-model",
    "mode": "chat",
    "completion_params": {},
}
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


def test_pipeline_hides_t1_intermediate_and_returns_only_graph() -> None:
    graph = pseudocode_file_to_workflow_graph(SAMPLE_PATH, MODEL_CONFIG)
    assert set(graph) == {"nodes", "edges", "viewport"}
    assert "steps" not in graph
    assert "terminals" not in graph
    assert "variables" not in graph


def test_pipeline_preserves_structured_runtime_output_for_get_condition() -> None:
    graph = pseudocode_file_to_workflow_graph(SAMPLE_PATH, MODEL_CONFIG)
    nodes = {node["id"]: node for node in graph["nodes"]}
    reasoning = nodes["reasoninggroup"]["data"]
    assert reasoning["structured_output_enabled"] is True
    assert reasoning["structured_output"]["schema"]["properties"] == {"kind": {"type": "string"}}
    condition = nodes["branch_1"]["data"]["cases"][0]["conditions"][0]
    assert condition["variable_selector"] == ["reasoninggroup", "structured_output", "kind"]


def test_pipeline_generates_workflow_end_nodes() -> None:
    graph = pseudocode_file_to_workflow_graph(SAMPLE_PATH, MODEL_CONFIG)
    node_types = [node["data"]["type"] for node in graph["nodes"]]
    assert node_types.count("start") == 1
    assert node_types.count("llm") == 3
    assert node_types.count("if-else") == 1
    assert node_types.count("end") == 2


def test_pipeline_accepts_source_text_without_files() -> None:
    graph = pseudocode_to_workflow_graph(
        "result = EchoGroup(task=task)\nfinal_result = result",
        MODEL_CONFIG,
    )
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert set(nodes) == {"start", "echogroup", "terminal_1"}
    assert nodes["terminal_1"]["data"]["outputs"][0]["value_selector"] == ["echogroup", "text"]


def test_pipeline_cli_writes_graph_and_source_map(tmp_path: Path) -> None:
    output_path = tmp_path / "workflow_graph.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT_DIR / "Pipeline" / "pipeline.py"),
            str(SAMPLE_PATH),
            "--provider",
            "test-provider",
            "--model",
            "test-model",
            "--output",
            str(output_path),
        ],
        cwd=ROOT_DIR,
        check=True,
        capture_output=True,
        text=True,
    )
    source_map_path = default_source_map_path(output_path)
    assert result.stdout.strip().splitlines() == [
        f"Graph: {output_path.resolve()}",
        f"SourceMap: {source_map_path.resolve()}",
    ]
    assert set(json.loads(output_path.read_text(encoding="utf-8"))) == {"nodes", "edges", "viewport"}
    assert json.loads(source_map_path.read_text(encoding="utf-8"))["version"] == 1


def test_artifact_api_keeps_graph_only_api_compatible() -> None:
    artifacts = pseudocode_file_to_workflow_artifacts(SAMPLE_PATH, MODEL_CONFIG)
    assert artifacts["graph"] == pseudocode_file_to_workflow_graph(SAMPLE_PATH, MODEL_CONFIG)
    assert artifacts["source_map"]["flow_semantics"]["version"] == 1


def test_write_workflow_graph_rejects_invalid_graph_shape(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="'edges'"):
        write_workflow_graph({"nodes": []}, tmp_path / "invalid.json")


def test_group_registry_resolves_names_and_rejects_invalid_mappings() -> None:
    registry = load_group_registry()
    assert resolve_group_name("ReasoningGroup", registry) == "ReasoningGroup"
    assert resolve_group_name(" 数值计算 ", registry) == "CalculatorGroup"
    assert resolve_group_name("不存在的节点", registry) is None
    with pytest.raises(GroupRegistryError, match="dify_type"):
        validate_group_registry(
            {
                "version": 1,
                "groups": {
                    "SearchGroup": {
                        "dify_type": "tool",
                        "aliases": [],
                        "input_params": ["task"],
                        "default_assignment": "result",
                    }
                },
            }
        )


def test_group_registry_rejects_shared_aliases() -> None:
    definition = {
        "dify_type": "llm",
        "aliases": ["通用"],
        "input_params": ["task"],
        "default_assignment": "result",
    }
    with pytest.raises(GroupRegistryError, match="shared"):
        validate_group_registry(
            {
                "version": 1,
                "groups": {
                    "FirstGroup": definition,
                    "SecondGroup": {**definition, "default_assignment": "second_result"},
                },
            }
        )


def test_source_map_preserves_calls_raw_values_and_terminal_expansion() -> None:
    artifacts = pseudocode_file_to_workflow_artifacts(
        SAMPLE_PATH,
        MODEL_CONFIG,
        group_registry=load_group_registry(),
    )
    source_map = artifacts["source_map"]
    steps = {item["id"]: item for item in source_map["flow_semantics"]["steps"]}
    reasoning = steps["reasoninggroup"]
    assert reasoning["function"] == "ReasoningGroup"
    assert reasoning["assign_to"] == "probe"
    assert reasoning["lineno"] == 6
    assert "判断下面的用户需求" in reasoning["kwargs"]["task"]["raw"]
    assert source_map["graph_nodes"]["reasoninggroup"]["structured_fields"] == {"kind": "string"}
    terminal_nodes = {
        node_id: mapping["producer_id"]
        for node_id, mapping in source_map["graph_nodes"].items()
        if mapping["kind"] == "terminal"
    }
    assert terminal_nodes == {
        "terminal_1_calculatorgroup": "calculatorgroup",
        "terminal_1_searchgroup": "searchgroup",
    }


def test_source_map_allows_unregistered_groups_and_has_stable_hashes() -> None:
    artifacts = pseudocode_to_workflow_artifacts(
        "result = CustomUnlistedGroup(task=task)\nfinal_result = result",
        MODEL_CONFIG,
        group_registry=load_group_registry(),
    )
    mapping = artifacts["source_map"]["graph_nodes"]["customunlistedgroup"]
    assert mapping["function"] == "CustomUnlistedGroup"
    assert artifacts["source_map"]["graph_sha256"] == canonical_json_sha256(artifacts["graph"])
    assert artifacts["source_map"]["registry"]["version"] == 1


def test_source_map_rejects_unmapped_nodes_and_round_trips_json(tmp_path: Path) -> None:
    source = "result = EchoGroup(task=task)\nfinal_result = result"
    semantics = compile_to_semantics(source)
    graph = build_workflow_graph(semantics, MODEL_CONFIG)
    valid_map = build_source_map(source, semantics, graph)
    output = write_source_map(valid_map, tmp_path / "sample.sourcemap.json")
    assert json.loads(output.read_text(encoding="utf-8")) == valid_map
    graph["nodes"].append({"id": "unknown", "data": {"type": "llm"}})
    with pytest.raises(SourceMapError, match="no matching"):
        build_source_map(source, semantics, graph)


def test_build_sync_payload_preserves_non_graph_fields() -> None:
    assert build_sync_payload(DRAFT, GRAPH) == {
        "graph": GRAPH,
        "features": {"opening_statement": "hello"},
        "environment_variables": [{"name": "env"}],
        "conversation_variables": [],
        "hash": "draft-hash",
    }


def test_import_backs_up_syncs_and_verifies(tmp_path: Path) -> None:
    client = FakeClient()
    backup_path, result = import_graph(client, APP_ID, GRAPH, backup_dir=tmp_path, confirmed=True)
    assert json.loads(backup_path.read_text(encoding="utf-8")) == DRAFT
    assert client.synced_payload == build_sync_payload(DRAFT, GRAPH)
    assert result == {"result": "success", "hash": "new-hash"}


def test_dry_run_and_unconfirmed_import_do_not_sync(tmp_path: Path) -> None:
    dry_client = FakeClient()
    backup_path, result = import_graph(dry_client, APP_ID, GRAPH, backup_dir=tmp_path, dry_run=True)
    assert backup_path.exists()
    assert result is None
    assert dry_client.synced_payload is None

    unconfirmed_client = FakeClient()
    with pytest.raises(DifyImportError, match="not confirmed"):
        import_graph(unconfirmed_client, APP_ID, GRAPH, backup_dir=tmp_path)
    assert unconfirmed_client.synced_payload is None


def test_load_graph_and_import_config_reject_invalid_shapes(tmp_path: Path) -> None:
    graph_path = tmp_path / "bad-graph.json"
    graph_path.write_text('{"nodes": []}', encoding="utf-8")
    with pytest.raises(DifyImportError, match="edges"):
        load_graph(graph_path)

    config_path = tmp_path / "bad-config.json"
    config_path.write_text('{"auto_confirm": "yes"}', encoding="utf-8")
    with pytest.raises(DifyImportError, match="auto_confirm"):
        load_import_config(config_path)


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
