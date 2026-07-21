"""Load and resolve Group identities used by reverse workflow conversion."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import TypedDict, cast

GROUP_REGISTRY_VERSION = 1
DEFAULT_GROUP_REGISTRY_PATH = Path(__file__).with_name("group_registry.json")


class GroupRegistryError(ValueError):
    """Raised when a Group registry is missing or internally inconsistent."""


class GroupDefinition(TypedDict):
    dify_type: str
    aliases: list[str]
    input_params: list[str]
    default_assignment: str


class GroupRegistry(TypedDict):
    version: int
    groups: dict[str, GroupDefinition]


def load_group_registry(path: str | Path = DEFAULT_GROUP_REGISTRY_PATH) -> GroupRegistry:
    """Read and validate a Group registry JSON file."""
    registry_path = Path(path)
    try:
        value = json.loads(registry_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise GroupRegistryError(f"Group registry does not exist: {registry_path}") from error
    except json.JSONDecodeError as error:
        raise GroupRegistryError(f"Group registry is not valid JSON: {error}") from error
    return validate_group_registry(value)


def validate_group_registry(value: object) -> GroupRegistry:
    """Return a normalized registry or raise a precise validation error."""
    if not isinstance(value, Mapping):
        raise GroupRegistryError("Group registry must be a JSON object.")
    if value.get("version") != GROUP_REGISTRY_VERSION:
        raise GroupRegistryError(
            f"Unsupported Group registry version {value.get('version')!r}; expected {GROUP_REGISTRY_VERSION}."
        )
    raw_groups = value.get("groups")
    if not isinstance(raw_groups, Mapping):
        raise GroupRegistryError("Group registry field 'groups' must be an object.")

    groups: dict[str, GroupDefinition] = {}
    claimed_titles: dict[str, str] = {}
    for raw_name, raw_definition in raw_groups.items():
        if not isinstance(raw_name, str) or not raw_name.endswith("Group") or not raw_name.isidentifier():
            raise GroupRegistryError(f"Invalid Group function name: {raw_name!r}.")
        if not isinstance(raw_definition, Mapping):
            raise GroupRegistryError(f"Definition for {raw_name!r} must be an object.")
        dify_type = raw_definition.get("dify_type")
        if dify_type != "llm":
            raise GroupRegistryError(f"{raw_name}.dify_type must be 'llm'.")
        aliases = _string_list(raw_definition.get("aliases"), f"{raw_name}.aliases")
        input_params = _string_list(raw_definition.get("input_params"), f"{raw_name}.input_params")
        if not all(item.isidentifier() for item in input_params):
            raise GroupRegistryError(f"{raw_name}.input_params must contain Python identifiers.")
        default_assignment = raw_definition.get("default_assignment")
        if not isinstance(default_assignment, str) or not default_assignment.isidentifier():
            raise GroupRegistryError(f"{raw_name}.default_assignment must be a Python identifier.")

        for title in [raw_name, *aliases]:
            owner = claimed_titles.get(title)
            if owner is not None:
                raise GroupRegistryError(f"Group title or alias {title!r} is shared by {owner!r} and {raw_name!r}.")
            claimed_titles[title] = raw_name

        groups[raw_name] = {
            "dify_type": "llm",
            "aliases": aliases,
            "input_params": input_params,
            "default_assignment": default_assignment,
        }
    return {"version": GROUP_REGISTRY_VERSION, "groups": groups}


def resolve_group_name(title: str, registry: Mapping[str, object]) -> str | None:
    """Resolve an exact function name or configured display alias."""
    normalized = title.strip()
    validated = validate_group_registry(registry)
    for function_name, definition in validated["groups"].items():
        if normalized == function_name or normalized in definition["aliases"]:
            return function_name
    return None


def _string_list(value: object, field_name: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise GroupRegistryError(f"{field_name} must be a list of non-empty strings.")
    normalized = [cast(str, item).strip() for item in value]
    if len(normalized) != len(set(normalized)):
        raise GroupRegistryError(f"{field_name} contains duplicate values.")
    return normalized
