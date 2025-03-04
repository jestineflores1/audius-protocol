import logging

from sqlalchemy import func
from src.models import Play
from src.tasks.aggregates import init_task_and_acquire_lock, update_aggregate_table
from src.tasks.celery_app import celery

logger = logging.getLogger(__name__)

AGGREGATE_PLAYS_TABLE_NAME = "aggregate_plays"

# UPDATE_AGGREGATE_PLAYS_QUERY
# Get new plays that came after the last indexing checkpoint for aggregate_play
# Group those new plays by play item id to get the aggregate play counts
# For new play item ids, insert those aggregate counts
# For existing play item ids, add the new aggregate count to the existing aggregate count
UPDATE_AGGREGATE_PLAYS_QUERY = """
    WITH new_plays AS (
        SELECT
            play_item_id,
            count(play_item_id) AS count
        FROM
            plays p
        WHERE
            p.id > :prev_id_checkpoint
            AND p.id <= :current_id_checkpoint
        GROUP BY
            play_item_id
    )
    INSERT INTO
        aggregate_plays (play_item_id, count)
    SELECT
        new_plays.play_item_id,
        new_plays.count
    FROM
        new_plays ON CONFLICT (play_item_id) DO
    UPDATE
    SET
        count = aggregate_plays.count + EXCLUDED.count
    """


def _update_aggregate_plays(session, _=None):
    current_id_checkpoint = (session.query(func.max(Play.id))).scalar()

    update_aggregate_table(
        logger,
        session,
        AGGREGATE_PLAYS_TABLE_NAME,
        UPDATE_AGGREGATE_PLAYS_QUERY,
        "id_checkpoint",
        current_id_checkpoint,
    )


# ####### CELERY TASKS ####### #
@celery.task(name="update_aggregate_plays", bind=True)
def update_aggregate_plays(self):
    # Cache custom task class properties
    # Details regarding custom task context can be found in wiki
    # Custom Task definition can be found in src/app.py
    db = update_aggregate_plays.db
    redis = update_aggregate_plays.redis

    init_task_and_acquire_lock(
        logger, db, redis, AGGREGATE_PLAYS_TABLE_NAME, _update_aggregate_plays
    )
