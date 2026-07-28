from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from flask import request
from flask_login import current_user
from flask_restx import Resource
from pydantic import BaseModel, Field, model_validator

from controllers.console import console_ns
from controllers.console.app.wraps import get_app_model
from controllers.console.wraps import (
    RBACPermission,
    RBACResourceScope,
    account_initialization_required,
    edit_permission_required,
    rbac_permission_required,
    setup_required,
)
from libs.login import login_required
from models.model import App, AppMode
from services.agent_network_conversation_service import AgentNetworkConversationService


class CreateMessagePayload(BaseModel):
    role: Literal["user", "assistant", "error"]
    content: str = Field(min_length=1, max_length=100_000)
    status: Literal["success", "failed"] = "success"
    apply_status: Literal["not_applied", "apply_failed"] | None = None
    pseudocode: str | None = Field(default=None, max_length=1_000_000)
    parent_message_id: UUID | None = None
    nodes_count: int | None = Field(default=None, ge=0)
    edges_count: int | None = Field(default=None, ge=0)
    draft_hash_before: str | None = Field(default=None, max_length=128)
    draft_hash_after: str | None = Field(default=None, max_length=128)
    error_code: str | None = Field(default=None, max_length=255)
    error_message: str | None = Field(default=None, max_length=10_000)
    meta: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_role_fields(self):
        if self.role == "user":
            if self.pseudocode or self.parent_message_id or self.apply_status:
                raise ValueError("User messages cannot contain plan result fields")
        elif self.role == "assistant":
            if not self.pseudocode or not self.parent_message_id:
                raise ValueError("Assistant messages require pseudocode and parent_message_id")
            if self.apply_status is None:
                self.apply_status = "not_applied"
        elif self.apply_status:
            raise ValueError("Error messages cannot have apply_status")
        return self


class ApplyMessagePayload(BaseModel):
    nodes_count: int = Field(default=0, ge=0)
    edges_count: int = Field(default=0, ge=0)
    draft_hash_before: str | None = Field(default=None, max_length=128)
    draft_hash_after: str | None = Field(default=None, max_length=128)


class ApplyFailedPayload(BaseModel):
    error_code: str = Field(default="APPLY_FAILED", min_length=1, max_length=255)
    error_message: str = Field(min_length=1, max_length=10_000)


class ExecutionResultPayload(BaseModel):
    final_result: Any
    context: dict[str, Any] = Field(default_factory=dict)
    trace: list[dict[str, Any]] = Field(default_factory=list, max_length=10_000)
    calls: int = Field(default=0, ge=0, le=10_000)


def _message_limit() -> int:
    raw_limit = request.args.get("limit", "200")
    try:
        return max(1, min(int(raw_limit), 500))
    except ValueError:
        return 200



