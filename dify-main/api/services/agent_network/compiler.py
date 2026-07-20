"""Compile external agent-network IR into native Dify app DSL.

The compiler emits the same ``workflow.graph`` shape that Dify stores in draft
workflows. It favors importable, readable canvas output over full publish-time
runtime completeness; callers can still pass native node ``config`` fields when
they want a generated node to be executable.
"""

import re
from collections import deque
from collections.abc import Mapping
from copy import deepcopy
from typing import Any, cast

import yaml
from pydantic import ValidationError

from constants.dsl_version import CURRENT_APP_DSL_VERSION
from .entities import AgentNetworkCanvasIR, AgentNetworkCompilerError, AgentNetworkNode

DEFAULT_NODE_WIDTH = 244
DEFAULT_NODE_HEIGHT = 90
DEFAULT_VIEWPORT = {"x": 0.0, "y": 0.0, "zoom": 0.7}
START_NODE_ID = "start"
ANSWER_NODE_ID = "answer"
END_NODE_ID = "end"
BRANCH_NODE_TYPES = {"if-else", "question-classifier"}

_INVALID_ID_CHARS_RE = re.compile(r"[^a-zA-Z0-9_]")
_INVALID_VAR_CHARS_RE = re.compile(r"[^a-zA-Z0-9_]")


def parse_agent_network_canvas_ir(payload: Mapping[str, Any]) -> AgentNetworkCanvasIR:
    """Validate an external agent-network document before DSL compilation."""
    try:
        return AgentNetworkCanvasIR.model_validate(payload)
    except ValidationError as exc:
        raise AgentNetworkCompilerError(str(exc)) from exc


def compile_agent_network_to_dify_dsl(ir: AgentNetworkCanvasIR | Mapping[str, Any]) -> str:
    """Compile an agent-network IR object or mapping into native Dify app DSL YAML."""
    document = ir if isinstance(ir, AgentNetworkCanvasIR) else parse_agent_network_canvas_ir(ir)

    id_map = _build_node_id_map(document.nodes)
    start_variable_map = _build_start_variable_map(document)
    normalized_nodes = [
        _normalize_node(node=node, node_id=id_map[node.id], id_map=id_map, start_variable_map=start_variable_map)
        for node in document.nodes
    ]
    node_type_by_id = {node["id"]: node["type"] for node in normalized_nodes}
    node_type_by_id[START_NODE_ID] = "start"

    graph_edges = _normalize_edges(
        document=document,
        id_map=id_map,
        node_type_by_id=node_type_by_id,
        normalized_nodes=normalized_nodes,
    )
    terminal_nodes = _ensure_terminal_node(
        mode=document.mode,
        normalized_nodes=normalized_nodes,
        graph_edges=graph_edges,
        node_type_by_id=node_type_by_id,
    )
    all_node_ids = [START_NODE_ID, *(node["id"] for node in normalized_nodes), *(node["id"] for node in terminal_nodes)]
    _validate_no_cycles(node_ids=all_node_ids, edges=graph_edges)

    positions = _compute_positions(
        node_ids=all_node_ids,
        edges=graph_edges,
        normalized_nodes=normalized_nodes,
        terminal_nodes=terminal_nodes,
    )
    graph_nodes = [
        _build_start_node(
            document=document,
            variable_map=start_variable_map,
            position=positions[START_NODE_ID],
        )
    ]
    graph_nodes.extend(_build_graph_node(node=node, position=positions[node["id"]]) for node in normalized_nodes)
    graph_nodes.extend(_build_graph_node(node=node, position=positions[node["id"]]) for node in terminal_nodes)

    payload = {
        "version": CURRENT_APP_DSL_VERSION,
        "kind": "app",
        "app": {
            "name": document.app.name,
            "mode": document.mode,
            "icon": document.app.icon,
            "icon_type": document.app.icon_type,
            "icon_background": document.app.icon_background,
            "description": document.app.description,
            "use_icon_as_answer_icon": document.app.use_icon_as_answer_icon,
        },
        "dependencies": [],
        "workflow": {
            "conversation_variables": [],
            "environment_variables": [],
            "features": _default_features(),
            "graph": {
                "nodes": graph_nodes,
                "edges": graph_edges,
                "viewport": DEFAULT_VIEWPORT,
            },
        },
    }
    return yaml.safe_dump(payload, sort_keys=False, allow_unicode=True)


