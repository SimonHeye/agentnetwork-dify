"""End-to-end orchestration for Python pseudocode -> Dify workflow.graph.

T1 flow semantics remain an in-memory intermediate representation. Callers
provide pseudocode and receive only the final Dify graph unless they invoke T1
directly for debugging.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from T1_parser.pseudocode_parser import compile_to_semantics
from T2_workflowgraph import GroupOverride, ModelConfig, build_workflow_graph


def pseudocode_to_workflow_graph(
    source: str,
    model_config: ModelConfig,
    *,
    llm_default_config: Mapping[str, object] | None = None,
    group_overrides: Mapping[str, GroupOverride] | None = None,
    input_types: dict[str, str] | None = None,
) -> dict[str, object]:
    """Compile pseudocode into a Dify 1.15 workflow graph."""
    flow_semantics = compile_to_semantics(source, input_types=input_types)
    return build_workflow_graph(
        flow_semantics,
        model_config,
        llm_default_config=llm_default_config,
        group_overrides=group_overrides,
    )


def pseudocode_file_to_workflow_graph(
    source_path: str | Path,
    model_config: ModelConfig,
    *,
    llm_default_config: Mapping[str, object] | None = None,
    group_overrides: Mapping[str, GroupOverride] | None = None,
    input_types: dict[str, str] | None = None,
) -> dict[str, object]:
    """Read a UTF-8 pseudocode file and return its Dify workflow graph."""
    source = Path(source_path).read_text(encoding="utf-8")
    return pseudocode_to_workflow_graph(
        source,
        model_config,
        llm_default_config=llm_default_config,
        group_overrides=group_overrides,
        input_types=input_types,
    )


def write_workflow_graph(graph: Mapping[str, object], output_path: str | Path) -> Path:
    """Write, read back, and validate formatted workflow graph JSON."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    written_graph = json.loads(path.read_text(encoding="utf-8"))
    if written_graph != graph:
        raise RuntimeError(f"Workflow graph JSON read-back differs from generated graph: {path}")
    if not isinstance(written_graph, dict):
        raise RuntimeError("Generated workflow graph JSON must be an object.")
    for key in ("nodes", "edges"):
        if not isinstance(written_graph.get(key), list):
            raise RuntimeError(f"Generated workflow graph field {key!r} must be a list.")
    viewport = written_graph.get("viewport")
    if not isinstance(viewport, dict) or not all(key in viewport for key in ("x", "y", "zoom")):
        raise RuntimeError("Generated workflow graph viewport must contain x, y, and zoom.")
    return path.resolve()


def _load_json_object(path: Path | None, option_name: str) -> Mapping[str, object] | None:
    if path is None:
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{option_name} must contain a JSON object.")
    return value


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert Python pseudocode to Dify workflow.graph JSON.")
    parser.add_argument("source", type=Path, help="UTF-8 Python pseudocode file")
    parser.add_argument("--provider", required=True, help="Dify model provider identifier")
    parser.add_argument("--model", required=True, help="Dify model name")
    parser.add_argument("--model-mode", default="chat", help="Dify model mode; normally chat")
    parser.add_argument("--output", type=Path, required=True, help="Output workflow.graph JSON path")
    parser.add_argument("--llm-default-config", type=Path, help="Optional Dify default LLM config JSON")
    parser.add_argument("--group-overrides", type=Path, help="Optional JSON object keyed by Group name")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    llm_default_config = _load_json_object(args.llm_default_config, "--llm-default-config")
    raw_overrides = _load_json_object(args.group_overrides, "--group-overrides")
    graph = pseudocode_file_to_workflow_graph(
        args.source,
        model_config={
            "provider": args.provider,
            "name": args.model,
            "mode": args.model_mode,
            "completion_params": {},
        },
        llm_default_config=llm_default_config,
        group_overrides=raw_overrides,
    )
    print(write_workflow_graph(graph, args.output))


if __name__ == "__main__":
    main()
