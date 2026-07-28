from __future__ import annotations

from flask import request
from flask_login import current_user, login_required
from flask_restx import Resource

from controllers.console import console_ns
from controllers.console.app.error import AppNotFoundError
from controllers.console.wraps import account_initialization_required, setup_required
from extensions.ext_database import db
from models.model import App
from services.agent_network_conversation_service import AgentNetworkConversationService


def _get_app(app_id):
    app_model = (
        db.session.query(App)
        .filter(
            App.id == str(app_id),
            App.tenant_id == current_user.current_tenant_id,
        )
        .first()
    )

    if not app_model:
        raise AppNotFoundError()

    return app_model


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation")
class AgentNetworkConversationApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    def get(self, app_id):
        """
        获取当前 App 的唯一 Agent Network conversation。
        如果不存在，则自动创建。
        """
        app_model = _get_app(app_id)
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, current_user)

        return conversation.to_dict()


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages")
class AgentNetworkMessageListApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    def get(self, app_id):
        """
        获取当前 App 的 Agent Network 全部历史消息。
        前端刷新后用这个接口恢复右侧对话面板。
        """
        app_model = _get_app(app_id)
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, current_user)
        messages = AgentNetworkConversationService.list_messages(app_model, current_user)

        return {
            "conversation": conversation.to_dict(),
            "data": [message.to_dict() for message in messages],
        }

    @setup_required
    @login_required
    @account_initialization_required
    def post(self, app_id):
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
        app_model = _get_app(app_id)
        body = request.get_json(silent=True) or {}

        message = AgentNetworkConversationService.create_message(
            app_model=app_model,
            account=current_user,
            role=body.get("role") or "assistant",
            status=body.get("status") or "success",
            apply_status=body.get("apply_status"),
            content=body.get("content") or "",
            pseudocode=body.get("pseudocode"),
            nodes_count=body.get("nodes_count"),
            edges_count=body.get("edges_count"),
            draft_hash_before=body.get("draft_hash_before"),
            draft_hash_after=body.get("draft_hash_after"),
            error_code=body.get("error_code"),
            error_message=body.get("error_message"),
            meta=body.get("meta") or {},
        )

        return message.to_dict(), 201


@console_ns.route("/apps/<uuid:app_id>/agent-network/conversation/messages/clear")
class AgentNetworkMessageClearApi(Resource):
    @setup_required
    @login_required
    @account_initialization_required
    def post(self, app_id):
        """
        清空当前 App 的 Agent Network 对话消息。
        conversation 本身保留，只删除 messages。
        """
        app_model = _get_app(app_id)
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
    def post(self, app_id, message_id):
        """
        标记某条 assistant pseudocode 已应用到画布。

        注意：
        - 这个接口不负责生成 workflow.graph；
        - 前端先用 message.pseudocode 调用 applyPseudocode；
        - workflow draft 保存成功后，再调用这个接口保存应用状态。
        """
        app_model = _get_app(app_id)
        body = request.get_json(silent=True) or {}

        try:
            message = AgentNetworkConversationService.mark_message_applied(
                app_model=app_model,
                account=current_user,
                message_id=str(message_id),
                nodes_count=int(body.get("nodes_count") or 0),
                edges_count=int(body.get("edges_count") or 0),
                draft_hash_before=body.get("draft_hash_before"),
                draft_hash_after=body.get("draft_hash_after"),
            )
            conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, current_user)

            return {
                "conversation": conversation.to_dict(),
                "message": message.to_dict(),
            }
        except ValueError as error:
            message = AgentNetworkConversationService.mark_message_apply_failed(
                app_model=app_model,
                account=current_user,
                message_id=str(message_id),
                error_code="APPLY_FAILED",
                error_message=str(error),
            )

            return {
                "message": message.to_dict(),
            }, 400