def _build_node_id_map(nodes: list[AgentNetworkNode]) -> dict[str, str]:
    seen_raw_ids: set[str] = set()
    used_ids = {START_NODE_ID}
    id_map: dict[str, str] = {}
    for node in nodes:
        if node.id in seen_raw_ids:
            raise AgentNetworkCompilerError(f"Duplicate node id: {node.id}")
        if node.id == START_NODE_ID:
            raise AgentNetworkCompilerError("Node id 'start' is reserved for the generated Dify start node")
        seen_raw_ids.add(node.id)

        base_id = _sanitize_node_id(node.id)
        new_id = base_id
        suffix = 2
        while new_id in used_ids:
            new_id = f"{base_id}_{suffix}"
            suffix += 1
        used_ids.add(new_id)
        id_map[node.id] = new_id
    return id_map


def _build_start_variable_map(document: AgentNetworkCanvasIR) -> dict[str, str]:
    used: set[str] = set()
    variable_map: dict[str, str] = {}
    for input_item in document.inputs:
        sanitized = _sanitize_variable_name(input_item.variable)
        new_variable = sanitized
        suffix = 2
        while new_variable in used:
            new_variable = f"{sanitized[:27]}_{suffix}"
            suffix += 1
        used.add(new_variable)
        variable_map[input_item.variable] = new_variable
    return variable_map


def _normalize_node(
    *,
    node: AgentNetworkNode,
    node_id: str,
    id_map: Mapping[str, str],
    start_variable_map: Mapping[str, str],
) -> dict[str, Any]:
    node_type = _normalize_node_type(node.node_type)
    config = _rewrite_references(deepcopy(node.config), id_map=id_map, start_variable_map=start_variable_map)
    title = node.title or _humanize_identifier(node.id)
    position = node.position.model_dump() if node.position else None
    return {
        "id": node_id,
        "type": node_type,
        "title": title,
        "desc": node.description,
        "config": config,
        "position": position,
    }


