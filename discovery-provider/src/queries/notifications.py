import logging  # pylint: disable=C0302
from datetime import date, datetime, timedelta
from typing import List, Tuple

from flask import Blueprint, request
from redis import Redis
from sqlalchemy import desc
from src import api_helpers
from src.models import (
    AggregateUser,
    Block,
    ChallengeDisbursement,
    Follow,
    Milestone,
    Playlist,
    Remix,
    Repost,
    RepostType,
    Save,
    SaveType,
    SupporterRankUp,
    Track,
    User,
    UserBalanceChange,
    UserTip,
)
from src.models.reaction import Reaction
from src.queries import response_name_constants as const
from src.queries.get_prev_track_entries import get_prev_track_entries
from src.queries.query_helpers import (
    get_follower_count_dict,
    get_repost_counts,
    get_save_counts,
)
from src.tasks.index_listen_count_milestones import LISTEN_COUNT_MILESTONE
from src.utils import web3_provider
from src.utils.config import shared_config
from src.utils.db_session import get_db_read_replica
from src.utils.redis_connection import get_redis
from src.utils.redis_constants import (
    latest_sol_aggregate_tips_slot_key,
    latest_sol_listen_count_milestones_slot_key,
    latest_sol_rewards_manager_slot_key,
)
from src.utils.spl_audio import to_wei_string

logger = logging.getLogger(__name__)
bp = Blueprint("notifications", __name__)

max_block_diff = int(shared_config["discprov"]["notifications_max_block_diff"])
max_slot_diff = int(shared_config["discprov"]["notifications_max_slot_diff"])


# pylint: disable=R0911
def get_owner_id(session, entity_type, entity_id):
    """
    Fetches the owner user id of the requested entity_type/entity_id

    Args:
        session: (obj) The start block number for querying for notifications
        entity_type: (string) Must be either 'track' | 'album' | 'playlist
        entity_id: (int) The id of the 'entity_type'

    Returns:
        owner_id: (int | None) The user id of the owner of the entity_type/entity_id
    """
    if entity_type == "track":
        owner_id_query = (
            session.query(Track.owner_id)
            .filter(
                Track.track_id == entity_id,
                Track.is_delete == False,
                Track.is_current == True,
            )
            .all()
        )
        if not owner_id_query:
            return None
        owner_id = owner_id_query[0][0]
        return owner_id

    if entity_type == "album":
        owner_id_query = (
            session.query(Playlist.playlist_owner_id)
            .filter(
                Playlist.playlist_id == entity_id,
                Playlist.is_delete == False,
                Playlist.is_current == True,
                Playlist.is_album == True,
            )
            .all()
        )
        if not owner_id_query:
            return None
        owner_id = owner_id_query[0][0]
        return owner_id

    if entity_type == "playlist":
        owner_id_query = (
            session.query(Playlist.playlist_owner_id)
            .filter(
                Playlist.playlist_id == entity_id,
                Playlist.is_delete == False,
                Playlist.is_current == True,
                Playlist.is_album == False,
            )
            .all()
        )
        if not owner_id_query:
            return None
        owner_id = owner_id_query[0][0]
        return owner_id

    return None


def get_cosign_remix_notifications(session, max_block_number, remix_tracks):
    """
    Get the notifications for remix tracks that are reposted/favorited by the parent remix author

    Args:
        session: (DB)
        max_block_number: (int)
        remix_tracks: (Array<{ }>)
            'user_id'
            'item_id'
            const.notification_blocknumber
            const.notification_timestamp
            'item_owner_id'

    Returns:
        Array of cosign notifications

    """
    if not remix_tracks:
        return []

    remix_notifications = []
    remix_track_ids = [r["item_id"] for r in remix_tracks]

    # Query for all the parent tracks of the remix tracks
    tracks_subquery = (
        session.query(Track)
        .filter(
            Track.is_unlisted == False,
            Track.is_delete == False,
            Track.is_current == True,
        )
        .subquery()
    )

    parent_tracks = (
        session.query(
            Remix.child_track_id, Remix.parent_track_id, tracks_subquery.c.owner_id
        )
        .join(tracks_subquery, Remix.parent_track_id == tracks_subquery.c.track_id)
        .filter(Remix.child_track_id.in_(remix_track_ids))
        .all()
    )
    # Mapping of parent track users to child track to parent track
    parent_track_users_to_remixes = {}
    for track_parent in parent_tracks:
        [remix_track_id, remix_parent_id, remix_parent_user_id] = track_parent
        if remix_parent_user_id not in parent_track_users_to_remixes:
            parent_track_users_to_remixes[remix_parent_user_id] = {
                remix_track_id: remix_parent_id
            }
        else:
            parent_track_users_to_remixes[remix_parent_user_id][
                remix_track_id
            ] = remix_parent_id

    for remix_track in remix_tracks:
        user_id = remix_track["user_id"]
        track_id = remix_track["item_id"]

        if (
            user_id in parent_track_users_to_remixes
            and track_id in parent_track_users_to_remixes[user_id]
        ):
            remix_notifications.append(
                {
                    const.notification_type: const.notification_type_remix_cosign,
                    const.notification_blocknumber: remix_track[
                        const.notification_blocknumber
                    ],
                    const.notification_timestamp: remix_track[
                        const.notification_timestamp
                    ],
                    const.notification_initiator: user_id,
                    const.notification_metadata: {
                        const.notification_entity_id: track_id,
                        const.notification_entity_type: "track",
                        const.notification_entity_owner_id: remix_track[
                            "item_owner_id"
                        ],
                    },
                }
            )

    return remix_notifications


