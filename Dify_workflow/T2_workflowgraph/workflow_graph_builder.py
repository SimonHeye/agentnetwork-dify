"""Convert T1 flow semantics into a Dify 1.15 workflow graph.

The first version targets Dify ``workflow`` applications only. Every Python
function whose name ends with ``Group`` becomes an LLM node. Conditions using
``value.get("field")`` enable structured output on the producing LLM and
reference ``[node_id, "structured_output", "field"]`` from the if-else node.

This module is pure conversion logic. It does not access Dify, credentials, a
database, or the draft-sync API. A caller supplies the model selection and may
optionally merge the LLM default config returned by the local Dify instance.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
from copy import deepcopy
from typing import NotRequired, TypedDict, cast

START_NODE_ID = "start"
NODE_RENDER_TYPE = "custom"
SOURCE_HANDLE = "source"
TARGET_HANDLE = "target"
FALSE_HANDLE = "false"
DEFAULT_VIEWPORT = {"x": 0.0, "y": 0.0, "zoom": 0.7}
NODE_WIDTH = 244
NODE_HEIGHT = 90
BRANCH_HEIGHT = 126
BASE_X = 80.0
BASE_Y = 280.0
HORIZONTAL_GAP = 320.0
VERTICAL_GAP = 180.0

INPUT_TYPE_MAP = {
    "paragraph": "text-input",
    "text-input": "text-input",
    "number": "number",
    "file": "file",
    "file-list": "file-list",
    "select": "select",
}


class FlowGraphBuilderError(ValueError):
    """Raised when T1 semantics cannot be represented by the T2 v1 graph."""


class ModelConfig(TypedDict):
    provider: str
    name: str
    mode: str
    completion_params: NotRequired[Mapping[str, object]]


class GroupOverride(TypedDict, total=False):
    title: str
    model: ModelConfig
    default_config: Mapping[str, object]


class _Step(TypedDict, total=False):
    id: str
    kind: str
    function: str
    assign_to: str | None
    args: list[Mapping[str, object]]
    kwargs: Mapping[str, Mapping[str, object]]
    cases: list[Mapping[str, object]]
    else_case: Mapping[str, object]
    lineno: int


class _Incoming(TypedDict):
    node_id: str
    source_handle: str


class FlowGraphBuilder:
    """Build a Dify workflow graph from the T1 Flow Semantics Contract v1."""

    def __init__(
        self,
        model_config: ModelConfig,
        *,
        llm_default_config: Mapping[str, object] | None = None,
        group_overrides: Mapping[str, GroupOverride] | None = None,
    ) -> None:
        self._model_config = self._validate_model_config(model_config)
        self._llm_default_config = self._normalize_default_config(llm_default_config)
        self._group_overrides = dict(group_overrides or {})
        self._steps: dict[str, _Step] = {}
        self._bindings: dict[str, Mapping[str, object]] = {}
        self._terminals: dict[str, Mapping[str, object]] = {}
        self._variables: dict[str, list[str]] = {}
        self._input_types: dict[str, str] = {}
        self._structured_fields: dict[str, dict[str, str]] = {}
        self._nodes: list[dict[str, object]] = []
        self._edges: list[dict[str, object]] = []
        self._node_type_by_id: dict[str, str] = {}
        self._seen_edges: set[tuple[str, str, str, str]] = set()
        self._visited_steps: set[str] = set()
        self._terminal_node_count: dict[str, int] = {}

    def build(self, flow_semantics: Mapping[str, object]) -> dict[str, object]:
        """Return ``{nodes, edges, viewport}`` for a Dify workflow draft."""
        self._reset_build_state()
        self._load_semantics(flow_semantics)
        self._infer_structured_outputs()

        self._append_node(self._build_start_node(self._require_mapping_list(flow_semantics, "inputs")))
        for step in self._steps.values():
            if step["kind"] == "call":
                self._append_node(self._build_group_node(step))
            elif step["kind"] == "branch":
                self._append_node(self._build_branch_node(step))

        root_body = self._require_string_list(flow_semantics, "body")
        exits = self._walk_sequence(root_body, [{"node_id": START_NODE_ID, "source_handle": SOURCE_HANDLE}])
        if exits:
            raise FlowGraphBuilderError("Flow body finishes without reaching a terminal.")

        missing_steps = set(self._steps) - self._visited_steps
        if missing_steps:
            raise FlowGraphBuilderError(f"Flow contains steps not referenced by body sequences: {sorted(missing_steps)}")

        self._fill_edge_types()
        self._apply_topological_layout()
        self._validate_graph()
        return {
            "nodes": self._nodes,
            "edges": self._edges,
            "viewport": dict(DEFAULT_VIEWPORT),
        }

    def _reset_build_state(self) -> None:
        self._steps = {}
        self._bindings = {}
        self._terminals = {}
        self._variables = {}
        self._input_types = {}
        self._structured_fields = {}
        self._nodes = []
        self._edges = []
        self._node_type_by_id = {}
        self._seen_edges = set()
        self._visited_steps = set()
        self._terminal_node_count = {}

    def _load_semantics(self, flow_semantics: Mapping[str, object]) -> None:
        if flow_semantics.get("version") != 1:
            raise FlowGraphBuilderError(
                f"Unsupported flow semantics version {flow_semantics.get('version')!r}; expected 1."
            )
        warnings = flow_semantics.get("warnings", [])
        if not isinstance(warnings, list):
            raise FlowGraphBuilderError("Flow semantics field 'warnings' must be a list.")
        fatal_warning_fragments = (
            "无法结构化",
            "并非在所有执行路径上都有定义",
            "分支位于流程末尾但没有 else",
            "未能推断出流程输出",
        )
        if any(
            isinstance(item, str) and any(fragment in item for fragment in fatal_warning_fragments)
            for item in warnings
        ):
            raise FlowGraphBuilderError("Flow semantics contains warnings that make graph generation unsafe.")

        for input_item in self._require_mapping_list(flow_semantics, "inputs"):
            input_name = self._require_string(input_item, "name")
            raw_type = input_item.get("type", "paragraph")
            self._input_types[input_name] = str(raw_type) if isinstance(raw_type, str) else "paragraph"

        for raw_step in self._require_mapping_list(flow_semantics, "steps"):
            step = self._coerce_step(raw_step)
            step_id = step["id"]
            if step_id in self._steps:
                raise FlowGraphBuilderError(f"Duplicate step id {step_id!r}.")
            self._steps[step_id] = step

        self._bindings = self._index_objects(
            self._require_mapping_list(flow_semantics, "bindings"), "binding"
        )
        self._terminals = self._index_objects(
            self._require_mapping_list(flow_semantics, "terminals"), "terminal"
        )
        if not self._terminals:
            raise FlowGraphBuilderError("Flow semantics must include at least one terminal.")

        variables = flow_semantics.get("variables", {})
        if not isinstance(variables, Mapping):
            raise FlowGraphBuilderError("Flow semantics field 'variables' must be an object.")
        for name, raw_sources in variables.items():
            if isinstance(name, str) and isinstance(raw_sources, list):
                self._variables[name] = [source for source in raw_sources if isinstance(source, str)]

    def _coerce_step(self, raw_step: Mapping[str, object]) -> _Step:
        step_id = self._require_string(raw_step, "id")
        kind = self._require_string(raw_step, "kind")
        step: _Step = {"id": step_id, "kind": kind}
        if kind == "call":
            function_name = self._require_string(raw_step, "function")
            if not function_name.endswith("Group"):
                raise FlowGraphBuilderError(
                    f"Function {function_name!r} is unsupported: T2 v1 only maps names ending in 'Group' to LLM."
                )
            step["function"] = function_name
            assign_to = raw_step.get("assign_to")
            step["assign_to"] = assign_to if isinstance(assign_to, str) else None
            step["args"] = self._coerce_mapping_list(raw_step.get("args", []), f"{step_id}.args")
            step["kwargs"] = self._coerce_value_mapping(raw_step.get("kwargs", {}), f"{step_id}.kwargs")
        elif kind == "branch":
            step["cases"] = self._coerce_mapping_list(raw_step.get("cases", []), f"{step_id}.cases")
            else_case = raw_step.get("else_case", {"case_id": "else", "body": []})
            if not isinstance(else_case, Mapping):
                raise FlowGraphBuilderError(f"{step_id}.else_case must be an object.")
            step["else_case"] = cast(Mapping[str, object], else_case)
        else:
            raise FlowGraphBuilderError(f"Unsupported step kind {kind!r} for step {step_id!r}.")
        lineno = raw_step.get("lineno")
        if isinstance(lineno, int):
            step["lineno"] = lineno
        return step

    def _infer_structured_outputs(self) -> None:
        for step in self._steps.values():
            if step["kind"] != "branch":
                continue
            for case in step.get("cases", []):
                condition = case.get("condition")
                if not isinstance(condition, Mapping):
                    raise FlowGraphBuilderError(f"Branch {step['id']!r} has an invalid condition object.")
                if condition.get("parsed") is False:
                    raise FlowGraphBuilderError(
                        f"Branch {step['id']!r} contains an unparsed condition: {condition.get('raw')!r}."
                    )
                comparisons = self._coerce_mapping_list(
                    condition.get("comparisons", []), f"{step['id']}.comparisons"
                )
                for comparison in comparisons:
                    key = comparison.get("key")
                    if not isinstance(key, str) or not key:
                        continue
                    variable_name = self._require_string(comparison, "var")
                    source_id = self._single_variable_source(variable_name)
                    source_step = self._steps.get(source_id)
                    if source_step is None or source_step["kind"] != "call":
                        raise FlowGraphBuilderError(
                            f"Structured field {variable_name}.{key} must come from a Group call."
                        )
                    field_type = self._schema_type_for_comparison(comparison)
                    fields = self._structured_fields.setdefault(source_id, {})
                    previous_type = fields.get(key)
                    if previous_type and previous_type != field_type:
                        raise FlowGraphBuilderError(
                            f"Structured field {variable_name}.{key} is compared with incompatible types."
                        )
                    fields[key] = field_type

    def _build_start_node(self, inputs: Sequence[Mapping[str, object]]) -> dict[str, object]:
        variables: list[dict[str, object]] = []
        for input_item in inputs:
            name = self._require_string(input_item, "name")
            raw_type = input_item.get("type", "paragraph")
            input_type = INPUT_TYPE_MAP.get(raw_type, "text-input") if isinstance(raw_type, str) else "text-input"
            variable: dict[str, object] = {
                "variable": name,
                "label": name,
                "type": input_type,
                "required": True,
            }
            if input_type == "text-input":
                variable.update({"max_length": None, "options": []})
            variables.append(variable)
        return self._build_node(
            node_id=START_NODE_ID,
            node_type="start",
            data={"type": "start", "title": "Start", "desc": "", "selected": False, "variables": variables},
        )

    def _build_group_node(self, step: _Step) -> dict[str, object]:
        function_name = step["function"]
        override = self._group_overrides.get(function_name, {})
        default_config = override.get("default_config", self._llm_default_config)
        data = self._normalize_default_config(default_config) if isinstance(default_config, Mapping) else {}
        data["type"] = "llm"
        data["title"] = str(override.get("title") or function_name)
        data.setdefault("desc", "")
        data["selected"] = False

        model_override = override.get("model")
        model = self._validate_model_config(model_override or self._model_config)
        data["model"] = dict(model)
        data["prompt_template"] = [{"role": "user", "text": self._render_call_prompt(step)}]
        data.setdefault("context", {"enabled": False, "variable_selector": []})
        data.setdefault("vision", {"enabled": False, "configs": {"variable_selector": []}})
        data.setdefault("memory", {"enabled": False, "window": {"enabled": False, "size": 50}})
        data.setdefault(
            "retry_config",
            {
                "enabled": False,
                "max_retries": 1,
                "retry_interval": 1000,
                "exponential_backoff": {"enabled": False, "multiplier": 2, "max_interval": 10000},
            },
        )

        structured_fields = self._structured_fields.get(step["id"], {})
        if structured_fields:
            properties = {name: {"type": field_type} for name, field_type in structured_fields.items()}
            data["structured_output_enabled"] = True
            data["structured_output"] = {
                "schema": {
                    "type": "object",
                    "properties": properties,
                    "required": list(properties),
                    "additionalProperties": False,
                }
            }
        else:
            data["structured_output_enabled"] = False
            data.pop("structured_output", None)

        return self._build_node(node_id=step["id"], node_type="llm", data=data)

    def _build_branch_node(self, step: _Step) -> dict[str, object]:
        cases: list[dict[str, object]] = []
        for case in step.get("cases", []):
            case_id = self._require_string(case, "case_id")
            condition = case.get("condition")
            if not isinstance(condition, Mapping):
                raise FlowGraphBuilderError(f"Branch case {case_id!r} condition must be an object.")
            logical_operator = condition.get("logical")
            if logical_operator not in {"and", "or"}:
                raise FlowGraphBuilderError(f"Branch case {case_id!r} has invalid logical operator.")
            comparisons = self._coerce_mapping_list(
                condition.get("comparisons", []), f"{step['id']}.{case_id}.comparisons"
            )
            cases.append(
                {
                    "case_id": case_id,
                    "logical_operator": logical_operator,
                    "conditions": [
                        self._build_condition(step["id"], case_id, index, comparison)
                        for index, comparison in enumerate(comparisons)
                    ],
                }
            )
        return self._build_node(
            node_id=step["id"],
            node_type="if-else",
            data={
                "type": "if-else",
                "title": "IF/ELSE",
                "desc": "",
                "selected": False,
                "cases": cases,
            },
            height=BRANCH_HEIGHT,
        )

    def _build_condition(
        self,
        branch_id: str,
        case_id: str,
        index: int,
        comparison: Mapping[str, object],
    ) -> dict[str, object]:
        variable_name = self._require_string(comparison, "var")
        key = comparison.get("key")
        if isinstance(key, str) and key:
            source_id = self._single_variable_source(variable_name)
            selector = [source_id, "structured_output", key]
            variable_type = self._structured_fields[source_id][key]
        else:
            sources = self._variables.get(variable_name, [])
            if not sources:
                selector = [START_NODE_ID, variable_name]
                variable_type = self._schema_type_for_input(variable_name)
            elif len(sources) == 1:
                selector, variable_type = self._source_output(sources[0])
            else:
                raise FlowGraphBuilderError(
                    f"Condition variable {variable_name!r} must have at most one producer; got {sources}."
                )

        operator = str(comparison.get("op", "=="))
        value = comparison.get("value")
        return {
            "id": f"{branch_id}_{case_id}_{index}",
            "varType": self._dify_var_type(variable_type),
            "variable_selector": selector,
            "comparison_operator": self._comparison_operator(operator, variable_type),
            "value": self._condition_value(operator, value),
        }

    def _walk_sequence(self, sequence: Sequence[str], incoming: list[_Incoming]) -> list[_Incoming]:
        exits = incoming
        for object_id in sequence:
            if object_id in self._bindings:
                continue
            if object_id in self._terminals:
                self._append_terminal_nodes(self._terminals[object_id], exits)
                exits = []
                continue
            step = self._steps.get(object_id)
            if step is None:
                raise FlowGraphBuilderError(f"Body references unknown object id {object_id!r}.")
            self._visited_steps.add(object_id)
            for incoming_edge in exits:
                self._append_edge(
                    incoming_edge["node_id"],
                    object_id,
                    source_handle=incoming_edge["source_handle"],
                )
            if step["kind"] == "call":
                exits = [{"node_id": object_id, "source_handle": SOURCE_HANDLE}]
            else:
                exits = self._walk_branch(step)
        return exits

    def _walk_branch(self, step: _Step) -> list[_Incoming]:
        exits: list[_Incoming] = []
        for case in step.get("cases", []):
            case_id = self._require_string(case, "case_id")
            body = self._object_body(case, f"{step['id']}.{case_id}.body")
            branch_entry = [{"node_id": step["id"], "source_handle": case_id}]
            exits.extend(self._walk_sequence(body, branch_entry) if body else branch_entry)

        else_case = step.get("else_case", {})
        if not isinstance(else_case, Mapping):
            raise FlowGraphBuilderError(f"Branch {step['id']!r} has invalid else_case.")
        else_body = self._object_body(else_case, f"{step['id']}.else.body")
        else_entry = [{"node_id": step["id"], "source_handle": FALSE_HANDLE}]
        exits.extend(self._walk_sequence(else_body, else_entry) if else_body else else_entry)
        return exits

    def _append_terminal_nodes(self, terminal: Mapping[str, object], incoming: Sequence[_Incoming]) -> None:
        terminal_id = self._require_string(terminal, "id")
        if not incoming:
            return
        for incoming_edge in incoming:
            source_id = incoming_edge["node_id"]
            selector, value_type = self._terminal_output(terminal, source_id)
            count = self._terminal_node_count.get(terminal_id, 0) + 1
            self._terminal_node_count[terminal_id] = count
            node_id = terminal_id if len(incoming) == 1 else f"{terminal_id}_{source_id}"
            if count > 1 and node_id == terminal_id:
                node_id = f"{terminal_id}_{count}"
            output_name = terminal.get("assigned_name")
            if not isinstance(output_name, str) or not output_name:
                output_name = "result"
            end_node = self._build_node(
                node_id=node_id,
                node_type="end",
                data={
                    "type": "end",
                    "title": "End",
                    "desc": "",
                    "selected": False,
                    "outputs": [
                        {
                            "variable": output_name,
                            "value_selector": selector,
                            "value_type": self._dify_var_type(value_type),
                        }
                    ],
                },
            )
            self._append_node(end_node)
            self._append_edge(source_id, node_id, source_handle=incoming_edge["source_handle"])

    def _terminal_output(self, terminal: Mapping[str, object], incoming_source: str) -> tuple[list[str], str]:
        output_step = terminal.get("output_step")
        if isinstance(output_step, str):
            if output_step != incoming_source:
                raise FlowGraphBuilderError(
                    f"Terminal {terminal.get('id')!r} output_step does not match its control-flow source."
                )
            return self._source_output(output_step)

        output = terminal.get("output")
        if not isinstance(output, Mapping):
            raise FlowGraphBuilderError(f"Terminal {terminal.get('id')!r} must provide output or output_step.")
        refs = self._string_items(output.get("refs", []))
        if len(refs) != 1:
            raise FlowGraphBuilderError(
                f"Terminal {terminal.get('id')!r} must reference exactly one variable in T2 v1."
            )
        variable_name = refs[0]
        sources = self._variables.get(variable_name, [])
        if not sources:
            return [START_NODE_ID, variable_name], "string"
        if len(sources) == 1:
            return self._source_output(sources[0])
        if incoming_source not in sources:
            raise FlowGraphBuilderError(
                f"Terminal variable {variable_name!r} cannot be matched to source {incoming_source!r}."
            )
        return self._source_output(incoming_source)

    def _render_call_prompt(self, step: _Step) -> str:
        args = [self._render_value(value) for value in step.get("args", [])]
        kwargs = step.get("kwargs", {})
        if not args and set(kwargs) == {"task"}:
            return self._render_value(kwargs["task"])
        parts = [part for part in args if part]
        parts.extend(f"{name}: {self._render_value(value)}" for name, value in kwargs.items())
        return "\n".join(parts)

    def _render_value(self, value: Mapping[str, object]) -> str:
        expr = value.get("expr")
        if expr == "template":
            parts = value.get("parts", [])
            if not isinstance(parts, list):
                return str(value.get("raw", ""))
            rendered: list[str] = []
            for part in parts:
                if not isinstance(part, Mapping):
                    continue
                if isinstance(part.get("text"), str):
                    rendered.append(cast(str, part["text"]))
                elif isinstance(part.get("var"), str):
                    selector, _ = self._variable_output(cast(str, part["var"]))
                    rendered.append(self._selector_template(selector))
                elif isinstance(part.get("raw_expr"), str):
                    raise FlowGraphBuilderError(
                        f"Prompt contains unsupported raw expression {part.get('raw_expr')!r}."
                    )
            return "".join(rendered)
        if expr == "var" and isinstance(value.get("name"), str):
            selector, _ = self._variable_output(cast(str, value["name"]))
            return self._selector_template(selector)
        if expr == "const":
            constant = value.get("value")
            if constant is None:
                return ""
            if isinstance(constant, bool):
                return "true" if constant else "false"
            return str(constant)
        if expr == "raw":
            raise FlowGraphBuilderError(f"Unsupported raw value expression: {value.get('raw')!r}.")
        raise FlowGraphBuilderError(f"Unknown Value expression type {expr!r}.")

    def _variable_output(self, variable_name: str) -> tuple[list[str], str]:
        sources = self._variables.get(variable_name, [])
        if not sources:
            return [START_NODE_ID, variable_name], "string"
        if len(sources) != 1:
            raise FlowGraphBuilderError(
                f"Variable {variable_name!r} has multiple producers {sources}; T2 v1 only joins them at terminals."
            )
        return self._source_output(sources[0])

    def _source_output(self, source_id: str) -> tuple[list[str], str]:
        if source_id == START_NODE_ID:
            raise FlowGraphBuilderError("A start-node output requires an explicit input variable name.")
        if source_id not in self._steps or self._steps[source_id]["kind"] != "call":
            raise FlowGraphBuilderError(f"Source {source_id!r} is not a Group call.")
        if self._structured_fields.get(source_id):
            return [source_id, "structured_output"], "object"
        return [source_id, "text"], "string"

    def _single_variable_source(self, variable_name: str) -> str:
        sources = self._variables.get(variable_name, [])
        if len(sources) != 1:
            raise FlowGraphBuilderError(
                f"Condition variable {variable_name!r} must have exactly one producer; got {sources}."
            )
        return sources[0]

    def _append_node(self, node: dict[str, object]) -> None:
        node_id = cast(str, node["id"])
        if node_id in self._node_type_by_id:
            raise FlowGraphBuilderError(f"Duplicate generated node id {node_id!r}.")
        data = cast(Mapping[str, object], node["data"])
        self._node_type_by_id[node_id] = str(data.get("type", ""))
        self._nodes.append(node)

    def _build_node(
        self,
        *,
        node_id: str,
        node_type: str,
        data: dict[str, object],
        height: int = NODE_HEIGHT,
    ) -> dict[str, object]:
        position = {"x": BASE_X, "y": BASE_Y}
        return {
            "id": node_id,
            "type": NODE_RENDER_TYPE,
            "position": position,
            "data": data,
            "width": NODE_WIDTH,
            "height": height,
            "positionAbsolute": dict(position),
            "sourcePosition": "right",
            "targetPosition": "left",
            "selected": False,
        }

    def _append_edge(
        self,
        source: str,
        target: str,
        *,
        source_handle: str = SOURCE_HANDLE,
        target_handle: str = TARGET_HANDLE,
    ) -> None:
        if source not in self._node_type_by_id or target not in self._node_type_by_id:
            raise FlowGraphBuilderError(f"Edge references unknown node: {source!r} -> {target!r}.")
        edge_key = (source, source_handle, target, target_handle)
        if edge_key in self._seen_edges:
            return
        self._seen_edges.add(edge_key)
        self._edges.append(
            {
                "id": f"{source}-{source_handle}-{target}-{target_handle}",
                "source": source,
                "target": target,
                "type": NODE_RENDER_TYPE,
                "sourceHandle": source_handle,
                "targetHandle": target_handle,
                "data": {
                    "sourceType": "",
                    "targetType": "",
                    "isInIteration": False,
                    "isInLoop": False,
                },
                "zIndex": 0,
            }
        )

    def _fill_edge_types(self) -> None:
        for edge in self._edges:
            data = cast(dict[str, object], edge["data"])
            data["sourceType"] = self._node_type_by_id[cast(str, edge["source"])]
            data["targetType"] = self._node_type_by_id[cast(str, edge["target"])]

    def _apply_topological_layout(self) -> None:
        node_ids = [cast(str, node["id"]) for node in self._nodes]
        successors: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
        indegree = dict.fromkeys(node_ids, 0)
        for edge in self._edges:
            source = cast(str, edge["source"])
            target = cast(str, edge["target"])
            if target not in successors[source]:
                successors[source].append(target)
                indegree[target] += 1

        depths = {START_NODE_ID: 0}
        queue = deque(node_id for node_id in node_ids if indegree[node_id] == 0)
        visited: list[str] = []
        while queue:
            node_id = queue.popleft()
            visited.append(node_id)
            for target in successors[node_id]:
                depths[target] = max(depths.get(target, 0), depths.get(node_id, 0) + 1)
                indegree[target] -= 1
                if indegree[target] == 0:
                    queue.append(target)
        if len(visited) != len(node_ids):
            raise FlowGraphBuilderError("Generated graph contains a directed cycle.")

        nodes_by_depth: dict[int, list[str]] = {}
        for node_id in node_ids:
            nodes_by_depth.setdefault(depths.get(node_id, 0), []).append(node_id)
        node_by_id = {cast(str, node["id"]): node for node in self._nodes}
        for depth, depth_nodes in nodes_by_depth.items():
            center_offset = (len(depth_nodes) - 1) / 2
            for lane, node_id in enumerate(depth_nodes):
                position = {
                    "x": BASE_X + depth * HORIZONTAL_GAP,
                    "y": BASE_Y + (lane - center_offset) * VERTICAL_GAP,
                }
                node_by_id[node_id]["position"] = position
                node_by_id[node_id]["positionAbsolute"] = dict(position)

    def _validate_graph(self) -> None:
        start_count = sum(1 for node_type in self._node_type_by_id.values() if node_type == "start")
        end_count = sum(1 for node_type in self._node_type_by_id.values() if node_type == "end")
        if start_count != 1:
            raise FlowGraphBuilderError(f"Workflow graph must contain exactly one start node; found {start_count}.")
        if end_count < 1:
            raise FlowGraphBuilderError("Workflow graph must contain at least one end node.")
        for edge in self._edges:
            source = cast(str, edge["source"])
            target = cast(str, edge["target"])
            if source not in self._node_type_by_id or target not in self._node_type_by_id:
                raise FlowGraphBuilderError(f"Edge {edge['id']!r} references an unknown node.")

    def _condition_value(self, operator: str, raw_value: object) -> object:
        if operator in {"truthy", "falsy"}:
            return ""
        if not isinstance(raw_value, Mapping) or raw_value.get("expr") != "const":
            raise FlowGraphBuilderError("T2 v1 branch comparisons require constant right-hand values.")
        value = raw_value.get("value")
        if isinstance(value, bool):
            return value
        if value is None:
            return ""
        if isinstance(value, (int, float)):
            return str(value)
        return value

    def _comparison_operator(self, operator: str, variable_type: str) -> str:
        if operator == "truthy":
            return "not empty"
        if operator == "falsy":
            return "empty"
        if variable_type == "number":
            numeric = {"==": "=", "!=": "≠", ">": ">", ">=": "≥", "<": "<", "<=": "≤"}
            if operator in numeric:
                return numeric[operator]
        operators = {
            "==": "is",
            "!=": "is not",
            "in": "in",
            "not in": "not in",
            "is": "is",
            "is not": "is not",
        }
        if operator not in operators:
            raise FlowGraphBuilderError(
                f"Comparison operator {operator!r} is not supported for structured type {variable_type!r}."
            )
        return operators[operator]

    def _schema_type_for_comparison(self, comparison: Mapping[str, object]) -> str:
        value = comparison.get("value")
        if not isinstance(value, Mapping):
            return "string"
        value_type = value.get("value_type")
        if value_type in {"int", "float"}:
            return "number"
        if value_type == "bool":
            return "boolean"
        return "string"

    def _schema_type_for_input(self, variable_name: str) -> str:
        input_type = self._input_types.get(variable_name, "paragraph")
        if input_type == "number":
            return "number"
        if input_type in {"file", "file-list"}:
            return input_type
        return "string"

    def _dify_var_type(self, schema_type: str) -> str:
        return {
            "string": "string",
            "number": "number",
            "boolean": "boolean",
            "object": "object",
            "file": "file",
            "file-list": "array[file]",
        }.get(schema_type, "string")

    def _selector_template(self, selector: Sequence[str]) -> str:
        return "{{#" + ".".join(selector) + "#}}"

    def _validate_model_config(self, model_config: Mapping[str, object]) -> ModelConfig:
        provider = model_config.get("provider")
        name = model_config.get("name")
        mode = model_config.get("mode")
        if not all(isinstance(item, str) and item for item in (provider, name, mode)):
            raise FlowGraphBuilderError("Model config requires non-empty provider, name, and mode strings.")
        completion_params = model_config.get("completion_params", {})
        if not isinstance(completion_params, Mapping):
            raise FlowGraphBuilderError("Model completion_params must be an object.")
        return {
            "provider": cast(str, provider),
            "name": cast(str, name),
            "mode": cast(str, mode),
            "completion_params": dict(completion_params),
        }

    def _normalize_default_config(self, config: Mapping[str, object] | None) -> dict[str, object]:
        if config is None:
            return {}
        inner_config = config.get("config")
        if config.get("type") == "llm" and isinstance(inner_config, Mapping):
            return deepcopy(dict(inner_config))
        return deepcopy(dict(config))

    def _index_objects(
        self, objects: Sequence[Mapping[str, object]], object_name: str
    ) -> dict[str, Mapping[str, object]]:
        indexed: dict[str, Mapping[str, object]] = {}
        for item in objects:
            object_id = self._require_string(item, "id")
            if object_id in indexed:
                raise FlowGraphBuilderError(f"Duplicate {object_name} id {object_id!r}.")
            indexed[object_id] = item
        return indexed

    def _object_body(self, value: Mapping[str, object], field_name: str) -> list[str]:
        body = value.get("body", [])
        if not isinstance(body, list) or not all(isinstance(item, str) for item in body):
            raise FlowGraphBuilderError(f"{field_name} must be a list of object ids.")
        return cast(list[str], body)

    def _require_mapping_list(
        self, flow_semantics: Mapping[str, object], key: str
    ) -> list[Mapping[str, object]]:
        return self._coerce_mapping_list(flow_semantics.get(key), key)

    def _require_string_list(self, flow_semantics: Mapping[str, object], key: str) -> list[str]:
        value = flow_semantics.get(key)
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise FlowGraphBuilderError(f"Flow semantics field {key!r} must be a list of object ids.")
        return cast(list[str], value)

    def _coerce_mapping_list(self, value: object, field_name: str) -> list[Mapping[str, object]]:
        if not isinstance(value, list):
            raise FlowGraphBuilderError(f"{field_name} must be a list.")
        result: list[Mapping[str, object]] = []
        for index, item in enumerate(value):
            if not isinstance(item, Mapping):
                raise FlowGraphBuilderError(f"{field_name}[{index}] must be an object.")
            result.append(cast(Mapping[str, object], item))
        return result

    def _coerce_value_mapping(
        self, value: object, field_name: str
    ) -> Mapping[str, Mapping[str, object]]:
        if not isinstance(value, Mapping):
            raise FlowGraphBuilderError(f"{field_name} must be an object.")
        result: dict[str, Mapping[str, object]] = {}
        for key, item in value.items():
            if not isinstance(key, str) or not isinstance(item, Mapping):
                raise FlowGraphBuilderError(f"{field_name} values must be objects keyed by strings.")
            result[key] = cast(Mapping[str, object], item)
        return result

    def _require_string(self, value: Mapping[str, object], key: str) -> str:
        item = value.get(key)
        if not isinstance(item, str) or not item:
            raise FlowGraphBuilderError(f"Required field {key!r} must be a non-empty string.")
        return item

    def _string_items(self, value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        return [item for item in value if isinstance(item, str)]


def build_workflow_graph(
    flow_semantics: Mapping[str, object],
    model_config: ModelConfig,
    *,
    llm_default_config: Mapping[str, object] | None = None,
    group_overrides: Mapping[str, GroupOverride] | None = None,
) -> dict[str, object]:
    """Convenience wrapper around :class:`FlowGraphBuilder`."""
    return FlowGraphBuilder(
        model_config,
        llm_default_config=llm_default_config,
        group_overrides=group_overrides,
    ).build(flow_semantics)