def _normalize_edges(
    *,
    document: AgentNetworkCanvasIR,
    id_map: Mapping[str, str],
    node_type_by_id: Mapping[str, str],
    normalized_nodes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    raw_edges = [(edge.source, edge.target, edge.source_handle, edge.target_handle) for edge in document.edges]
    if not raw_edges and normalized_nodes:
        previous = START_NODE_ID
        for node in normalized_nodes:
            source_handle = "true" if node_type_by_id[previous] in BRANCH_NODE_TYPES else None
            raw_edges.append((previous, node["id"], source_handle, None))
            previous = node["id"]

    edges: list[dict[str, Any]] = []
    for raw_source, raw_target, raw_source_handle, raw_target_handle in raw_edges:
        source = _resolve_node_ref(raw_source, id_map=id_map)
        target = _resolve_node_ref(raw_target, id_map=id_map)
        if source not in node_type_by_id:
            raise AgentNetworkCompilerError(f"Unknown edge source: {raw_source}")
        if target not in node_type_by_id:
            raise AgentNetworkCompilerError(f"Unknown edge target: {raw_target}")

        if node_type_by_id[source] in BRANCH_NODE_TYPES:
            if not raw_source_handle or raw_source_handle == "source":
                raise AgentNetworkCompilerError(f"Branch node edge requires a source_handle: {raw_source}")
            source_handle = raw_source_handle
        else:
            source_handle = raw_source_handle or "source"
        target_handle = raw_target_handle or "target"
        edges.append(_build_edge(source, target, source_handle, target_handle, node_type_by_id))
    return edges


def _ensure_terminal_node(
    *,
    mode: str,
    normalized_nodes: list[dict[str, Any]],
    graph_edges: list[dict[str, Any]],
    node_type_by_id: dict[str, str],
) -> list[dict[str, Any]]:
    terminal_type = "answer" if mode == "advanced-chat" else "end"
    if any(node["type"] == terminal_type for node in normalized_nodes):
        return []

    terminal_id = ANSWER_NODE_ID if terminal_type == "answer" else END_NODE_ID
    if terminal_id in node_type_by_id:
        terminal_id = f"{terminal_id}_generated"
    node_type_by_id[terminal_id] = terminal_type

    source_ids = {edge["source"] for edge in graph_edges}
    sink_ids = [node["id"] for node in normalized_nodes if node["id"] not in source_ids]
    if not sink_ids:
        sink_ids = [START_NODE_ID]

    terminal_node = _build_terminal_node(
        terminal_id=terminal_id,
        terminal_type=terminal_type,
        sink_ids=sink_ids,
        node_type_by_id=node_type_by_id,
    )
    for sink_id in sink_ids:
        if node_type_by_id[sink_id] in BRANCH_NODE_TYPES:
            continue
        graph_edges.append(_build_edge(sink_id, terminal_id, "source", "target", node_type_by_id))
    return [terminal_node]


def _build_terminal_node(
    *,
    terminal_id: str,
    terminal_type: str,
    sink_ids: list[str],
    node_type_by_id: Mapping[str, str],
) -> dict[str, Any]:
    selector = _default_selector_for_sink(sink_ids[0], node_type_by_id.get(sink_ids[0], "")) if sink_ids else None
    if terminal_type == "answer":
        answer = f"{{{{#{selector[0]}.{selector[1]}#}}}}" if selector else "Workflow completed."
        config = {"answer": answer, "variables": []}
    else:
        config = {
            "outputs": [
                {
                    "variable": "result",
                    "value_selector": list(selector) if selector else [START_NODE_ID, "query"],
                    "value_type": "string",
                }
            ]
        }
    return {
        "id": terminal_id,
        "type": terminal_type,
        "title": "Answer" if terminal_type == "answer" else "End",
        "desc": "",
        "config": config,
        "position": None,
    }


def _build_start_node(
    *,
    document: AgentNetworkCanvasIR,
    variable_map: Mapping[str, str],
    position: Mapping[str, float],
) -> dict[str, Any]:
    variables = []
    for input_item in document.inputs:
        variable_type = input_item.input_type
        variable = {
            "label": input_item.label or input_item.variable,
            "variable": variable_map[input_item.variable],
            "type": variable_type,
            "required": input_item.required,
            "max_length": input_item.max_length,
            "options": input_item.options,
        }
        if variable_type in {"file", "file-list"}:
            variable["allowed_file_types"] = input_item.allowed_file_types or ["image", "document"]
            variable["allowed_file_extensions"] = input_item.allowed_file_extensions
            variable["allowed_file_upload_methods"] = input_item.allowed_file_upload_methods
        variables.append(variable)

    return _graph_node(
        node_id=START_NODE_ID,
        node_type="start",
        data={"desc": "", "selected": False, "title": "Start", "type": "start", "variables": variables},
        position=position,
        height=90,
    )


def _build_graph_node(*, node: Mapping[str, Any], position: Mapping[str, float]) -> dict[str, Any]:
    node_type = cast(str, node["type"])
    data = _build_node_data(node)
    return _graph_node(
        node_id=cast(str, node["id"]),
        node_type=node_type,
        data=data,
        position=position,
        height=_height_for_node_type(node_type),
    )


def _build_node_data(node: Mapping[str, Any]) -> dict[str, Any]:
    node_type = cast(str, node["type"])
    config = cast(dict[str, Any], deepcopy(node.get("config") or {}))
    base = {"desc": node.get("desc", ""), "selected": False, "title": node["title"], "type": node_type}

    match node_type:
        case "llm":
            data = {
                **base,
                "model": config.pop(
                    "model",
                    {"provider": "", "name": "", "mode": "chat", "completion_params": {"temperature": 0.7}},
                ),
                "prompt_template": config.pop("prompt_template", [{"role": "system", "text": node.get("desc") or ""}]),
                "context": config.pop("context", {"enabled": False, "variable_selector": []}),
                "memory": config.pop(
                    "memory",
                    {
                        "query_prompt_template": "",
                        "role_prefix": {"assistant": "", "user": ""},
                        "window": {"enabled": False, "size": 10},
                    },
                ),
                "vision": config.pop("vision", {"enabled": False}),
                "variables": config.pop("variables", []),
            }
        case "if-else":
            data = {**base, "cases": _normalize_cases(config)}
        case "http-request":
            data = {
                **base,
                "variables": config.pop("variables", []),
                "method": config.pop("method", "get"),
                "url": config.pop("url", ""),
                "authorization": config.pop("authorization", {"type": "no-auth", "config": None}),
                "headers": config.pop("headers", ""),
                "params": config.pop("params", ""),
                "body": config.pop("body", {"type": "none", "data": []}),
                "ssl_verify": config.pop("ssl_verify", True),
                "timeout": config.pop(
                    "timeout",
                    {"max_connect_timeout": 0, "max_read_timeout": 0, "max_write_timeout": 0},
                ),
                "retry_config": config.pop(
                    "retry_config",
                    {"retry_enabled": True, "max_retries": 3, "retry_interval": 100},
                ),
            }
        case "code":
            data = {
                **base,
                "code": config.pop("code", "def main() -> dict:\n    return {\"result\": \"\"}\n"),
                "code_language": config.pop("code_language", "python3"),
                "variables": config.pop("variables", []),
                "outputs": config.pop("outputs", {"result": {"type": "string", "children": None}}),
            }
        case "template-transform":
            data = {**base, "template": config.pop("template", "{{ input }}"), "variables": config.pop("variables", [])}
        case "agent":
            data = {
                **base,
                "agent_node_kind": config.pop("agent_node_kind", "dify_agent"),
                "version": config.pop("version", "2"),
                "agent_task": config.pop("agent_task", node.get("desc") or node["title"]),
                "agent_declared_outputs": config.pop(
                    "agent_declared_outputs",
                    [{"name": "output", "type": "string", "description": "Agent output"}],
                ),
            }
        case "answer":
            data = {
                **base,
                "answer": config.pop("answer", "Workflow completed."),
                "variables": config.pop("variables", []),
            }
        case "end":
            data = {**base, "outputs": config.pop("outputs", [])}
        case "knowledge-retrieval":
            data = {
                **base,
                "dataset_ids": config.pop("dataset_ids", []),
                "query_variable_selector": config.pop("query_variable_selector", [START_NODE_ID, "query"]),
                "retrieval_mode": config.pop("retrieval_mode", "single"),
                "multiple_retrieval_config": config.pop("multiple_retrieval_config", {"reranking_enable": False}),
            }
        case "tool":
            data = {
                **base,
                "provider_id": config.pop("provider_id", ""),
                "provider_name": config.pop("provider_name", ""),
                "provider_type": config.pop("provider_type", "builtin"),
                "tool_name": config.pop("tool_name", ""),
                "tool_label": config.pop("tool_label", node["title"]),
                "tool_parameters": config.pop("tool_parameters", {}),
            }
        case _:
            data = base

    data.update(config)
    data["type"] = node_type
    data["title"] = node["title"]
    data["desc"] = node.get("desc", "")
    return data


def _normalize_cases(config: dict[str, Any]) -> list[dict[str, Any]]:
    raw_cases = config.pop("cases", None)
    if isinstance(raw_cases, list) and raw_cases:
        return [cast(dict[str, Any], case) for case in raw_cases]
    raw_conditions = config.pop("conditions", [])
    return [{"case_id": "true", "logical_operator": "and", "conditions": raw_conditions}]


def _graph_node(
    *,
    node_id: str,
    node_type: str,
    data: Mapping[str, Any],
    position: Mapping[str, float],
    height: int,
) -> dict[str, Any]:
    position_payload = {"x": float(position["x"]), "y": float(position["y"])}
    return {
        "data": dict(data),
        "height": height,
        "id": node_id,
        "position": position_payload,
        "positionAbsolute": dict(position_payload),
        "selected": False,
        "sourcePosition": "right",
        "targetPosition": "left",
        "type": "custom",
        "width": DEFAULT_NODE_WIDTH,
    }


def _build_edge(
    source: str,
    target: str,
    source_handle: str,
    target_handle: str,
    node_type_by_id: Mapping[str, str],
) -> dict[str, Any]:
    return {
        "data": {
            "isInIteration": False,
            "isInLoop": False,
            "sourceType": node_type_by_id[source],
            "targetType": node_type_by_id[target],
        },
        "id": f"{source}-{source_handle}-{target}-{target_handle}",
        "selected": False,
        "source": source,
        "sourceHandle": source_handle,
        "target": target,
        "targetHandle": target_handle,
        "type": "custom",
        "zIndex": 0,
    }


def _compute_positions(
    *,
    node_ids: list[str],
    edges: list[dict[str, Any]],
    normalized_nodes: list[dict[str, Any]],
    terminal_nodes: list[dict[str, Any]],
) -> dict[str, dict[str, float]]:
    explicit_positions = {
        node["id"]: node["position"]
        for node in [*normalized_nodes, *terminal_nodes]
        if isinstance(node.get("position"), dict)
    }
    depth_by_id = {node_id: 0 for node_id in node_ids}
    incoming_count = {node_id: 0 for node_id in node_ids}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    for edge in edges:
        outgoing[edge["source"]].append(edge["target"])
        incoming_count[edge["target"]] += 1

    queue = deque([node_id for node_id in node_ids if incoming_count[node_id] == 0])
    while queue:
        node_id = queue.popleft()
        for target in outgoing[node_id]:
            depth_by_id[target] = max(depth_by_id[target], depth_by_id[node_id] + 1)
            incoming_count[target] -= 1
            if incoming_count[target] == 0:
                queue.append(target)

    lane_by_depth: dict[int, int] = {}
    positions: dict[str, dict[str, float]] = {}
    for node_id in node_ids:
        if node_id in explicit_positions:
            positions[node_id] = cast(dict[str, float], explicit_positions[node_id])
            continue
        depth = depth_by_id[node_id]
        lane = lane_by_depth.get(depth, 0)
        lane_by_depth[depth] = lane + 1
        positions[node_id] = {"x": 80.0 + depth * 320.0, "y": 120.0 + lane * 170.0}
    return positions


def _validate_no_cycles(*, node_ids: list[str], edges: list[dict[str, Any]]) -> None:
    known_ids = set(node_ids)
    incoming_count = {node_id: 0 for node_id in known_ids}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in known_ids}
    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source == target:
            raise AgentNetworkCompilerError(f"Workflow graph contains a self-cycle on node: {source}")
        outgoing[source].append(target)
        incoming_count[target] += 1

    queue = deque([node_id for node_id, count in incoming_count.items() if count == 0])
    visited = 0
    while queue:
        node_id = queue.popleft()
        visited += 1
        for target in outgoing[node_id]:
            incoming_count[target] -= 1
            if incoming_count[target] == 0:
                queue.append(target)
    if visited != len(known_ids):
        raise AgentNetworkCompilerError("Workflow graph contains a cycle")