@bp.route("/notifications", methods=("GET",))
# pylint: disable=R0915
def notifications():
    """
    Fetches the notifications events that occurred between the given block numbers

    URL Params:
        min_block_number: (int) The start block number for querying for notifications
        max_block_number?: (int) The end block number for querying for notifications
        track_id?: (Array<int>) Array of track id for fetching the track's owner id
            and adding the track id to owner user id mapping to the `owners` response field
            NOTE: this is added for notification for listen counts

    Response - Json object w/ the following fields
        notifications: Array of notifications of shape:
            type: 'Follow' | 'Favorite' | 'Repost' | 'Create' | 'RemixCreate' | 'RemixCosign' | 'PlaylistUpdate'
            blocknumber: (int) blocknumber of notification
            timestamp: (string) timestamp of notification
            initiator: (int) the user id that caused this notification
            metadata?: (any) additional information about the notification
                entity_id?: (int) the id of the target entity (ie. playlist id of a playlist that is reposted)
                entity_type?: (string) the type of the target entity
                entity_owner_id?: (int) the id of the target entity's owner (if applicable)
                playlist_update_timestamp?: (string) timestamp of last update of a given playlist
                playlist_update_users?: (array<int>) user ids which favorited a given playlist

        info: Dictionary of metadata w/ min_block_number & max_block_number fields

        milestones: Dictionary mapping of follows/reposts/favorites (processed within the blocks params)
            Root fields:
                follower_counts: Contains a dictionary of user id => follower count (up to the max_block_number)
                repost_counts: Contains a dictionary tracks/albums/playlists of id to repost count
                favorite_counts: Contains a dictionary tracks/albums/playlists of id to favorite count

        owners: Dictionary containing the mapping for track id / playlist id / album -> owner user id
            The root keys are 'tracks', 'playlists', 'albums' and each contains the id to owner id mapping
    """

    db = get_db_read_replica()
    web3 = web3_provider.get_web3()
    min_block_number = request.args.get("min_block_number", type=int)
    max_block_number = request.args.get("max_block_number", type=int)

    track_ids_to_owner = []
    try:
        track_ids_str_list = request.args.getlist("track_id")
        track_ids_to_owner = [int(y) for y in track_ids_str_list]
    except Exception as e:
        logger.error(f"Failed to retrieve track list {e}")

    # Max block number is not explicitly required (yet)
    if not min_block_number and min_block_number != 0:
        return api_helpers.error_response({"msg": "Missing min block number"}, 400)

    if not max_block_number:
        max_block_number = min_block_number + max_block_diff
    elif (max_block_number - min_block_number) > max_block_diff:
        max_block_number = min_block_number + max_block_diff

    with db.scoped_session() as session:
        current_block_query = session.query(Block).filter_by(is_current=True)
        current_block_query_results = current_block_query.all()
        current_block = current_block_query_results[0]
        current_max_block_num = current_block.number
        if current_max_block_num < max_block_number:
            max_block_number = current_max_block_num

    notification_metadata = {
        "min_block_number": min_block_number,
        "max_block_number": max_block_number,
    }

    # Retrieve milestones statistics
    milestone_info = {}

    # Cache owner info for network entities and pass in w/results
    owner_info = {const.tracks: {}, const.albums: {}, const.playlists: {}}

    start_time = datetime.now()
    logger.info(f"notifications.py | start_time ${start_time}")

    # List of notifications generated from current protocol state
    notifications_unsorted = []
    with db.scoped_session() as session:
        #
        # Query relevant follow information
        #
        follow_query = session.query(Follow)

        # Impose min block number restriction
        follow_query = follow_query.filter(
            Follow.is_current == True,
            Follow.is_delete == False,
            Follow.blocknumber > min_block_number,
            Follow.blocknumber <= max_block_number,
        )

        follow_results = follow_query.all()
        # Used to retrieve follower counts for this window
        followed_users = []
        # Represents all follow notifications
        follow_notifications = []
        for entry in follow_results:
            follow_notif = {
                const.notification_type: const.notification_type_follow,
                const.notification_blocknumber: entry.blocknumber,
                const.notification_timestamp: entry.created_at,
                const.notification_initiator: entry.follower_user_id,
                const.notification_metadata: {
                    const.notification_follower_id: entry.follower_user_id,
                    const.notification_followee_id: entry.followee_user_id,
                },
            }
            follow_notifications.append(follow_notif)
            # Add every user who gained a new follower
            followed_users.append(entry.followee_user_id)

        # Query count for any user w/new followers
        follower_counts = get_follower_count_dict(
            session, followed_users, max_block_number
        )
        milestone_info["follower_counts"] = follower_counts

        notifications_unsorted.extend(follow_notifications)

        logger.info(f"notifications.py | followers at {datetime.now() - start_time}")

        #
        # Query relevant favorite information
        #
        favorites_query = session.query(Save)
        favorites_query = favorites_query.filter(
            Save.is_current == True,
            Save.is_delete == False,
            Save.blocknumber > min_block_number,
            Save.blocknumber <= max_block_number,
        )
        favorite_results = favorites_query.all()

        # ID lists to query count aggregates
        favorited_track_ids = []
        favorited_album_ids = []
        favorited_playlist_ids = []

        # List of favorite notifications
        favorite_notifications = []
        favorite_remix_tracks = []

        for entry in favorite_results:
            favorite_notif = {
                const.notification_type: const.notification_type_favorite,
                const.notification_blocknumber: entry.blocknumber,
                const.notification_timestamp: entry.created_at,
                const.notification_initiator: entry.user_id,
            }
            save_type = entry.save_type
            save_item_id = entry.save_item_id
            metadata = {
                const.notification_entity_type: save_type,
                const.notification_entity_id: save_item_id,
            }

            # NOTE if deleted, the favorite can still exist
            # TODO: Can we aggregate all owner queries and perform at once...?
            if save_type == SaveType.track:
                owner_id = get_owner_id(session, "track", save_item_id)
                if not owner_id:
                    continue
                metadata[const.notification_entity_owner_id] = owner_id
                favorited_track_ids.append(save_item_id)
                owner_info[const.tracks][save_item_id] = owner_id

                favorite_remix_tracks.append(
                    {
                        const.notification_blocknumber: entry.blocknumber,
                        const.notification_timestamp: entry.created_at,
                        "user_id": entry.user_id,
                        "item_owner_id": owner_id,
                        "item_id": save_item_id,
                    }
                )

            elif save_type == SaveType.album:
                owner_id = get_owner_id(session, "album", save_item_id)
                if not owner_id:
                    continue
                metadata[const.notification_entity_owner_id] = owner_id
                favorited_album_ids.append(save_item_id)
                owner_info[const.albums][save_item_id] = owner_id

            elif save_type == SaveType.playlist:
                owner_id = get_owner_id(session, "playlist", save_item_id)
                if not owner_id:
                    continue
                metadata[const.notification_entity_owner_id] = owner_id
                favorited_playlist_ids.append(save_item_id)
                owner_info[const.playlists][save_item_id] = owner_id

            favorite_notif[const.notification_metadata] = metadata
            favorite_notifications.append(favorite_notif)
        notifications_unsorted.extend(favorite_notifications)

        track_favorite_dict = {}
        album_favorite_dict = {}
        playlist_favorite_dict = {}

        if favorited_track_ids:
            track_favorite_counts = get_save_counts(
                session,
                False,
                False,
                favorited_track_ids,
                [SaveType.track],
                max_block_number,
            )
            track_favorite_dict = dict(track_favorite_counts)

            favorite_remix_notifications = get_cosign_remix_notifications(
                session, max_block_number, favorite_remix_tracks
            )
            notifications_unsorted.extend(favorite_remix_notifications)

        if favorited_album_ids:
            album_favorite_counts = get_save_counts(
                session,
                False,
                False,
                favorited_album_ids,
                [SaveType.album],
                max_block_number,
            )
            album_favorite_dict = dict(album_favorite_counts)

        if favorited_playlist_ids:
            playlist_favorite_counts = get_save_counts(
                session,
                False,
                False,
                favorited_playlist_ids,
                [SaveType.playlist],
                max_block_number,
            )
            playlist_favorite_dict = dict(playlist_favorite_counts)

        milestone_info[const.notification_favorite_counts] = {}
        milestone_info[const.notification_favorite_counts][
            const.tracks
        ] = track_favorite_dict
        milestone_info[const.notification_favorite_counts][
            const.albums
        ] = album_favorite_dict
        milestone_info[const.notification_favorite_counts][
            const.playlists
        ] = playlist_favorite_dict

        logger.info(f"notifications.py | favorites at {datetime.now() - start_time}")

        #
        # Query relevant tier change information
        #
        balance_change_query = session.query(UserBalanceChange)

        # Impose min block number restriction
        balance_change_query = balance_change_query.filter(
            UserBalanceChange.blocknumber > min_block_number,
            UserBalanceChange.blocknumber <= max_block_number,
        )

        balance_change_results = balance_change_query.all()
        tier_change_notifications = []

        for entry in balance_change_results:
            prev = int(entry.previous_balance)
            current = int(entry.current_balance)
            # Check for a tier change and add to tier_change_notification
            tier = None
            if prev < 100000 <= current:
                tier = "platinum"
            elif prev < 10000 <= current:
                tier = "gold"
            elif prev < 100 <= current:
                tier = "silver"
            elif prev < 10 <= current:
                tier = "bronze"

            if tier is not None:
                tier_change_notif = {
                    const.notification_type: const.notification_type_tier_change,
                    const.notification_blocknumber: entry.blocknumber,
                    const.notification_timestamp: datetime.now(),
                    const.notification_initiator: entry.user_id,
                    const.notification_metadata: {
                        const.notification_tier: tier,
                    },
                }
                tier_change_notifications.append(tier_change_notif)

        notifications_unsorted.extend(tier_change_notifications)

        logger.info(
            f"notifications.py | balance change at {datetime.now() - start_time}"
        )

        #
        # Query relevant repost information
        #
        repost_query = session.query(Repost)
        repost_query = repost_query.filter(
            Repost.is_current == True,
            Repost.is_delete == False,
            Repost.blocknumber > min_block_number,
            Repost.blocknumber <= max_block_number,
        )
        repost_results = repost_query.all()

        # ID lists to query counts
        reposted_track_ids = []
        reposted_album_ids = []
        reposted_playlist_ids = []

        # List of repost notifications
        repost_notifications = []

        # List of repost notifications
        repost_remix_notifications = []
        repost_remix_tracks = []

        for entry in repost_results:
            repost_notif = {
                const.notification_type: const.notification_type_repost,
                const.notification_blocknumber: entry.blocknumber,
                const.notification_timestamp: entry.created_at,
                const.notification_initiator: entry.user_id,
            }
            repost_type = entry.repost_type
            repost_item_id = entry.repost_item_id
            metadata = {
                const.notification_entity_type: repost_type,
                const.notification_entity_id: repost_item_id,
            }
            if repost_type == RepostType.track:
                owner_id = get_owner_id(session, "track", repost_item_id)
                if not owner_id:
                    continue
                metadata[const.notification_entity_owner_id] = owner_id
                reposted_track_ids.append(repost_item_id)
                owner_info[const.tracks][repost_item_id] = owner_id
                repost_remix_tracks.append(
                    {
                        const.notification_blocknumber: entry.blocknumber,
                        const.notification_timestamp: entry.created_at,
                        "user_id": entry.user_id,
                        "item_owner_id": owner_id,
                        "item_id": repost_item_id,
                    }
                )

            elif repost_type == RepostType.album:
                owner_id = get_owner_id(session, "album", repost_item_id)
                if not owner_id:
                    continue
                metadata[const.notification_entity_owner_id] = owner_id
                reposted_album_ids.append(repost_item_id)
                owner_info[const.albums][repost_item_id] = owner_id

            elif repost_type == RepostType.playlist:
                owner_id = get_owner_id(session, "playlist", repost_item_id)
                if not owner_id:
                    continue
                metadata[const.notification_entity_owner_id] = owner_id
                reposted_playlist_ids.append(repost_item_id)
                owner_info[const.playlists][repost_item_id] = owner_id

            repost_notif[const.notification_metadata] = metadata
            repost_notifications.append(repost_notif)

        # Append repost notifications
        notifications_unsorted.extend(repost_notifications)

        track_repost_count_dict = {}
        album_repost_count_dict = {}
        playlist_repost_count_dict = {}

        # Aggregate repost counts for relevant fields
        # Used to notify users of entity-specific milestones
        if reposted_track_ids:
            track_repost_counts = get_repost_counts(
                session,
                False,
                False,
                reposted_track_ids,
                [RepostType.track],
                max_block_number,
            )
            track_repost_count_dict = dict(track_repost_counts)

            repost_remix_notifications = get_cosign_remix_notifications(
                session, max_block_number, repost_remix_tracks
            )
            notifications_unsorted.extend(repost_remix_notifications)

        if reposted_album_ids:
            album_repost_counts = get_repost_counts(
                session,
                False,
                False,
                reposted_album_ids,
                [RepostType.album],
                max_block_number,
            )
            album_repost_count_dict = dict(album_repost_counts)

        if reposted_playlist_ids:
            playlist_repost_counts = get_repost_counts(
                session,
                False,
                False,
                reposted_playlist_ids,
                [RepostType.playlist],
                max_block_number,
            )
            playlist_repost_count_dict = dict(playlist_repost_counts)

        milestone_info[const.notification_repost_counts] = {}
        milestone_info[const.notification_repost_counts][
            const.tracks
        ] = track_repost_count_dict
        milestone_info[const.notification_repost_counts][
            const.albums
        ] = album_repost_count_dict
        milestone_info[const.notification_repost_counts][
            const.playlists
        ] = playlist_repost_count_dict

        # Query relevant created entity notification - tracks/albums/playlists
        created_notifications = []

        logger.info(f"notifications.py | reposts at {datetime.now() - start_time}")

        #
        # Query relevant created tracks for remix information
        #
        remix_created_notifications = []

        # Aggregate track notifs
        tracks_query = session.query(Track)
        # TODO: Is it valid to use Track.is_current here? Might not be the right info...
        tracks_query = tracks_query.filter(
            Track.is_unlisted == False,
            Track.is_delete == False,
            Track.stem_of == None,
            Track.blocknumber > min_block_number,
            Track.blocknumber <= max_block_number,
        )
        tracks_query = tracks_query.filter(Track.created_at == Track.updated_at)
        track_results = tracks_query.all()
        for entry in track_results:
            track_notif = {
                const.notification_type: const.notification_type_create,
                const.notification_blocknumber: entry.blocknumber,
                const.notification_timestamp: entry.created_at,
                const.notification_initiator: entry.owner_id,
                # TODO: is entity owner id necessary for tracks?
                const.notification_metadata: {
                    const.notification_entity_type: "track",
                    const.notification_entity_id: entry.track_id,
                    const.notification_entity_owner_id: entry.owner_id,
                },
            }
            created_notifications.append(track_notif)

            if entry.remix_of:
                # Add notification to remix track owner
                parent_remix_tracks = [
                    t["parent_track_id"] for t in entry.remix_of["tracks"]
                ]
                remix_track_parents = (
                    session.query(Track.owner_id, Track.track_id)
                    .filter(
                        Track.track_id.in_(parent_remix_tracks),
                        Track.is_unlisted == False,
                        Track.is_delete == False,
                        Track.is_current == True,
                    )
                    .all()
                )
                for remix_track_parent in remix_track_parents:
                    [
                        remix_track_parent_owner,
                        remix_track_parent_id,
                    ] = remix_track_parent
                    remix_notif = {
                        const.notification_type: const.notification_type_remix_create,
                        const.notification_blocknumber: entry.blocknumber,
                        const.notification_timestamp: entry.created_at,
                        const.notification_initiator: entry.owner_id,
                        # TODO: is entity owner id necessary for tracks?
                        const.notification_metadata: {
                            const.notification_entity_type: "track",
                            const.notification_entity_id: entry.track_id,
                            const.notification_entity_owner_id: entry.owner_id,
                            const.notification_remix_parent_track_user_id: remix_track_parent_owner,
                            const.notification_remix_parent_track_id: remix_track_parent_id,
                        },
                    }
                    remix_created_notifications.append(remix_notif)

        logger.info(f"notifications.py | remixes at {datetime.now() - start_time}")

        # Handle track update notifications
        # TODO: Consider switching blocknumber for updated at?
        updated_tracks_query = session.query(Track)
        updated_tracks_query = updated_tracks_query.filter(
            Track.is_unlisted == False,
            Track.stem_of == None,
            Track.created_at != Track.updated_at,
            Track.blocknumber > min_block_number,
            Track.blocknumber <= max_block_number,
        )
        updated_tracks = updated_tracks_query.all()

        prev_tracks = get_prev_track_entries(session, updated_tracks)

        for prev_entry in prev_tracks:
            entry = next(t for t in updated_tracks if t.track_id == prev_entry.track_id)
            logger.info(
                f"notifications.py | single track update {entry.track_id} {entry.blocknumber} {datetime.now() - start_time}"
            )

            # Tracks that were unlisted and turned to public
            if prev_entry.is_unlisted == True:
                logger.info(
                    f"notifications.py | single track update to public {datetime.now() - start_time}"
                )
                track_notif = {
                    const.notification_type: const.notification_type_create,
                    const.notification_blocknumber: entry.blocknumber,
                    const.notification_timestamp: entry.created_at,
                    const.notification_initiator: entry.owner_id,
                    # TODO: is entity owner id necessary for tracks?
                    const.notification_metadata: {
                        const.notification_entity_type: "track",
                        const.notification_entity_id: entry.track_id,
                        const.notification_entity_owner_id: entry.owner_id,
                    },
                }
                created_notifications.append(track_notif)

            # Tracks that were not remixes and turned into remixes
            if not prev_entry.remix_of and entry.remix_of:
                # Add notification to remix track owner
                parent_remix_tracks = [
                    t["parent_track_id"] for t in entry.remix_of["tracks"]
                ]
                remix_track_parents = (
                    session.query(Track.owner_id, Track.track_id)
                    .filter(
                        Track.track_id.in_(parent_remix_tracks),
                        Track.is_unlisted == False,
                        Track.is_delete == False,
                        Track.is_current == True,
                    )
                    .all()
                )
                logger.info(
                    f"notifications.py | single track update parents {remix_track_parents} {datetime.now() - start_time}"
                )
                for remix_track_parent in remix_track_parents:
                    [
                        remix_track_parent_owner,
                        remix_track_parent_id,
                    ] = remix_track_parent
                    remix_notif = {
                        const.notification_type: const.notification_type_remix_create,
                        const.notification_blocknumber: entry.blocknumber,
                        const.notification_timestamp: entry.created_at,
                        const.notification_initiator: entry.owner_id,
                        # TODO: is entity owner id necessary for tracks?
                        const.notification_metadata: {
                            const.notification_entity_type: "track",
                            const.notification_entity_id: entry.track_id,
                            const.notification_entity_owner_id: entry.owner_id,
                            const.notification_remix_parent_track_user_id: remix_track_parent_owner,
                            const.notification_remix_parent_track_id: remix_track_parent_id,
                        },
                    }
                    remix_created_notifications.append(remix_notif)

        notifications_unsorted.extend(remix_created_notifications)

        logger.info(
            f"notifications.py | track updates at {datetime.now() - start_time}"
        )

        # Aggregate playlist/album notifs
        collection_query = session.query(Playlist)
        # TODO: Is it valid to use is_current here? Might not be the right info...
        collection_query = collection_query.filter(
            Playlist.is_delete == False,
            Playlist.is_private == False,
            Playlist.blocknumber > min_block_number,
            Playlist.blocknumber <= max_block_number,
        )
        collection_query = collection_query.filter(
            Playlist.created_at == Playlist.updated_at
        )
        collection_results = collection_query.all()

        for entry in collection_results:
            collection_notif = {
                const.notification_type: const.notification_type_create,
                const.notification_blocknumber: entry.blocknumber,
                const.notification_timestamp: entry.created_at,
                const.notification_initiator: entry.playlist_owner_id,
            }
            metadata = {
                const.notification_entity_id: entry.playlist_id,
                const.notification_entity_owner_id: entry.playlist_owner_id,
                const.notification_collection_content: entry.playlist_contents,
            }

            if entry.is_album:
                metadata[const.notification_entity_type] = "album"
            else:
                metadata[const.notification_entity_type] = "playlist"
            collection_notif[const.notification_metadata] = metadata
            created_notifications.append(collection_notif)

        # Playlists that were private and turned to public aka 'published'
        # TODO: Consider switching blocknumber for updated at?
        publish_playlists_query = session.query(Playlist)
        publish_playlists_query = publish_playlists_query.filter(
            Playlist.is_private == False,
            Playlist.created_at != Playlist.updated_at,
            Playlist.blocknumber > min_block_number,
            Playlist.blocknumber <= max_block_number,
        )
        publish_playlist_results = publish_playlists_query.all()
        for entry in publish_playlist_results:
            prev_entry_query = (
                session.query(Playlist)
                .filter(
                    Playlist.playlist_id == entry.playlist_id,
                    Playlist.blocknumber < entry.blocknumber,
                )
                .order_by(desc(Playlist.blocknumber))
            )
            # Previous private entry indicates transition to public, triggering a notification
            prev_entry = prev_entry_query.first()
            if prev_entry.is_private == True:
                publish_playlist_notif = {
                    const.notification_type: const.notification_type_create,
                    const.notification_blocknumber: entry.blocknumber,
                    const.notification_timestamp: entry.created_at,
                    const.notification_initiator: entry.playlist_owner_id,
                }
                metadata = {
                    const.notification_entity_id: entry.playlist_id,
                    const.notification_entity_owner_id: entry.playlist_owner_id,
                    const.notification_collection_content: entry.playlist_contents,
                    const.notification_entity_type: "playlist",
                }
                publish_playlist_notif[const.notification_metadata] = metadata
                created_notifications.append(publish_playlist_notif)

        # Playlists that had tracks added to them
        # Get all playlists that were modified over this range
        playlist_track_added_query = session.query(Playlist).filter(
            Playlist.is_current == True,
            Playlist.is_delete == False,
            Playlist.is_private == False,
            Playlist.blocknumber > min_block_number,
            Playlist.blocknumber <= max_block_number,
        )
        playlist_track_added_results = playlist_track_added_query.all()
        # Loop over all playlist updates and determine if there were tracks added
        # at the block that the playlist update is at
        track_added_to_playlist_notifications = []
        track_ids = []
        for entry in playlist_track_added_results:
            # Get the track_ids from entry["playlist_contents"]
            if not entry.playlist_contents["track_ids"]:
                # skip empty playlists
                continue
            playlist_contents = entry.playlist_contents
            min_block = web3.eth.get_block(min_block_number)
            max_block = web3.eth.get_block(max_block_number)

            for track in playlist_contents["track_ids"]:
                track_id = track["track"]
                track_timestamp = track["time"]
                # We know that this track was added to the playlist at this specific update
                if (
                    min_block.timestamp < track_timestamp
                    and track_timestamp <= max_block.timestamp
                ):
                    track_ids.append(track_id)
                    track_added_to_playlist_notification = {
                        const.notification_type: const.notification_type_track_added_to_playlist,
                        const.notification_blocknumber: entry.blocknumber,
                        const.notification_timestamp: entry.created_at,
                        const.notification_initiator: entry.playlist_owner_id,
                    }
                    metadata = {
                        const.playlist_id: entry.playlist_id,
                        const.track_id: track_id,
                    }
                    track_added_to_playlist_notification[
                        const.notification_metadata
                    ] = metadata
                    track_added_to_playlist_notifications.append(
                        track_added_to_playlist_notification
                    )

        tracks = (
            session.query(Track.owner_id, Track.track_id)
            .filter(
                Track.track_id.in_(track_ids),
                Track.is_unlisted == False,
                Track.is_delete == False,
                Track.is_current == True,
            )
            .all()
        )
        track_owner_map = {}
        for track in tracks:
            owner_id, track_id = track
            track_owner_map[track_id] = owner_id

        # Loop over notifications and populate their metadata
        for notification in track_added_to_playlist_notifications:
            track_id = notification[const.notification_metadata][const.track_id]
            track_owner_id = track_owner_map[track_id]
            if track_owner_id != notification[const.notification_initiator]:
                # add tracks that don't belong to the playlist owner
                notification[const.notification_metadata][
                    const.track_owner_id
                ] = track_owner_id
                created_notifications.append(notification)

        notifications_unsorted.extend(created_notifications)

        logger.info(f"notifications.py | playlists at {datetime.now() - start_time}")

        # Get additional owner info as requested for listen counts
        tracks_owner_query = session.query(Track).filter(
            Track.is_current == True, Track.track_id.in_(track_ids_to_owner)
        )
        track_owner_results = tracks_owner_query.all()
        for entry in track_owner_results:
            owner = entry.owner_id
            track_id = entry.track_id
            owner_info[const.tracks][track_id] = owner

        logger.info(
            f"notifications.py | owner info at {datetime.now() - start_time}, owners {len(track_owner_results)}"
        )

        # Get playlist updates
        today = date.today()
        thirty_days_ago = today - timedelta(days=30)
        thirty_days_ago_time = datetime(
            thirty_days_ago.year, thirty_days_ago.month, thirty_days_ago.day, 0, 0, 0
        )
        playlist_update_query = session.query(Playlist)
        playlist_update_query = playlist_update_query.filter(
            Playlist.is_current == True,
            Playlist.is_delete == False,
            Playlist.last_added_to >= thirty_days_ago_time,
            Playlist.blocknumber > min_block_number,
            Playlist.blocknumber <= max_block_number,
        )

        playlist_update_results = playlist_update_query.all()

        logger.info(
            f"notifications.py | get playlist updates at {datetime.now() - start_time}, playlist updates {len(playlist_update_results)}"
        )

        # Represents all playlist update notifications
        playlist_update_notifications = []
        playlist_update_notifs_by_playlist_id = {}
        for entry in playlist_update_results:
            playlist_update_notifs_by_playlist_id[entry.playlist_id] = {
                const.notification_type: const.notification_type_playlist_update,
                const.notification_blocknumber: entry.blocknumber,
                const.notification_timestamp: entry.created_at,
                const.notification_initiator: entry.playlist_owner_id,
                const.notification_metadata: {
                    const.notification_entity_id: entry.playlist_id,
                    const.notification_entity_type: "playlist",
                    const.notification_playlist_update_timestamp: entry.last_added_to,
                },
            }

        # get all favorited playlists
        # playlists may have been favorited outside the blocknumber bounds
        # e.g. before the min_block_number
        playlist_favorites_query = session.query(Save)
        playlist_favorites_query = playlist_favorites_query.filter(
            Save.is_current == True,
            Save.is_delete == False,
            Save.save_type == SaveType.playlist,
            Save.save_item_id.in_(playlist_update_notifs_by_playlist_id.keys()),
        )
        playlist_favorites_results = playlist_favorites_query.all()

        logger.info(
            f"notifications.py | get playlist favorites {datetime.now() - start_time}, playlist favorites {len(playlist_favorites_results)}"
        )

        # dictionary of playlist id => users that favorited said playlist
        # e.g. { playlist1: [user1, user2, ...], ... }
        # we need this dictionary to know which users need to be notified of a playlist update
        users_that_favorited_playlists_dict = {}
        for result in playlist_favorites_results:
            if result.save_item_id in users_that_favorited_playlists_dict:
                users_that_favorited_playlists_dict[result.save_item_id].append(
                    result.user_id
                )
            else:
                users_that_favorited_playlists_dict[result.save_item_id] = [
                    result.user_id
                ]

        logger.info(
            f"notifications.py | computed users that favorited dict {datetime.now() - start_time}"
        )

        for playlist_id in users_that_favorited_playlists_dict:
            # TODO: We probably do not need this check because we are filtering
            # playlist_favorites_query to only matching ids
            if playlist_id not in playlist_update_notifs_by_playlist_id:
                continue
            playlist_update_notif = playlist_update_notifs_by_playlist_id[playlist_id]
            playlist_update_notif[const.notification_metadata].update(
                {
                    const.notification_playlist_update_users: users_that_favorited_playlists_dict[
                        playlist_id
                    ]
                }
            )
            playlist_update_notifications.append(playlist_update_notif)

        notifications_unsorted.extend(playlist_update_notifications)

        logger.info(
            f"notifications.py | all playlist updates at {datetime.now() - start_time}"
        )

    # Final sort - TODO: can we sort by timestamp?
    sorted_notifications = sorted(
        notifications_unsorted,
        key=lambda i: i[const.notification_blocknumber],
        reverse=False,
    )

    logger.info(
        f"notifications.py | sorted notifications {datetime.now() - start_time}"
    )

    return api_helpers.success_response(
        {
            "notifications": sorted_notifications,
            "info": notification_metadata,
            "milestones": milestone_info,
            "owners": owner_info,
        }
    )


