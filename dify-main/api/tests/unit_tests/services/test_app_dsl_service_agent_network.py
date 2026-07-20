from types import SimpleNamespace

import yaml

from services.app_dsl_service import AppDslService, ImportMode, ImportStatus


def test_import_app_compiles_agent_network_before_native_import(monkeypatch) -> None:
    captured: dict = {}

    def fake_create_or_update_app(self, **kwargs):
        captured["data"] = kwargs["data"]
        return SimpleNamespace(id="app-1", mode="advanced-chat")

    monkeypatch.setattr(AppDslService, "_create_or_update_app", fake_create_or_update_app)
    monkeypatch.setattr(
        "services.app_dsl_service.WorkflowDraftVariableService",
        lambda session: SimpleNamespace(delete_app_workflow_variables=lambda app_id: None),
    )

    service = AppDslService(session=SimpleNamespace())
    result = service.import_app(
        account=SimpleNamespace(id="account-1", current_tenant_id="tenant-1"),
        import_mode=ImportMode.YAML_CONTENT.value,
        yaml_content=yaml.safe_dump(
            {
                "kind": "agent-network",
                "app": {"name": "Network View"},
                "nodes": [{"id": "agent-1", "type": "agent", "title": "Planner Agent"}],
            },
            sort_keys=False,
        ),
    )

    assert result.status == ImportStatus.COMPLETED
    assert result.app_id == "app-1"
    assert captured["data"]["kind"] == "app"
    assert captured["data"]["app"]["name"] == "Network View"
    assert captured["data"]["workflow"]["graph"]["nodes"][0]["data"]["type"] == "start"
    assert captured["data"]["workflow"]["graph"]["nodes"][1]["id"] == "agent_1"


def test_import_app_returns_failed_for_invalid_agent_network(monkeypatch) -> None:
    monkeypatch.setattr(
        "services.app_dsl_service.WorkflowDraftVariableService",
        lambda session: SimpleNamespace(delete_app_workflow_variables=lambda app_id: None),
    )

    service = AppDslService(session=SimpleNamespace())
    result = service.import_app(
        account=SimpleNamespace(id="account-1", current_tenant_id="tenant-1"),
        import_mode=ImportMode.YAML_CONTENT.value,
        yaml_content=yaml.safe_dump(
            {
                "kind": "agent-network",
                "nodes": [{"id": "agent-1", "type": "agent"}],
                "edges": [{"source": "start", "target": "missing"}],
            },
            sort_keys=False,
        ),
    )

    assert result.status == ImportStatus.FAILED
    assert "Unknown edge target" in result.error