def _default_features() -> dict[str, Any]:
    return {
        "file_upload": {
            "enabled": False,
            "allowed_file_extensions": [".JPG", ".JPEG", ".PNG", ".GIF", ".WEBP", ".SVG"],
            "allowed_file_types": ["image"],
            "allowed_file_upload_methods": ["local_file", "remote_url"],
            "number_limits": 3,
            "image": {"enabled": False, "number_limits": 3, "transfer_methods": ["local_file", "remote_url"]},
            "fileUploadConfig": {
                "file_size_limit": 15,
                "batch_count_limit": 5,
                "image_file_size_limit": 10,
                "video_file_size_limit": 100,
                "audio_file_size_limit": 50,
                "workflow_file_upload_limit": 10,
            },
        },
        "opening_statement": "",
        "retriever_resource": {"enabled": True},
        "sensitive_word_avoidance": {"enabled": False},
        "speech_to_text": {"enabled": False},
        "suggested_questions": [],
        "suggested_questions_after_answer": {"enabled": False},
        "text_to_speech": {"enabled": False, "language": "", "voice": ""},
    }


def _normalize_node_type(node_type: str) -> str:
    normalized = node_type.strip().lower().replace("_", "-")
    aliases = {
        "model": "llm",
        "reasoning": "llm",
        "condition": "if-else",
        "branch": "if-else",
        "if": "if-else",
        "ifelse": "if-else",
        "api": "http-request",
        "http": "http-request",
        "parser": "code",
        "parse": "code",
        "transform-code": "code",
        "template": "template-transform",
        "agent-v2": "agent",
        "custom-agent": "agent",
        "worker": "agent",
        "reply": "answer",
        "terminal": "end",
        "retrieval": "knowledge-retrieval",
        "knowledge": "knowledge-retrieval",
    }
    normalized = aliases.get(normalized, normalized)
    supported = {
        "llm",
        "if-else",
        "http-request",
        "code",
        "template-transform",
        "agent",
        "answer",
        "end",
        "knowledge-retrieval",
        "tool",
    }
    return normalized if normalized in supported else "agent"


