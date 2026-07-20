"""Safely replace a local Dify application's draft workflow graph.

Authentication and target defaults can be supplied by a local JSON config,
the ``DIFY_ACCESS_TOKEN`` environment variable, or a hidden prompt. The
importer always reads the current draft, writes a local backup, preserves
non-graph settings, sends the current hash, and verifies the saved graph after
POST.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

DEFAULT_BASE_URL = "http://localhost"
DEFAULT_GRAPH_PATH = Path("workflow_graphs/sample_graph.json")
DEFAULT_BACKUP_DIR = Path("workflow_graphs/backups")
DEFAULT_CONFIG_PATH = Path("Pipeline/dify_import_config.json")


class DifyImportError(RuntimeError):
    """Raised when draft backup, sync, or verification fails."""


class DraftClient(Protocol):
    def get_draft(self, app_id: str) -> dict[str, object]: ...

    def sync_draft(self, app_id: str, payload: Mapping[str, object]) -> dict[str, object]: ...


class DifyConsoleClient:
    """Minimal authenticated client for Dify console draft endpoints."""

    def __init__(self, base_url: str, access_token: str, timeout: float = 30.0) -> None:
        if not access_token.strip():
            raise DifyImportError("Dify access token is empty.")
        self._base_url = base_url.rstrip("/")
        self._access_token = access_token.strip()
        self._timeout = timeout

    def get_draft(self, app_id: str) -> dict[str, object]:
        return self._request_json("GET", self._draft_url(app_id))

    def sync_draft(self, app_id: str, payload: Mapping[str, object]) -> dict[str, object]:
        return self._request_json("POST", self._draft_url(app_id), payload)

    def _draft_url(self, app_id: str) -> str:
        return f"{self._base_url}/console/api/apps/{app_id}/workflows/draft"

    def _request_json(
        self,
        method: str,
        url: str,
        payload: Mapping[str, object] | None = None,
    ) -> dict[str, object]:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(
            url,
            data=body,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self._access_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            if error.code == 401:
                raise DifyImportError("Dify authentication failed; refresh the console access_token.") from error
            if error.code == 409:
                raise DifyImportError("Draft hash changed; reload and retry instead of overwriting newer edits.") from error
            raise DifyImportError(f"Dify returned HTTP {error.code}: {detail}") from error
        except URLError as error:
            raise DifyImportError(f"Cannot connect to Dify at {self._base_url}: {error.reason}") from error
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise DifyImportError("Dify returned a non-JSON response.") from error
        if not isinstance(value, dict):
            raise DifyImportError("Dify returned an unexpected response shape.")
        return cast(dict[str, object], value)


def load_graph(path: str | Path) -> dict[str, object]:
    """Load and minimally validate a generated workflow graph."""
    graph_path = Path(path)
    try:
        value = json.loads(graph_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise DifyImportError(f"Graph file does not exist: {graph_path}") from error
    except json.JSONDecodeError as error:
        raise DifyImportError(f"Graph file is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise DifyImportError("Graph JSON must be an object.")
    for key in ("nodes", "edges"):
        if not isinstance(value.get(key), list):
            raise DifyImportError(f"Graph field {key!r} must be a list.")
    viewport = value.get("viewport")
    if not isinstance(viewport, dict) or not all(key in viewport for key in ("x", "y", "zoom")):
        raise DifyImportError("Graph viewport must contain x, y, and zoom.")
    if not value["nodes"]:
        raise DifyImportError("Graph must contain at least one node.")
    return cast(dict[str, object], value)


def load_import_config(path: str | Path) -> dict[str, object]:
    """Load and validate local importer defaults from a JSON object."""
    config_path = Path(path)
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise DifyImportError(f"Import config does not exist: {config_path}") from error
    except json.JSONDecodeError as error:
        raise DifyImportError(f"Import config is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise DifyImportError("Import config JSON must be an object.")

    for key in ("base_url", "app_id", "graph", "backup_dir", "access_token"):
        item = value.get(key)
        if item is not None and not isinstance(item, str):
            raise DifyImportError(f"Import config field {key!r} must be a string.")
    auto_confirm = value.get("auto_confirm")
    if auto_confirm is not None and not isinstance(auto_confirm, bool):
        raise DifyImportError("Import config field 'auto_confirm' must be a boolean.")
    return cast(dict[str, object], value)


def build_sync_payload(draft: Mapping[str, object], graph: Mapping[str, object]) -> dict[str, object]:
    """Preserve current draft metadata while replacing only its graph."""
    return {
        "graph": dict(graph),
        "features": draft.get("features") if isinstance(draft.get("features"), dict) else {},
        "environment_variables": (
            draft.get("environment_variables") if isinstance(draft.get("environment_variables"), list) else []
        ),
        "conversation_variables": (
            draft.get("conversation_variables") if isinstance(draft.get("conversation_variables"), list) else []
        ),
        "hash": draft.get("hash") if isinstance(draft.get("hash"), str) else None,
    }


def write_draft_backup(
    draft: Mapping[str, object],
    app_id: str,
    backup_dir: str | Path = DEFAULT_BACKUP_DIR,
) -> Path:
    """Write the complete current draft before any remote mutation."""
    directory = Path(backup_dir)
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = directory / f"{app_id}_{timestamp}.draft.json"
    path.write_text(json.dumps(draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path.resolve()


def import_graph(
    client: DraftClient,
    app_id: str,
    graph: Mapping[str, object],
    *,
    backup_dir: str | Path = DEFAULT_BACKUP_DIR,
    confirmed: bool = False,
    dry_run: bool = False,
) -> tuple[Path, dict[str, object] | None]:
    """Back up, optionally sync, and verify a graph against the Dify draft."""
    _validate_app_id(app_id)
    draft = client.get_draft(app_id)
    backup_path = write_draft_backup(draft, app_id, backup_dir)
    if dry_run:
        return backup_path, None
    if not confirmed:
        raise DifyImportError("Import was not confirmed; no remote changes were made.")

    payload = build_sync_payload(draft, graph)
    result = client.sync_draft(app_id, payload)
    saved_draft = client.get_draft(app_id)
    if saved_draft.get("graph") != graph:
        raise DifyImportError("Dify accepted the request but the read-back graph differs from the local graph.")
    return backup_path, result


def _validate_app_id(app_id: str) -> None:
    try:
        UUID(app_id)
    except ValueError as error:
        raise DifyImportError(f"Invalid Dify app id: {app_id!r}") from error


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Back up and import workflow.graph into a Dify draft.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH, help="Local importer config JSON")
    parser.add_argument("--app-id", help="UUID from /app/<app-id>/workflow; overrides config")
    parser.add_argument("--graph", type=Path, help="Generated graph JSON; overrides config")
    parser.add_argument("--base-url", help="Dify console base URL; overrides config")
    parser.add_argument("--backup-dir", type=Path, help="Backup directory; overrides config")
    parser.add_argument("--dry-run", action="store_true", help="Read and back up the draft without POST")
    parser.add_argument("--yes", action="store_true", help="Skip typing IMPORT; overrides config")
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    config = load_import_config(args.config)
    app_id = args.app_id or config.get("app_id")
    if not isinstance(app_id, str) or not app_id:
        raise DifyImportError("Dify app id is required in config or --app-id.")
    graph_path = args.graph or Path(str(config.get("graph") or DEFAULT_GRAPH_PATH))
    base_url = args.base_url or str(config.get("base_url") or DEFAULT_BASE_URL)
    backup_dir = args.backup_dir or Path(str(config.get("backup_dir") or DEFAULT_BACKUP_DIR))
    graph = load_graph(graph_path)
    config_token = config.get("access_token")
    access_token = (
        os.environ.get("DIFY_ACCESS_TOKEN")
        or (config_token if isinstance(config_token, str) else "")
        or getpass.getpass("Dify access_token: ")
    )
    client = DifyConsoleClient(base_url, access_token)

    if args.dry_run:
        confirmed = False
    elif args.yes or config.get("auto_confirm") is True:
        confirmed = True
    else:
        node_count = len(cast(list[object], graph["nodes"]))
        print(f"Target app: {app_id}")
        print(f"Graph: {graph_path} ({node_count} nodes)")
        confirmed = input("Type IMPORT to replace the current draft: ").strip() == "IMPORT"

    backup_path, result = import_graph(
        client,
        app_id,
        graph,
        backup_dir=backup_dir,
        confirmed=confirmed,
        dry_run=args.dry_run,
    )
    print(f"Backup: {backup_path}")
    if args.dry_run:
        print("Dry run completed; the Dify draft was not changed.")
    else:
        print(f"Import succeeded: {result}")
        print(f"Refresh: {base_url.rstrip('/')}/app/{app_id}/workflow")


if __name__ == "__main__":
    main()
