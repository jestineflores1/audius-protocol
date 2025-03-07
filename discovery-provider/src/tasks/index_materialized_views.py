import logging
import os
import time

from src.tasks.celery_app import celery

logger = logging.getLogger(__name__)

DEFAULT_UPDATE_TIMEOUT = 60 * 60 * 6  # 6 hours


def update_views(self, db):
    with db.scoped_session() as session:
        start_time = time.time()
        if os.getenv("audius_elasticsearch_search_enabled"):
            session.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY tag_track_user")
            logger.info(
                f"index_materialized_views.py | Finished updating tag_track_user in: {time.time() - start_time} sec."
            )
            return

        logger.info("index_materialized_views.py | Updating materialized views")
        session.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY user_lexeme_dict")
        session.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY track_lexeme_dict")
        session.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY playlist_lexeme_dict")
        session.execute("REFRESH MATERIALIZED VIEW CONCURRENTLY album_lexeme_dict")

    logger.info(
        f"index_materialized_views.py | Finished updating materialized views in: {time.time() - start_time} sec."
    )


# ####### CELERY TASKS ####### #
@celery.task(name="update_materialized_views", bind=True)
def update_materialized_views(self):
    # Cache custom task class properties
    # Details regarding custom task context can be found in wiki
    # Custom Task definition can be found in src/app.py
    db = update_materialized_views.db
    redis = update_materialized_views.redis
    # Define lock acquired boolean
    have_lock = False
    # Define redis lock object
    update_lock = redis.lock("materialized_view_lock", timeout=DEFAULT_UPDATE_TIMEOUT)
    try:
        # Attempt to acquire lock - do not block if unable to acquire
        have_lock = update_lock.acquire(blocking=False)
        if have_lock:
            update_views(self, db)
        else:
            logger.info(
                "index_materialized_views.py | Failed to acquire update_materialized_views"
            )
    except Exception as e:
        logger.error(
            "index_materialized_views.py | Fatal error in main loop", exc_info=True
        )
        raise e
    finally:
        if have_lock:
            update_lock.release()
