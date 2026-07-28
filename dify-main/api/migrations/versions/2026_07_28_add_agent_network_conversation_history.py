"""add agent network conversation history

Revision ID: 20260728_agent_network_chat
Revises: d9e8f7a6b5c4
Create Date: 2026-07-28
"""

from alembic import op
import sqlalchemy as sa


revision = "20260728_agent_network_chat"
down_revision = "d9e8f7a6b5c4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_network_conversations",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("tenant_id", sa.String(length=36), nullable=False),
        sa.Column("app_id", sa.String(length=36), nullable=False),
        sa.Column("created_by", sa.String(length=36), nullable=False),
        sa.Column("applied_message_id", sa.String(length=36), nullable=True),
        sa.Column("applied_task", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id", name="agent_network_conversation_pkey"),
        sa.UniqueConstraint("tenant_id", "app_id", name="agent_network_conversation_tenant_app_unique"),
    )

    op.create_index(
        "agent_network_conversation_app_idx",
        "agent_network_conversations",
        ["tenant_id", "app_id"],
    )

    op.create_table(
        "agent_network_messages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("parent_message_id", sa.String(length=36), nullable=True),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="success"),
        sa.Column("apply_status", sa.String(length=32), nullable=True),
        sa.Column("content", sa.Text(), nullable=False, server_default=""),
        sa.Column("pseudocode", sa.Text(), nullable=True),
        sa.Column("nodes_count", sa.Integer(), nullable=True),
        sa.Column("edges_count", sa.Integer(), nullable=True),
        sa.Column("draft_hash_before", sa.String(length=255), nullable=True),
        sa.Column("draft_hash_after", sa.String(length=255), nullable=True),
        sa.Column("error_code", sa.String(length=255), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id", name="agent_network_message_pkey"),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["agent_network_conversations.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["parent_message_id"],
            ["agent_network_messages.id"],
            ondelete="SET NULL",
        ),
    )

    op.create_index(
        "agent_network_message_conversation_idx",
        "agent_network_messages",
        ["conversation_id", "created_at"],
    )
    op.create_index(
        "agent_network_message_parent_idx",
        "agent_network_messages",
        ["parent_message_id"],
    )


def downgrade():
    op.drop_index("agent_network_message_conversation_idx", table_name="agent_network_messages")
    op.drop_index("agent_network_message_parent_idx", table_name="agent_network_messages")
    op.drop_table("agent_network_messages")

    op.drop_index("agent_network_conversation_app_idx", table_name="agent_network_conversations")
    op.drop_table("agent_network_conversations")