from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from Pipeline.pipeline import (
    pseudocode_file_to_workflow_graph,
    pseudocode_to_workflow_graph,
    write_workflow_graph,
)

ROOT_DIR = Path(__file__).resolve().parents[1]
SAMPLE_PATH = ROOT_DIR / "T1_parser" / "sample.py"
MODEL_CONFIG = {
    "provider": "test-provider",
    "name": "test-model",
    "mode": "chat",
    "completion_params": {},
}


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
    assert "answer" not in node_types


def test_pipeline_accepts_source_text_without_files() -> None:
    graph = pseudocode_to_workflow_graph(
        "result = EchoGroup(task=task)\nfinal_result = result",
        MODEL_CONFIG,
    )
    nodes = {node["id"]: node for node in graph["nodes"]}
    assert set(nodes) == {"start", "echogroup", "terminal_1"}
    assert nodes["terminal_1"]["data"]["outputs"][0]["value_selector"] == ["echogroup", "text"]


def test_pipeline_cli_writes_valid_json(tmp_path: Path) -> None:
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
    assert Path(result.stdout.strip()) == output_path.resolve()
    graph = json.loads(output_path.read_text(encoding="utf-8"))
    assert set(graph) == {"nodes", "edges", "viewport"}


def test_write_workflow_graph_rejects_invalid_graph_shape(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="'edges'"):
        write_workflow_graph({"nodes": []}, tmp_path / "invalid.json")