def get_max_slot(redis: Redis):
    listen_milestone_slot = redis.get(latest_sol_listen_count_milestones_slot_key)
    if listen_milestone_slot:
        listen_milestone_slot = int(listen_milestone_slot)

    rewards_manager_slot = redis.get(latest_sol_rewards_manager_slot_key)
    if rewards_manager_slot:
        rewards_manager_slot = int(rewards_manager_slot)

    supporter_rank_up_slot = redis.get(latest_sol_aggregate_tips_slot_key)
    if supporter_rank_up_slot:
        supporter_rank_up_slot = int(supporter_rank_up_slot)

    all_slots = list(
        filter(
            lambda x: x is not None,
            [listen_milestone_slot, rewards_manager_slot, supporter_rank_up_slot],
        )
    )
    logger.info(
        f"notifications.py | get_max_slot() | listen_milestone_slot:{listen_milestone_slot} rewards_manager_slot:{rewards_manager_slot} supporter_rank_up_slot:{supporter_rank_up_slot}"
    )
    if len(all_slots) == 0:
        return 0
    return min(all_slots)


@bp.route("/solana_notifications", methods=("GET",))
def solana_notifications():
    """
    Fetches the notifications events that occurred between the given slot numbers

    URL Params:
        min_slot_number: (int) The start slot number for querying for notifications
        max_slot_number?: (int) The end slot number for querying for notifications

    Response - Json object w/ the following fields
        notifications: Array of notifications of shape:
            type: 'ChallengeReward' | 'MilestoneListen' | 'SupporterRankUp' | 'Reaction'
            slot: (int) slot number of notification
            initiator: (int) the user id that caused this notification
            metadata?: (any) additional information about the notification
                challenge_id?: (int) completed challenge id for challenge reward notifications

        info: Dictionary of metadata w/ min_slot_number & max_slot_number fields
    """
    db = get_db_read_replica()
    redis = get_redis()
    min_slot_number = request.args.get("min_slot_number", type=int)
    max_slot_number = request.args.get("max_slot_number", type=int)

    # Max slot number is not explicitly required (yet)
    if not min_slot_number and min_slot_number != 0:
        return api_helpers.error_response({"msg": "Missing min slot number"}, 400)

    if not max_slot_number or (max_slot_number - min_slot_number) > max_slot_diff:
        max_slot_number = min_slot_number + max_slot_diff

    max_valid_slot = get_max_slot(redis)
    max_slot_number = min(max_slot_number, max_valid_slot)

    notifications_unsorted = []
    notification_metadata = {
        "min_slot_number": min_slot_number,
        "max_slot_number": max_slot_number,
    }

    with db.scoped_session() as session:
        #
        # Query relevant challenge disbursement information for challenge reward notifications
        #
        challenge_disbursement_results = (
            session.query(ChallengeDisbursement)
            .filter(
                ChallengeDisbursement.slot >= min_slot_number,
                ChallengeDisbursement.slot <= max_slot_number,
            )
            .all()
        )

        challenge_reward_notifications = []
        for result in challenge_disbursement_results:
            challenge_reward_notifications.append(
                {
                    const.solana_notification_type: const.solana_notification_type_challenge_reward,
                    const.solana_notification_slot: result.slot,
                    const.solana_notification_initiator: result.user_id,
                    const.solana_notification_metadata: {
                        const.solana_notification_challenge_id: result.challenge_id,
                    },
                }
            )

        track_listen_milestone: List[Tuple(Milestone, int)] = (
            session.query(Milestone, Track.owner_id)
            .filter(
                Milestone.name == LISTEN_COUNT_MILESTONE,
                Milestone.slot >= min_slot_number,
                Milestone.slot <= max_slot_number,
            )
            .join(Track, Track.track_id == Milestone.id and Track.is_current == True)
            .all()
        )

        track_listen_milestones = []
        for result in track_listen_milestone:
            track_milestone, track_owner_id = result
            track_listen_milestones.append(
                {
                    const.solana_notification_type: const.solana_notification_type_listen_milestone,
                    const.solana_notification_slot: track_milestone.slot,
                    const.solana_notification_initiator: track_owner_id,  # owner_id
                    const.solana_notification_metadata: {
                        const.solana_notification_threshold: track_milestone.threshold,
                        const.notification_entity_id: track_milestone.id,  # track_id
                        const.notification_entity_type: "track",
                    },
                }
            )

        supporter_rank_ups_result = (
            session.query(SupporterRankUp)
            .filter(
                SupporterRankUp.slot >= min_slot_number,
                SupporterRankUp.slot <= max_slot_number,
            )
            .all()
        )
        supporter_rank_ups = []
        for supporter_rank_up in supporter_rank_ups_result:
            supporter_rank_ups.append(
                {
                    const.solana_notification_type: const.solana_notification_type_supporter_rank_up,
                    const.solana_notification_slot: supporter_rank_up.slot,
                    const.solana_notification_initiator: supporter_rank_up.receiver_user_id,
                    const.solana_notification_metadata: {
                        const.notification_entity_id: supporter_rank_up.sender_user_id,
                        const.notification_entity_type: "user",
                        const.solana_notification_tip_rank: supporter_rank_up.rank,
                    },
                }
            )

        user_tips_result: List[UserTip] = (
            session.query(UserTip)
            .filter(
                UserTip.slot >= min_slot_number,
                UserTip.slot <= max_slot_number,
            )
            .all()
        )
        tips = []
        for user_tip in user_tips_result:
            tips.append(
                {
                    const.solana_notification_type: const.solana_notification_type_tip,
                    const.solana_notification_slot: user_tip.slot,
                    const.solana_notification_initiator: user_tip.receiver_user_id,
                    const.solana_notification_metadata: {
                        const.notification_entity_id: user_tip.sender_user_id,
                        const.notification_entity_type: "user",
                        const.solana_notification_tip_amount: to_wei_string(
                            user_tip.amount
                        ),
                        const.solana_notification_tip_signature: user_tip.signature,
                    },
                }
            )

        reaction_results: List[Tuple[Reaction, int]] = (
            session.query(Reaction, User.user_id)
            .join(User, User.wallet == Reaction.sender_wallet)
            .filter(
                Reaction.slot >= min_slot_number,
                Reaction.slot <= max_slot_number,
                User.is_current == True,
            )
            .all()
        )

        # Get tips associated with a given reaction
        tip_signatures = [
            e.reacted_to for (e, _) in reaction_results if e.reaction_type == "tip"
        ]
        reaction_tips: List[UserTip] = (
            session.query(UserTip).filter(UserTip.signature.in_(tip_signatures))
        ).all()
        tips_map = {e.signature: e for e in reaction_tips}

        reactions = []
        for (reaction, user_id) in reaction_results:
            tip = tips_map[reaction.reacted_to]
            if not tip:
                continue
            reactions.append(
                {
                    const.solana_notification_type: const.solana_notification_type_reaction,
                    const.solana_notification_slot: reaction.slot,
                    const.notification_initiator: user_id,
                    const.solana_notification_metadata: {
                        const.solana_notification_reaction_type: reaction.reaction_type,
                        const.solana_notification_reaction_reaction_value: reaction.reaction_value,
                        const.solana_notification_reaction_reacted_to_entity: {
                            const.solana_notification_tip_signature: tip.signature,
                            const.solana_notification_tip_amount: to_wei_string(
                                tip.amount
                            ),
                            const.solana_notification_tip_sender_id: tip.sender_user_id,
                        },
                    },
                }
            )
        notifications_unsorted.extend(challenge_reward_notifications)
        notifications_unsorted.extend(track_listen_milestones)
        notifications_unsorted.extend(supporter_rank_ups)
        notifications_unsorted.extend(tips)
        notifications_unsorted.extend(reactions)

    # Final sort
    sorted_notifications = sorted(
        notifications_unsorted,
        key=lambda i: i[const.solana_notification_slot],
        reverse=False,
    )

    return api_helpers.success_response(
        {
            "notifications": sorted_notifications,
            "info": notification_metadata,
        }
    )


@bp.route("/milestones/followers", methods=("GET",))
def milestones_followers():
    db = get_db_read_replica()
    if "user_id" not in request.args:
        return api_helpers.error_response({"msg": "Please provider user ids"}, 500)

    try:
        user_id_str_list = request.args.getlist("user_id")
        user_ids = []
        user_ids = [int(y) for y in user_id_str_list]
    except ValueError as e:
        logger.error("Invalid value found in user id list", esc_info=True)
        return api_helpers.error_response({"msg": e}, 500)

    with db.scoped_session() as session:
        follower_counts = (
            session.query(AggregateUser.user_id, AggregateUser.follower_count)
            .filter(AggregateUser.user_id.in_(user_ids))
            .all()
        )
        follower_count_dict = dict(follower_counts)

    return api_helpers.success_response(follower_count_dict)
