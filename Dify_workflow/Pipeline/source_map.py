"""Build the sidecar mapping between Python flow semantics and Dify nodes."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import TypedDict, cast

from Pipeline.group_registry import GroupRegistry, validate_group_registry

SOURCE_MAP_VERSION = 1
DIFY_GRAPH_VERSION = "1.15.0"


class SourceMapError(ValueError):
    """Raised when semantics and a generated graph cannot be mapped safely."""


class WorkflowSourceMap(TypedDict):
    version: int
    dify_version: str
    source: dict[str, object]
    flow_semantics: dict[str, object]
    graph_nodes: dict[str, dict[str, object]]
    graph_sha256: str
    registry: dict[str, object] | None


def build_source_map(
    source: str,
    flow_semantics: Mapping[str, object],
    graph: Mapping[str, object],
    *,
    source_path: str | Path | None = None,
    group_registry: Mapping[str, object] | None = None,
) -> WorkflowSourceMap:
    """Create a deterministic sidecar for a graph generated from T1 semantics."""
    if flow_semantics.get("version") != 1:
        raise SourceMapError("SourceMap v1 requires Flow Semantics Contract v1.")
    normalized_semantics = _json_object(flow_semantics, "flow_semantics")
    normalized_graph = _json_object(graph, "graph")
    steps = _index_objects(normalized_semantics.get("steps"), "flow_semantics.steps")
    terminals = _index_objects(normalized_semantics.get("terminals"), "flow_semantics.terminals")
    input_names = _input_names(normalized_semantics.get("inputs"))
    graph_nodes = _mapping_for_graph_nodes(normalized_graph, steps, terminals, input_names)

    mapped_steps = {
        cast(str, item["semantic_id"])
        for item in graph_nodes.values()
        if item.get("kind") in {"call", "branch"}
    }
    missing_steps = set(steps) - mapped_steps
    if missing_steps:
        raise SourceMapError(f"Generated graph is missing semantic steps: {sorted(missing_steps)}")
    mapped_terminals = {
        cast(str, item["semantic_id"])
        for item in graph_nodes.values()
        if item.get("kind") == "terminal"
    }
    missing_terminals = set(terminals) - mapped_terminals
    if missing_terminals:
        raise SourceMapError(f"Generated graph is missing semantic terminals: {sorted(missing_terminals)}")

    registry_metadata: dict[str, object] | None = None
    if group_registry is not None:
        normalized_registry: GroupRegistry = validate_group_registry(group_registry)
        registry_metadata = {
            "version": normalized_registry["version"],
            "sha256": canonical_json_sha256(normalized_registry),
        }

    return {
        "version": SOURCE_MAP_VERSION,
        "dify_version": DIFY_GRAPH_VERSION,
        "source": {
            "path": Path(source_path).as_posix() if source_path is not None else None,
            "sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        },
        "flow_semantics": normalized_semantics,
        "graph_nodes": graph_nodes,
        "graph_sha256": canonical_json_sha256(normalized_graph),
        "registry": registry_metadata,
    }


def write_source_map(source_map: Mapping[str, object], output_path: str | Path) -> Path:
    """Write and read back a SourceMap JSON file."""
    normalized = _json_object(source_map, "source_map")
    if normalized.get("version") != SOURCE_MAP_VERSION:
        raise SourceMapError(f"SourceMap version must be {SOURCE_MAP_VERSION}.")
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    written = json.loads(path.read_text(encoding="utf-8"))
    if written != normalized:
        raise SourceMapError(f"SourceMap JSON read-back differs from generated data: {path}")
    return path.resolve()


def canonical_json_sha256(value: Mapping[str, object]) -> str:
    """Hash JSON semantics independently of indentation and key order."""
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _mapping_for_graph_nodes(
    graph: Mapping[str, object],
    steps: Mapping[str, Mapping[str, object]],
    terminals: Mapping[str, Mapping[str, object]],
    input_names: Sequence[str],
) -> dict[str, dict[str, object]]:
    raw_nodes = graph.get("nodes")
    if not isinstance(raw_nodes, list):
        raise SourceMapError("Graph field 'nodes' must be a list.")
    mappings: dict[str, dict[str, object]] = {}
    for index, raw_node in enumerate(raw_nodes):
        if not isinstance(raw_node, Mapping):
            raise SourceMapError(f"graph.nodes[{index}] must be an object.")
        node_id = raw_node.get("id")
        data = raw_node.get("data")
        if not isinstance(node_id, str) or not node_id:
            raise SourceMapError(f"graph.nodes[{index}].id must be a non-empty string.")
        if not isinstance(data, Mapping):
            raise SourceMapError(f"Graph node {node_id!r} must contain data.")
        node_type = data.get("type")

        if node_id == "start":
            if node_type != "start":
                raise SourceMapError("Graph node 'start' must have data.type 'start'.")
            mappings[node_id] = {"kind": "start", "input_names": list(input_names)}
            continue

        step = steps.get(node_id)
        if step is not None:
            kind = step.get("kind")
            expected_type = "llm" if kind == "call" else "if-else" if kind == "branch" else None
            if expected_type is None or node_type != expected_type:
                raise SourceMapError(
                    f"Graph node {node_id!r} does not match semantic step kind {kind!r}."
                )
            mapping: dict[str, object] = {"kind": kind, "semantic_id": node_id}
            if isinstance(step.get("lineno"), int):
                mapping["lineno"] = step["lineno"]
            if kind == "call":
                mapping.update(
                    {
                        "function": step.get("function"),
                        "assign_to": step.get("assign_to"),
                        "structured_fields": _structured_fields(data),
                    }
                )
            else:
                mapping.update(
                    {
                        "case_handles": _branch_case_handles(step),
                        "else_handle": "false",
                    }
                )
            mappings[node_id] = mapping
            continue

        terminal_id = _terminal_semantic_id(node_id, terminals)
        if terminal_id is not None:
            if node_type != "end":
                raise SourceMapError(f"Graph terminal node {node_id!r} must have data.type 'end'.")
            mappings[node_id] = {
                "kind": "terminal",
                "semantic_id": terminal_id,
                "producer_id": _end_node_producer(data),
            }
            continue

        raise SourceMapError(f"Graph node {node_id!r} has no matching T1 semantic object.")
    return mappings


def _structured_fields(data: Mapping[str, object]) -> dict[str, str]:
    structured = data.get("structured_output")
    if not isinstance(structured, Mapping):
        return {}
    schema = structured.get("schema")
    if not isinstance(schema, Mapping):
        return {}
    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        return {}
    fields: dict[str, str] = {}
    for raw_name, raw_definition in properties.items():
        if not isinstance(raw_name, str) or not isinstance(raw_definition, Mapping):
            continue
        field_type = raw_definition.get("type")
        if isinstance(field_type, str):
            fields[raw_name] = field_type
    return fields


def _branch_case_handles(step: Mapping[str, object]) -> dict[str, str]:
    raw_cases = step.get("cases")
    if not isinstance(raw_cases, list):
        return {}
    handles: dict[str, str] = {}
    for raw_case in raw_cases:
        if isinstance(raw_case, Mapping) and isinstance(raw_case.get("case_id"), str):
            case_id = cast(str, raw_case["case_id"])
            handles[case_id] = case_id
    return handles


def _terminal_semantic_id(
    node_id: str,
    terminals: Mapping[str, Mapping[str, object]],
) -> str | None:
    if node_id in terminals:
        return node_id
    for terminal_id in sorted(terminals, key=len, reverse=True):
        if node_id.startswith(f"{terminal_id}_"):
            return terminal_id
    return None


def _end_node_producer(data: Mapping[str, object]) -> str | None:
    outputs = data.get("outputs")
    if not isinstance(outputs, list) or not outputs or not isinstance(outputs[0], Mapping):
        return None
    selector = outputs[0].get("value_selector")
    if isinstance(selector, list) and selector and isinstance(selector[0], str):
        return cast(str, selector[0])
    return None


def _index_objects(value: object, field_name: str) -> dict[str, Mapping[str, object]]:
    if not isinstance(value, list):
        raise SourceMapError(f"{field_name} must be a list.")
    indexed: dict[str, Mapping[str, object]] = {}
    for index, item in enumerate(value):
        if not isinstance(item, Mapping) or not isinstance(item.get("id"), str):
            raise SourceMapError(f"{field_name}[{index}] must contain a string id.")
        object_id = cast(str, item["id"])
        if object_id in indexed:
            raise SourceMapError(f"{field_name} contains duplicate id {object_id!r}.")
        indexed[object_id] = item
    return indexed


def _input_names(value: object) -> list[str]:
    if not isinstance(value, list):
        raise SourceMapError("flow_semantics.inputs must be a list.")
    result: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping) or not isinstance(item.get("name"), str):
            raise SourceMapError(f"flow_semantics.inputs[{index}] must contain a string name.")
        result.append(cast(str, item["name"]))
    return result


def _json_object(value: Mapping[str, object], field_name: str) -> dict[str, object]:
    try:
        normalized = json.loads(json.dumps(value, ensure_ascii=False))
    except (TypeError, ValueError) as error:
        raise SourceMapError(f"{field_name} must be JSON serializable.") from error
    if not isinstance(normalized, dict):
        raise SourceMapError(f"{field_name} must be a JSON object.")
    return cast(dict[str, object], normalized)