def _resolve_node_ref(raw_id: str, *, id_map: Mapping[str, str]) -> str:
    if raw_id == START_NODE_ID:
        return START_NODE_ID
    return id_map.get(raw_id, raw_id)


def _sanitize_node_id(raw_id: str) -> str:
    sanitized = _INVALID_ID_CHARS_RE.sub("_", raw_id.strip())
    sanitized = sanitized.strip("_") or "node"
    if sanitized[0].isdigit():
        sanitized = f"node_{sanitized}"
    return sanitized[:48]


def _sanitize_variable_name(raw_variable: str) -> str:
    sanitized = _INVALID_VAR_CHARS_RE.sub("_", raw_variable.strip())
    sanitized = sanitized.strip("_") or "input"
    if sanitized[0].isdigit():
        sanitized = f"input_{sanitized}"
    return sanitized[:30]


def _rewrite_references(
    value: Any,
    *,
    id_map: Mapping[str, str],
    start_variable_map: Mapping[str, str],
) -> Any:
    if isinstance(value, str):
        rewritten = value
        for old_id, new_id in id_map.items():
            rewritten = rewritten.replace(f"{{{{#{old_id}.", f"{{{{#{new_id}.")
        for old_variable, new_variable in start_variable_map.items():
            rewritten = rewritten.replace(f"{{{{#start.{old_variable}#}}}}", f"{{{{#start.{new_variable}#}}}}")
        return rewritten
    if isinstance(value, list):
        if len(value) >= 2 and isinstance(value[0], str):
            node_id = id_map.get(value[0], value[0])
            variable = value[1]
            if node_id == START_NODE_ID and isinstance(variable, str):
                variable = start_variable_map.get(variable, variable)
            return [
                node_id,
                variable,
                *[
                    _rewrite_references(item, id_map=id_map, start_variable_map=start_variable_map)
                    for item in value[2:]
                ],
            ]
        return [_rewrite_references(item, id_map=id_map, start_variable_map=start_variable_map) for item in value]
    if isinstance(value, dict):
        return {
            key: _rewrite_references(item, id_map=id_map, start_variable_map=start_variable_map)
            for key, item in value.items()
        }
    return value


def _default_selector_for_sink(sink_id: str, sink_type: str) -> tuple[str, str]:
    if sink_id == START_NODE_ID:
        return (START_NODE_ID, "query")
    output_by_type = {
        "agent": "output",
        "code": "result",
        "http-request": "body",
        "knowledge-retrieval": "result",
        "template-transform": "output",
    }
    return (sink_id, output_by_type.get(sink_type, "text"))


def _height_for_node_type(node_type: str) -> int:
    if node_type == "if-else":
        return 126
    if node_type in {"code", "template-transform"}:
        return 54
    return DEFAULT_NODE_HEIGHT


def _humanize_identifier(value: str) -> str:
    return value.replace("_", " ").replace("-", " ").strip().title() or "Node"
