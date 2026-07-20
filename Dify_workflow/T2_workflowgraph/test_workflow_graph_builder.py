from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from T1_parser.pseudocode_parser import compile_to_semantics
from T2_workflowgraph.workflow_graph_builder import FlowGraphBuilder, FlowGraphBuilderError


MODEL = {
    "provider": "test-provider",
    "name": "test-model",
    "mode": "chat",
    "completion_params": {},
}

SOURCE = '''
probe = ReasoningGroup(
    task=f"判断下面的用户需求属于事实查询还是数值计算，"
         f"只返回 JSON：{{\\"kind\\": \\"search\\"}} 或 {{\\"kind\\": \\"calc\\"}}。\\n需求：{task}"
)
if probe.get("kind") == "calc":
    answer = CalculatorGroup(task=task)
else:
    answer = SearchGroup(task=task)
final_result = answer
'''


def build_example() -> dict[str, object]:
    semantics = compile_to_semantics(SOURCE)
    return FlowGraphBuilder(MODEL).build(semantics)


def node_map(graph: dict[str, object]) -> dict[str, dict[str, object]]:
    return {node["id"]: node for node in graph["nodes"]}


def edge_keys(graph: dict[str, object]) -> set[tuple[str, str, str, str]]:
    return {
        (edge["source"], edge["sourceHandle"], edge["target"], edge["targetHandle"])
        for edge in graph["edges"]
    }


def test_builds_workflow_graph_from_real_t1_output() -> None:
    graph = build_example()
    nodes = node_map(graph)

    assert set(nodes) == {
        "start",
        "reasoninggroup",
        "branch_1",
        "calculatorgroup",
        "searchgroup",
        "terminal_1_calculatorgroup",
        "terminal_1_searchgroup",
    }
    assert graph["viewport"] == {"x": 0.0, "y": 0.0, "zoom": 0.7}
    assert all(nodes[node_id]["data"]["type"] == "llm" for node_id in {
        "reasoninggroup", "calculatorgroup", "searchgroup"
    })
    assert nodes["start"]["data"]["variables"][0]["type"] == "text-input"
    assert nodes["reasoninggroup"]["data"]["prompt_template"][0]["text"].endswith("{{#start.task#}}")


def test_enables_structured_output_for_get_condition() -> None:
    nodes = node_map(build_example())
    reasoning = nodes["reasoninggroup"]["data"]
    assert reasoning["structured_output_enabled"] is True
    assert reasoning["structured_output"] == {
        "schema": {
            "type": "object",
            "properties": {"kind": {"type": "string"}},
            "required": ["kind"],
            "additionalProperties": False,
        }
    }
    assert nodes["calculatorgroup"]["data"]["structured_output_enabled"] is False


def test_branch_uses_structured_output_selector_and_valid_handle_ids() -> None:
    graph = build_example()
    nodes = node_map(graph)
    condition = nodes["branch_1"]["data"]["cases"][0]["conditions"][0]
    assert condition == {
        "id": "branch_1_case_1_0",
        "varType": "string",
        "variable_selector": ["reasoninggroup", "structured_output", "kind"],
        "comparison_operator": "is",
        "value": "calc",
    }
    assert ("branch_1", "case_1", "calculatorgroup", "target") in edge_keys(graph)
    assert ("branch_1", "false", "searchgroup", "target") in edge_keys(graph)


def test_workflow_uses_end_nodes_with_branch_specific_outputs() -> None:
    graph = build_example()
    nodes = node_map(graph)
    assert nodes["terminal_1_calculatorgroup"]["data"] == {
        "type": "end",
        "title": "End",
        "desc": "",
        "selected": False,
        "outputs": [
            {
                "variable": "final_result",
                "value_selector": ["calculatorgroup", "text"],
                "value_type": "string",
            }
        ],
    }
    assert nodes["terminal_1_searchgroup"]["data"]["outputs"][0]["value_selector"] == [
        "searchgroup", "text"
    ]
    assert all(node["data"]["type"] != "answer" for node in graph["nodes"])


def test_edges_include_dify_source_and_target_types() -> None:
    graph = build_example()
    edges = {
        (edge["source"], edge["target"]): edge
        for edge in graph["edges"]
    }
    assert edges[("start", "reasoninggroup")]["data"]["sourceType"] == "start"
    assert edges[("reasoninggroup", "branch_1")]["data"]["targetType"] == "if-else"
    assert edges[("calculatorgroup", "terminal_1_calculatorgroup")]["data"]["targetType"] == "end"


