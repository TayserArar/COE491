"""Convert timestamp columns from naive TIMESTAMP to TIMESTAMPTZ.

Revision ID: 20260303_tz_aware
Revises:
Create Date: 2026-03-03

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "20260303_tz_aware"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # uploads.uploaded_at
    op.alter_column(
        "uploads",
        "uploaded_at",
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(timezone=False),
        postgresql_using="uploaded_at AT TIME ZONE 'UTC'",
    )

    # prediction_runs.created_at
    op.alter_column(
        "prediction_runs",
        "created_at",
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(timezone=False),
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )

    # users.created_at
    op.alter_column(
        "users",
        "created_at",
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(timezone=False),
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )

    # users.last_login_at
    op.alter_column(
        "users",
        "last_login_at",
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(timezone=False),
        existing_nullable=True,
        postgresql_using="last_login_at AT TIME ZONE 'UTC'",
    )

    # audit_logs.created_at
    op.alter_column(
        "audit_logs",
        "created_at",
        type_=sa.DateTime(timezone=True),
        existing_type=sa.DateTime(timezone=False),
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )


def downgrade() -> None:
    # audit_logs.created_at
    op.alter_column(
        "audit_logs",
        "created_at",
        type_=sa.DateTime(timezone=False),
        existing_type=sa.DateTime(timezone=True),
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )

    # users.last_login_at
    op.alter_column(
        "users",
        "last_login_at",
        type_=sa.DateTime(timezone=False),
        existing_type=sa.DateTime(timezone=True),
        existing_nullable=True,
        postgresql_using="last_login_at AT TIME ZONE 'UTC'",
    )

    # users.created_at
    op.alter_column(
        "users",
        "created_at",
        type_=sa.DateTime(timezone=False),
        existing_type=sa.DateTime(timezone=True),
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )

    # prediction_runs.created_at
    op.alter_column(
        "prediction_runs",
        "created_at",
        type_=sa.DateTime(timezone=False),
        existing_type=sa.DateTime(timezone=True),
        postgresql_using="created_at AT TIME ZONE 'UTC'",
    )

    # uploads.uploaded_at
    op.alter_column(
        "uploads",
        "uploaded_at",
        type_=sa.DateTime(timezone=False),
        existing_type=sa.DateTime(timezone=True),
        postgresql_using="uploaded_at AT TIME ZONE 'UTC'",
    )
