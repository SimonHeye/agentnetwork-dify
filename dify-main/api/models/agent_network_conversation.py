from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from extensions.ext_database import db


def new_uuid() -> str:
    return str(uuid.uuid4())


class AgentNetworkConversation(db.Model):
    """
    Agent Network 右侧对话面板的持久化对话容器。

    当前产品逻辑：
    - 一个 Dify App 只有一个 Agent Network 对话；
    - 这个对话里面可以有很多轮 user / assistant / error 消息；
    - applied_message_id 用来记录“当前画布是由哪一轮 assistant pseudocode 应用得到的”。
    """

    __tablename__ = "agent_network_conversations"
    __table_args__ = (
        db.PrimaryKeyConstraint("id", name="agent_network_conversation_pkey"),
        db.UniqueConstraint("tenant_id", "app_id", name="agent_network_conversation_tenant_app_unique"),
        db.Index("agent_network_conversation_app_idx", "tenant_id", "app_id"),
    )

    id = db.Column(db.String(36), primary_key=True, default=new_uuid)
    tenant_id = db.Column(db.String(36), nullable=False)
    app_id = db.Column(db.String(36), nullable=False)
    created_by = db.Column(db.String(36), nullable=False)

    # 当前已经应用到画布的 assistant message id
    applied_message_id = db.Column(db.String(36), nullable=True)

    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tenant_id": self.tenant_id,
            "app_id": self.app_id,
            "created_by": self.created_by,
            "applied_message_id": self.applied_message_id,
            "created_at": int(self.created_at.timestamp()) if self.created_at else None,
            "updated_at": int(self.updated_at.timestamp()) if self.updated_at else None,
        }


class AgentNetworkMessage(db.Model):
    """
    Agent Network 对话中的单条消息。

    role:
    - user：用户输入的任务
    - assistant：Agent Network 返回的规划结果，通常带 pseudocode
    - error：生成失败、接口失败、应用失败等错误消息

    apply_status:
    - not_applied：这条 assistant pseudocode 还没有应用到画布
    - applied：这条 assistant pseudocode 已应用到当前画布
    - apply_failed：这条 assistant pseudocode 应用失败
    """

    __tablename__ = "agent_network_messages"
    __table_args__ = (
        db.PrimaryKeyConstraint("id", name="agent_network_message_pkey"),
        db.Index("agent_network_message_conversation_idx", "conversation_id", "created_at"),
    )

    id = db.Column(db.String(36), primary_key=True, default=new_uuid)
    conversation_id = db.Column(
        db.String(36),
        db.ForeignKey("agent_network_conversations.id", ondelete="CASCADE"),
        nullable=False,
    )

    role = db.Column(db.String(32), nullable=False)
    status = db.Column(db.String(32), nullable=False, default="success")
    apply_status = db.Column(db.String(32), nullable=True)

    # 气泡展示文字
    content = db.Column(db.Text, nullable=False, default="")

    # Agent Network 返回的伪代码，通常只有 assistant 消息有
    pseudocode = db.Column(db.Text, nullable=True)

    # 应用到画布后的节点数和连线数
    nodes_count = db.Column(db.Integer, nullable=True)
    edges_count = db.Column(db.Integer, nullable=True)

    # 应用前后的 draft hash，方便以后追踪是哪一版画布
    draft_hash_before = db.Column(db.String(255), nullable=True)
    draft_hash_after = db.Column(db.String(255), nullable=True)

    # 错误信息
    error_code = db.Column(db.String(255), nullable=True)
    error_message = db.Column(db.Text, nullable=True)

    # 额外信息，后面扩展用
    meta = db.Column(db.JSON, nullable=False, default=dict)

    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "role": self.role,
            "status": self.status,
            "apply_status": self.apply_status,
            "content": self.content,
            "pseudocode": self.pseudocode,
            "nodes_count": self.nodes_count,
            "edges_count": self.edges_count,
            "draft_hash_before": self.draft_hash_before,
            "draft_hash_after": self.draft_hash_after,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "meta": self.meta or {},
            "created_at": int(self.created_at.timestamp()) if self.created_at else None,
            "updated_at": int(self.updated_at.timestamp()) if self.updated_at else None,
        }