def test_layout_is_topological_and_separates_branch_lanes() -> None:
    nodes = node_map(build_example())
    assert nodes["start"]["position"]["x"] < nodes["reasoninggroup"]["position"]["x"]
    assert nodes["reasoninggroup"]["position"]["x"] < nodes["branch_1"]["position"]["x"]
    assert nodes["calculatorgroup"]["position"]["x"] == nodes["searchgroup"]["position"]["x"]
    assert nodes["calculatorgroup"]["position"]["y"] != nodes["searchgroup"]["position"]["y"]
    for node in nodes.values():
        assert node["positionAbsolute"] == node["position"]


def test_default_config_is_merged_without_mutating_caller_data() -> None:
    default_config = {
        "type": "llm",
        "config": {
            "context": {"enabled": False, "variable_selector": []},
            "vision": {"enabled": False},
            "custom_default": "kept",
        },
    }
    original = json.loads(json.dumps(default_config))
    graph = FlowGraphBuilder(MODEL, llm_default_config=default_config).build(
        compile_to_semantics(SOURCE)
    )
    assert node_map(graph)["reasoninggroup"]["data"]["custom_default"] == "kept"
    assert default_config == original


def test_non_group_function_is_rejected() -> None:
    semantics = compile_to_semantics("result = helper(task=task)\nfinal_result = result")
    with pytest.raises(FlowGraphBuilderError, match="ending in 'Group'"):
        FlowGraphBuilder(MODEL).build(semantics)


def test_raw_condition_is_rejected_instead_of_guessing() -> None:
    semantics = compile_to_semantics(
        "probe = ReasoningGroup(task=task)\n"
        "if probe.get('kind').lower() == 'calc':\n"
        "    answer = CalculatorGroup(task=task)\n"
        "else:\n"
        "    answer = SearchGroup(task=task)\n"
        "final_result = answer"
    )
    with pytest.raises(FlowGraphBuilderError, match="generation unsafe"):
        FlowGraphBuilder(MODEL).build(semantics)


def test_number_structured_field_uses_numeric_operator() -> None:
    semantics = compile_to_semantics(
        "probe = ReasoningGroup(task=task)\n"
        "if probe.get('score') >= 0.8:\n"
        "    answer = HighGroup(task=task)\n"
        "else:\n"
        "    answer = LowGroup(task=task)\n"
        "final_result = answer"
    )
    graph = FlowGraphBuilder(MODEL).build(semantics)
    nodes = node_map(graph)
    schema = nodes["reasoninggroup"]["data"]["structured_output"]["schema"]
    assert schema["properties"]["score"] == {"type": "number"}
    condition = nodes["branch_1"]["data"]["cases"][0]["conditions"][0]
    assert condition["varType"] == "number"
    assert condition["comparison_operator"] == "≥"
    assert condition["value"] == "0.8"


def test_truthy_condition_can_reference_start_input() -> None:
    semantics = compile_to_semantics(
        "if flag:\n"
        "    answer = EnabledGroup(task=task)\n"
        "else:\n"
        "    answer = DisabledGroup(task=task)\n"
        "final_result = answer"
    )
    graph = FlowGraphBuilder(MODEL).build(semantics)
    condition = node_map(graph)["branch_1"]["data"]["cases"][0]["conditions"][0]
    assert condition["variable_selector"] == ["start", "flag"]
    assert condition["comparison_operator"] == "not empty"
    assert condition["value"] == ""


def test_nested_branch_control_flow_is_reconstructed_from_case_bodies() -> None:
    semantics = compile_to_semantics(
        "probe = ReasoningGroup(task=task)\n"
        "if probe.get('kind') == 'a':\n"
        "    detail = DetailGroup(task=task)\n"
        "    if detail.get('ok') == True:\n"
        "        answer = AGroup(task=task)\n"
        "    else:\n"
        "        answer = BGroup(task=task)\n"
        "else:\n"
        "    answer = CGroup(task=task)\n"
        "final_result = answer"
    )
    graph = FlowGraphBuilder(MODEL).build(semantics)
    edges = edge_keys(graph)
    assert ("branch_1", "case_1", "detailgroup", "target") in edges
    assert ("detailgroup", "source", "branch_2", "target") in edges
    assert ("branch_2", "case_1", "agroup", "target") in edges
    assert ("branch_2", "false", "bgroup", "target") in edges
    assert ("branch_1", "false", "cgroup", "target") in edges
