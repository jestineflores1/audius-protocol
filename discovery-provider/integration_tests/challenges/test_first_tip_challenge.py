import logging
from datetime import datetime

import redis
from src.challenges.challenge_event_bus import ChallengeEvent, ChallengeEventBus
from src.challenges.send_first_tip_challenge import send_first_tip_challenge_manager
from src.models import Block, User
from src.models.models import Challenge
from src.utils.config import shared_config
from src.utils.db_session import get_db

REDIS_URL = shared_config["redis"]["url"]
BLOCK_NUMBER = 10
logger = logging.getLogger(__name__)


def test_first_tip_challenge(app):
    redis_conn = redis.Redis.from_url(url=REDIS_URL)

    with app.app_context():
        db = get_db()

    block = Block(blockhash="0x1", number=BLOCK_NUMBER)
    user = User(
        blockhash="0x1",
        blocknumber=BLOCK_NUMBER,
        txhash="xyz",
        user_id=1,
        is_current=True,
        handle="TestHandle",
        handle_lc="testhandle",
        wallet="0x1",
        is_creator=False,
        is_verified=False,
        name="test_name",
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )

    with db.scoped_session() as session:
        bus = ChallengeEventBus(redis_conn)
        session.query(Challenge).filter(Challenge.id == "send-first-tip").update(
            {"active": True, "starting_block": BLOCK_NUMBER}
        )

        # Register events with the bus
        bus.register_listener(ChallengeEvent.send_tip, send_first_tip_challenge_manager)

        session.add(block)
        session.flush()
        session.add(user)
        session.flush()

        bus.dispatch(
            ChallengeEvent.send_tip,
            BLOCK_NUMBER,
            1,  # user_id
            {},
        )

        bus.flush()
        bus.process_events(session)
        session.flush()

        state = send_first_tip_challenge_manager.get_user_challenge_state(
            session, ["1"]
        )[0]

        assert state.is_complete
