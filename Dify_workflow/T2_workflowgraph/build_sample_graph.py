from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from T1_parser.pseudocode_parser import compile_to_semantics
from T2_workflowgraph.workflow_graph_builder import build_workflow_graph


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Dify workflow.graph JSON from Python pseudocode.")
    parser.add_argument("source", type=Path, help="UTF-8 Python pseudocode file")
    parser.add_argument("--provider", required=True, help="Dify model provider identifier")
    parser.add_argument("--model", required=True, help="Dify model name")
    parser.add_argument("--mode", default="chat", help="Dify model mode, normally chat")
    parser.add_argument("--output", type=Path, help="Output JSON path; stdout when omitted")
    args = parser.parse_args()

    source = args.source.read_text(encoding="utf-8")
    semantics = compile_to_semantics(source)
    graph = build_workflow_graph(
        semantics,
        model_config={
            "provider": args.provider,
            "name": args.model,
            "mode": args.mode,
            "completion_params": {},
        },
    )
    rendered = json.dumps(graph, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)


if __name__ == "__main__":
    main()