@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation")
class AgentNetworkConversationApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_VIEW_LAYOUT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def get(self, app_model: App):
        """
        获取当前 App 的唯一 Agent Network conversation。
        如果不存在，则自动创建。
        """
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, current_user)

        return conversation.to_dict()


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages")
class AgentNetworkMessageListApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_VIEW_LAYOUT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def get(self, app_model: App):
        """
        获取当前 App 的 Agent Network 全部历史消息。
        前端刷新后用这个接口恢复右侧对话面板。
        """
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, current_user)
        messages, has_more = AgentNetworkConversationService.list_messages(app_model, current_user, _message_limit())

        return {
            "conversation": conversation.to_dict(),
            "data": [message.to_dict() for message in messages],
            "has_more": has_more,
        }

    @setup_required
    @login_required
    @account_initialization_required
    @edit_permission_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_EDIT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def post(self, app_model: App):
        """
        保存一条 Agent Network 消息。

        user 消息示例：
        {
          "role": "user",
          "content": "帮我生成一个工作流"
        }

        assistant 消息示例：
        {
          "role": "assistant",
          "content": "Agent Network 已返回规划。",
          "pseudocode": "..."
        }

        error 消息示例：
        {
          "role": "error",
          "content": "工作流生成失败：xxx",
          "error_code": "xxx"
        }
        """
        payload = CreateMessagePayload.model_validate(request.get_json(silent=True) or {})

        try:
            message = AgentNetworkConversationService.create_message(
                app_model=app_model,
                account=current_user,
                role=payload.role,
                content=payload.content,
                status=payload.status,
                parent_message_id=str(payload.parent_message_id) if payload.parent_message_id else None,
                apply_status=payload.apply_status,
                pseudocode=payload.pseudocode,
                nodes_count=payload.nodes_count,
                edges_count=payload.edges_count,
                draft_hash_before=payload.draft_hash_before,
                draft_hash_after=payload.draft_hash_after,
                error_code=payload.error_code,
                error_message=payload.error_message,
                meta=payload.meta,
            )
        except ValueError as error:
            return {
                "code": "INVALID_AGENT_NETWORK_MESSAGE",
                "message": str(error),
            }, 400

        return message.to_dict(), 201


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages/<uuid:message_id>/execution-result")
class AgentNetworkMessageExecutionResultApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @edit_permission_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_EDIT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def post(self, app_model: App, message_id):
        """Persist execute_code output on the assistant plan applied to the current canvas."""
        payload = ExecutionResultPayload.model_validate(request.get_json(silent=True) or {})

        try:
            message = AgentNetworkConversationService.save_execution_result(
                app_model=app_model,
                account=current_user,
                message_id=str(message_id),
                execution_result=payload.model_dump(mode="json"),
            )
            return {"message": message.to_dict()}
        except ValueError as error:
            return {
                "code": "INVALID_AGENT_NETWORK_EXECUTION_RESULT",
                "message": str(error),
            }, 400


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages/clear")
class AgentNetworkMessageClearApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @edit_permission_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_EDIT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def post(self, app_model: App):
        """
        清空当前 App 的 Agent Network 对话消息。
        conversation 本身保留，只删除 messages。
        """
        conversation = AgentNetworkConversationService.clear_messages(app_model, current_user)

        return {
            "result": "success",
            "conversation": conversation.to_dict(),
            "data": [],
        }


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages/<uuid:message_id>/apply")
class AgentNetworkMessageApplyApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @edit_permission_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_EDIT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def post(self, app_model: App, message_id):
        """
        标记某条 assistant pseudocode 已应用到画布。

        注意：
        - 这个接口不负责生成 workflow.graph；
        - 前端先用 message.pseudocode 调用 applyPseudocode；
        - workflow draft 保存成功后，再调用这个接口保存应用状态。
        """
        payload = ApplyMessagePayload.model_validate(request.get_json(silent=True) or {})

        try:
            message = AgentNetworkConversationService.mark_message_applied(
                app_model=app_model,
                account=current_user,
                message_id=str(message_id),
                nodes_count=payload.nodes_count,
                edges_count=payload.edges_count,
                draft_hash_before=payload.draft_hash_before,
                draft_hash_after=payload.draft_hash_after,
            )
            conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, current_user)

            return {
                "conversation": conversation.to_dict(),
                "message": message.to_dict(),
            }
        except ValueError as error:
            return {
                "code": "INVALID_AGENT_NETWORK_MESSAGE",
                "message": str(error),
            }, 400

@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages/<uuid:message_id>/apply-failed")
class AgentNetworkMessageApplyFailedApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    @edit_permission_required
    @rbac_permission_required(RBACResourceScope.APP, RBACPermission.APP_EDIT)
    @get_app_model(mode=[AppMode.ADVANCED_CHAT, AppMode.WORKFLOW])
    def post(self, app_model: App, message_id):
        payload = ApplyFailedPayload.model_validate(request.get_json(silent=True) or {})

        try:
            message = AgentNetworkConversationService.mark_message_apply_failed(
                app_model=app_model,
                account=current_user,
                message_id=str(message_id),
                error_code=payload.error_code,
                error_message=payload.error_message,
            )
            return {"message": message.to_dict()}
        except ValueError as error:
            return {
                "code": "INVALID_AGENT_NETWORK_MESSAGE",
                "message": str(error),
            }, 400
