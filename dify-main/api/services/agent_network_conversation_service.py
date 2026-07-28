from __future__ import annotations

from datetime import datetime
from typing import Any

from extensions.ext_database import db
from models.agent_network_conversation import AgentNetworkConversation, AgentNetworkMessage
from models.model import App


DEFAULT_MESSAGE_LIMIT = 200
MAX_MESSAGE_LIMIT = 500


class AgentNetworkConversationService:
    """
    Agent Network 对话持久化服务。

    这个 service 只负责保存右侧 Agent Network 面板的历史消息和应用状态。
    它不负责：
    - 调用 Agent Network plan 接口；
    - 解析 pseudocode；
    - 生成 workflow.graph；
    - 保存 workflow draft。
    """

    @staticmethod
    def get_or_create_conversation(app_model: App, account) -> AgentNetworkConversation:
        conversation = (
            db.session.query(AgentNetworkConversation)
            .filter(
                AgentNetworkConversation.tenant_id == str(app_model.tenant_id),
                AgentNetworkConversation.app_id == str(app_model.id),
            )
            .first()
        )

        if conversation:
            return conversation

        conversation = AgentNetworkConversation(
            tenant_id=str(app_model.tenant_id),
            app_id=str(app_model.id),
            created_by=str(account.id),
        )
        db.session.add(conversation)
        db.session.commit()
        return conversation

    @staticmethod
    def list_messages(
        app_model: App, account, limit: int = DEFAULT_MESSAGE_LIMIT
    ) -> tuple[list[AgentNetworkMessage], bool]:
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, account)
        bounded_limit = max(1, min(limit, MAX_MESSAGE_LIMIT))

        newest_first = (
            db.session.query(AgentNetworkMessage)
            .filter(AgentNetworkMessage.conversation_id == conversation.id)
            .order_by(AgentNetworkMessage.created_at.desc(), AgentNetworkMessage.id.desc())
            .limit(bounded_limit + 1)
            .all()
        )
        has_more = len(newest_first) > bounded_limit
        return list(reversed(newest_first[:bounded_limit])), has_more

    @staticmethod
    def create_message(
        app_model: App,
        account,
        role: str,
        content: str,
        status: str = "success",
        parent_message_id: str | None = None,
        apply_status: str | None = None,
        pseudocode: str | None = None,
        nodes_count: int | None = None,
        edges_count: int | None = None,
        draft_hash_before: str | None = None,
        draft_hash_after: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> AgentNetworkMessage:
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, account)

        if parent_message_id:
            parent_message = (
                db.session.query(AgentNetworkMessage)
                .filter(
                    AgentNetworkMessage.id == parent_message_id,
                    AgentNetworkMessage.conversation_id == conversation.id,
                    AgentNetworkMessage.role == "user",
                )
                .first()
            )
            if not parent_message:
                raise ValueError("Parent user message not found")

        message = AgentNetworkMessage(
            conversation_id=conversation.id,
            parent_message_id=parent_message_id,
            role=role,
            status=status,
            apply_status=apply_status,
            content=content,
            pseudocode=pseudocode,
            nodes_count=nodes_count,
            edges_count=edges_count,
            draft_hash_before=draft_hash_before,
            draft_hash_after=draft_hash_after,
            error_code=error_code,
            error_message=error_message,
            meta=meta or {},
        )

        conversation.updated_at = datetime.utcnow()

        db.session.add(message)
        db.session.commit()
        return message

    @staticmethod
    def mark_message_applied(
        app_model: App,
        account,
        message_id: str,
        nodes_count: int,
        edges_count: int,
        draft_hash_before: str | None = None,
        draft_hash_after: str | None = None,
    ) -> AgentNetworkMessage:
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, account)

        message = (
            db.session.query(AgentNetworkMessage)
            .filter(
                AgentNetworkMessage.id == message_id,
                AgentNetworkMessage.conversation_id == conversation.id,
                AgentNetworkMessage.role == "assistant",
            )
            .first()
        )

        if not message:
            raise ValueError("Agent Network assistant message not found")

        if not message.pseudocode:
            raise ValueError("Agent Network message has no pseudocode to apply")

        if not message.parent_message_id:
            raise ValueError("Agent Network message is not linked to its user task")

        task_message = (
            db.session.query(AgentNetworkMessage)
            .filter(
                AgentNetworkMessage.id == message.parent_message_id,
                AgentNetworkMessage.conversation_id == conversation.id,
                AgentNetworkMessage.role == "user",
            )
            .first()
        )
        if not task_message or not task_message.content.strip():
            raise ValueError("Original plan task not found")

        # 当前 App 只允许一条 pseudocode 标记为 applied。
        db.session.query(AgentNetworkMessage).filter(
            AgentNetworkMessage.conversation_id == conversation.id,
            AgentNetworkMessage.apply_status == "applied",
        ).update({"apply_status": "not_applied"})

        message.apply_status = "applied"
        message.status = "success"
        message.nodes_count = nodes_count
        message.edges_count = edges_count
        message.draft_hash_before = draft_hash_before
        message.draft_hash_after = draft_hash_after
        message.error_code = None
        message.error_message = None
        message.updated_at = datetime.utcnow()

        conversation.applied_message_id = message.id
        conversation.applied_task = task_message.content.strip()
        conversation.updated_at = datetime.utcnow()

        db.session.commit()
        return message

    @staticmethod
    def mark_message_apply_failed(
        app_model: App,
        account,
        message_id: str,
        error_code: str,
        error_message: str,
    ) -> AgentNetworkMessage:
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, account)

        message = (
            db.session.query(AgentNetworkMessage)
            .filter(
                AgentNetworkMessage.id == message_id,
                AgentNetworkMessage.conversation_id == conversation.id,
                AgentNetworkMessage.role == "assistant",
            )
            .first()
        )

        if not message:
            raise ValueError("Agent Network assistant message not found")

        message.apply_status = "apply_failed"
        message.error_code = error_code
        message.error_message = error_message
        message.updated_at = datetime.utcnow()

        conversation.updated_at = datetime.utcnow()

        db.session.commit()
        return message

    @staticmethod
    def save_execution_result(
        app_model: App,
        account,
        message_id: str,
        execution_result: dict[str, Any],
    ) -> AgentNetworkMessage:
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, account)

        message = (
            db.session.query(AgentNetworkMessage)
            .filter(
                AgentNetworkMessage.id == message_id,
                AgentNetworkMessage.conversation_id == conversation.id,
                AgentNetworkMessage.role == "assistant",
            )
            .first()
        )
        if not message:
            raise ValueError("Agent Network assistant message not found")
        if conversation.applied_message_id != message.id:
            raise ValueError("Execution result must belong to the applied Agent Network message")

        meta = dict(message.meta or {})
        meta["agent_network_execution"] = execution_result
        message.meta = meta
        message.updated_at = datetime.utcnow()
        conversation.updated_at = datetime.utcnow()

        db.session.commit()
        return message

    @staticmethod
    def clear_messages(app_model: App, account) -> AgentNetworkConversation:
        conversation = AgentNetworkConversationService.get_or_create_conversation(app_model, account)

        db.session.query(AgentNetworkMessage).filter(
            AgentNetworkMessage.conversation_id == conversation.id,
        ).delete()

        conversation.applied_message_id = None
        # Clearing chat history does not clear the current canvas.
        # Keep applied_task until another pseudocode is successfully applied.
        conversation.updated_at = datetime.utcnow()

        db.session.commit()
        return conversation