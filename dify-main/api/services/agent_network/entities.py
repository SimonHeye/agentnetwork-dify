"""Typed IR for importing external agent-network plans into Dify.

The IR is intentionally narrower than Dify's native workflow DSL. It gives an
external planner a stable shape to describe nodes and edges, while the compiler
owns Dify-specific defaults, canvas layout, safe identifiers, and terminal nodes.
"""

from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

AGENT_NETWORK_DSL_KIND = "agent-network"
AgentNetworkMode = Literal["advanced-chat", "workflow"]


class AgentNetworkCompilerError(ValueError):
    """Raised when an agent-network IR cannot be compiled into native Dify DSL."""


class AgentNetworkPosition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float


class AgentNetworkApp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = "Agent Network"
    description: str = ""
    icon: str = ""
    icon_type: str = "emoji"
    icon_background: str = "#FFEAD5"
    use_icon_as_answer_icon: bool = False


class AgentNetworkInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    variable: str
    label: str | None = None
    input_type: str = Field(default="text-input", validation_alias=AliasChoices("type", "input_type"))
    required: bool = False
    max_length: int | None = None
    options: list[str] = Field(default_factory=list)
    allowed_file_types: list[str] = Field(default_factory=list)
    allowed_file_extensions: list[str] = Field(default_factory=list)
    allowed_file_upload_methods: list[str] = Field(default_factory=lambda: ["local_file", "remote_url"])


class AgentNetworkNode(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    node_type: str = Field(validation_alias=AliasChoices("type", "kind", "node_type"))
    title: str | None = None
    description: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    position: AgentNetworkPosition | None = None


class AgentNetworkEdge(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    source: str
    target: str
    source_handle: str | None = Field(
        default=None,
        validation_alias=AliasChoices("source_handle", "sourceHandle"),
    )
    target_handle: str | None = Field(
        default=None,
        validation_alias=AliasChoices("target_handle", "targetHandle"),
    )
    id: str | None = None


class AgentNetworkCanvasIR(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["agent-network"] = AGENT_NETWORK_DSL_KIND
    version: str | None = None
    app: AgentNetworkApp = Field(default_factory=AgentNetworkApp)
    mode: AgentNetworkMode = "advanced-chat"
    inputs: list[AgentNetworkInput] = Field(default_factory=list)
    nodes: list[AgentNetworkNode] = Field(default_factory=list)
    edges: list[AgentNetworkEdge] = Field(default_factory=list)
    groups: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
