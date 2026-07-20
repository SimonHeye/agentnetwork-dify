import pytest
import yaml

from constants.dsl_version import CURRENT_APP_DSL_VERSION
from services.agent_network import AgentNetworkCompilerError, compile_agent_network_to_dify_dsl


def _load_compiled(payload: dict) -> dict:
    return yaml.safe_load(compile_agent_network_to_dify_dsl(payload))


def test_compile_builds_advanced_chat_dsl_with_sanitized_ids_and_answer() -> None:
    data = _load_compiled(
        {
            "kind": "agent-network",
            "app": {"name": "Planner"},
            "inputs": [{"variable": "user-query", "label": "Question"}],
            "nodes": [
                {
                    "id": "reasoning-node",
                    "type": "llm",
                    "title": "Reasoning",
                    "description": "Summarise the user request.",
                    "config": {
                        "prompt_template": [{"role": "system", "text": "Use {{#start.user-query#}}"}],
                    },
                }
            ],
            "edges": [{"source": "start", "target": "reasoning-node"}],
        }
    )

    graph = data["workflow"]["graph"]
    node_ids = [node["id"] for node in graph["nodes"]]

    assert data["kind"] == "app"
    assert data["version"] == CURRENT_APP_DSL_VERSION
    assert data["app"]["mode"] == "advanced-chat"
    assert node_ids == ["start", "reasoning_node", "answer"]
    assert graph["nodes"][0]["data"]["variables"][0]["variable"] == "user_query"
    assert graph["nodes"][1]["data"]["prompt_template"][0]["text"] == "Use {{#start.user_query#}}"
    assert graph["nodes"][2]["data"]["answer"] == "{{#reasoning_node.text#}}"
    assert graph["edges"][0]["source"] == "start"
    assert graph["edges"][0]["target"] == "reasoning_node"
    assert graph["edges"][1]["source"] == "reasoning_node"
    assert graph["edges"][1]["target"] == "answer"


def test_compile_workflow_mode_adds_end_node() -> None:
    data = _load_compiled(
        {
            "kind": "agent-network",
            "mode": "workflow",
            "app": {"name": "Batch Plan"},
            "nodes": [{"id": "parse", "type": "code", "title": "Parse"}],
        }
    )

    graph = data["workflow"]["graph"]
    end_node = graph["nodes"][-1]

    assert data["app"]["mode"] == "workflow"
    assert end_node["id"] == "end"
    assert end_node["data"]["type"] == "end"
    assert end_node["data"]["outputs"][0]["value_selector"] == ["parse", "result"]


def test_compile_preserves_branch_handles() -> None:
    data = _load_compiled(
        {
            "kind": "agent-network",
            "app": {"name": "Branching"},
            "nodes": [
                {"id": "branch", "type": "if-else", "title": "Branch"},
                {"id": "image", "type": "agent", "title": "Image Agent"},
                {"id": "text", "type": "agent", "title": "Text Agent"},
            ],
            "edges": [
                {"source": "start", "target": "branch"},
                {"source": "branch", "sourceHandle": "true", "target": "image"},
                {"source": "branch", "sourceHandle": "false", "target": "text"},
            ],
        }
    )

    branch_edges = [edge for edge in data["workflow"]["graph"]["edges"] if edge["source"] == "branch"]

    assert {edge["sourceHandle"] for edge in branch_edges} == {"true", "false"}
    assert all(edge["data"]["sourceType"] == "if-else" for edge in branch_edges)


def test_compile_rejects_branch_edge_without_source_handle() -> None:
    with pytest.raises(AgentNetworkCompilerError, match="source_handle"):
        compile_agent_network_to_dify_dsl(
            {
                "kind": "agent-network",
                "nodes": [
                    {"id": "branch", "type": "if-else", "title": "Branch"},
                    {"id": "next", "type": "agent", "title": "Next"},
                ],
                "edges": [
                    {"source": "start", "target": "branch"},
                    {"source": "branch", "target": "next"},
                ],
            }
        )


def test_compile_rejects_duplicate_node_id() -> None:
    with pytest.raises(AgentNetworkCompilerError, match="Duplicate node id"):
        compile_agent_network_to_dify_dsl(
            {
                "kind": "agent-network",
                "nodes": [
                    {"id": "same", "type": "llm"},
                    {"id": "same", "type": "llm"},
                ],
            }
        )


def test_compile_rejects_unknown_edge_target() -> None:
    with pytest.raises(AgentNetworkCompilerError, match="Unknown edge target"):
        compile_agent_network_to_dify_dsl(
            {
                "kind": "agent-network",
                "nodes": [{"id": "n1", "type": "llm"}],
                "edges": [{"source": "start", "target": "missing"}],
            }
        )


def test_compile_rejects_cycle() -> None:
    with pytest.raises(AgentNetworkCompilerError, match="cycle"):
        compile_agent_network_to_dify_dsl(
            {
                "kind": "agent-network",
                "nodes": [
                    {"id": "a", "type": "llm"},
                    {"id": "b", "type": "llm"},
                ],
                "edges": [
                    {"source": "start", "target": "a"},
                    {"source": "a", "target": "b"},
                    {"source": "b", "target": "a"},
                ],
            }
        )