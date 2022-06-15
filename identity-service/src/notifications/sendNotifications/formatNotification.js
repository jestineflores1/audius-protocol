const models = require('../../models')
const { logger } = require('../../logging')
const {
  notificationTypes,
  actionEntityTypes
} = require('../constants')
const notificationUtils = require('./utils')

const shouldNotifyUser = (userId, prop, settings) => {
  const userNotification = { notifyMobile: false, notifyBrowserPush: false }
  if (!(userId in settings)) return userNotification
  if ('mobile' in settings[userId]) {
    userNotification['mobile'] = settings[userId]['mobile'][prop]
  }
  if ('browser' in settings[userId]) {
    userNotification['browser'] = settings[userId]['browser'][prop]
  }
  return userNotification
}

const getRepostType = (type) => {
  switch (type) {
    case 'track':
      return notificationTypes.Repost.track
    case 'album':
      return notificationTypes.Repost.album
    case 'playlist':
      return notificationTypes.Repost.playlist
    default:
      return ''
  }
}

const getFavoriteType = (type) => {
  switch (type) {
    case 'track':
      return notificationTypes.Favorite.track
    case 'album':
      return notificationTypes.Favorite.album
    case 'playlist':
      return notificationTypes.Favorite.playlist
    default:
      return ''
  }
}

let subscriberPushNotifications = []

async function formatNotifications (notifications, notificationSettings, tx) {
  // Loop through notifications to get the userIds and the formatted notification
  const userIds = new Set()
  const formattedNotifications = []

  for (let notif of notifications) {
    // blocknumber parsed for all notification types
    let blocknumber = notif.blocknumber

    // Handle the 'follow' notification type
    if (notif.type === notificationTypes.Follow) {
      let notificationTarget = notif.metadata.followee_user_id
      const shouldNotify = shouldNotifyUser(notificationTarget, 'followers', notificationSettings)
      if (shouldNotify.mobile || shouldNotify.browser) {
        const formattedFollow = {
          ...notif,
          actions: [{
            actionEntityType: actionEntityTypes.User,
            actionEntityId: notif.metadata.follower_user_id,
            blocknumber
          }]
        }
        formattedNotifications.push(formattedFollow)
        userIds.add(notificationTarget)
      }
    }

    // Handle the 'repost' notification type
    // track/album/playlist
    if (notif.type === notificationTypes.Repost.base) {
      let notificationTarget = notif.metadata.entity_owner_id
      const shouldNotify = shouldNotifyUser(notificationTarget, 'reposts', notificationSettings)
      if (shouldNotify.mobile || shouldNotify.browser) {
        const formattedRepost = {
          ...notif,
          actions: [{
            actionEntityType: actionEntityTypes.User,
            actionEntityId: notif.initiator,
            blocknumber
          }],
          entityId: notif.metadata.entity_id,
          // we're going to overwrite this property so fetchNotificationMetadata can use it
          type: getRepostType(notif.metadata.entity_type)
        }
        formattedNotifications.push(formattedRepost)
        userIds.add(notificationTarget)
      }
    }

    // Handle the 'favorite' notification type, track/album/playlist
    if (notif.type === notificationTypes.Favorite.base) {
      let notificationTarget = notif.metadata.entity_owner_id
      const shouldNotify = shouldNotifyUser(notificationTarget, 'favorites', notificationSettings)
      if (shouldNotify.mobile || shouldNotify.browser) {
        const formattedFavorite = {
          ...notif,
          actions: [{
            actionEntityType: actionEntityTypes.User,
            actionEntityId: notif.initiator,
            blocknumber
          }],
          entityId: notif.metadata.entity_id,
          // we're going to overwrite this property so fetchNotificationMetadata can use it
          type: getFavoriteType(notif.metadata.entity_type)
        }
        formattedNotifications.push(formattedFavorite)
        userIds.add(notificationTarget)
      }
    }

    // Handle the 'remix create' notification type
    if (notif.type === notificationTypes.RemixCreate) {
      let notificationTarget = notif.metadata.remix_parent_track_user_id
      const shouldNotify = shouldNotifyUser(notificationTarget, 'remixes', notificationSettings)
      if (shouldNotify.mobile || shouldNotify.browser) {
        const formattedRemixCreate = {
          ...notif,
          actions: [{
            actionEntityType: actionEntityTypes.User,
            actionEntityId: notif.metadata.remix_parent_track_user_id,
            blocknumber
          }, {
            actionEntityType: actionEntityTypes.Track,
            actionEntityId: notif.metadata.entity_id,
            blocknumber
          }, {
            actionEntityType: actionEntityTypes.Track,
            actionEntityId: notif.metadata.remix_parent_track_id,
            blocknumber
          }],
          entityId: notif.metadata.entity_id,
          type: notificationTypes.RemixCreate
        }
        formattedNotifications.push(formattedRemixCreate)
        userIds.add(notificationTarget)
      }
    }

    // Handle the remix cosign notification type
    if (notif.type === notificationTypes.RemixCosign) {
      const formattedRemixCosign = {
        ...notif,
        entityId: notif.metadata.entity_id,
        actions: [{
          actionEntityType: actionEntityTypes.User,
          actionEntityId: notif.initiator,
          blocknumber
        }, {
          actionEntityType: actionEntityTypes.Track,
          actionEntityId: notif.metadata.entity_id,
          blocknumber
        }],
        type: notificationTypes.RemixCosign
      }
      formattedNotifications.push(formattedRemixCosign)
      userIds.add(formattedRemixCosign.initiator)
    }

    // Handle 'challenge reward' notification type
    if (notif.type === notificationTypes.ChallengeReward) {
      const formattedRewardNotification = {
        ...notif,
        challengeId: notif.metadata.challenge_id,
        actions: [{
          actionEntityType: notif.metadata.challenge_id,
          actionEntityId: notif.initiator,
          slot: notif.slot
        }],
        type: notificationTypes.ChallengeReward
      }
      formattedNotifications.push(formattedRewardNotification)
      userIds.add(formattedRewardNotification.initiator)
    }

    // Handle 'listen milestone' notification type
    if (notif.type === notificationTypes.MilestoneListen) {
      let notificationTarget = notif.initiator
      const shouldNotify = shouldNotifyUser(notificationTarget, 'milestonesAndAchievements', notificationSettings)
      if (shouldNotify.mobile || shouldNotify.browser) {
        const formattedListenMilstoneNotification = {
          ...notif,
          entityId: notif.metadata.entity_id,
          type: notificationTypes.MilestoneListen,
          actions: [{
            actionEntityType: actionEntityTypes.Track,
            actionEntityId: notif.metadata.threshold
          }]
        }
        formattedNotifications.push(formattedListenMilstoneNotification)
        userIds.add(formattedListenMilstoneNotification.initiator)
      }
    }

    // Handle 'tier change' notification type
    if (notif.type === notificationTypes.TierChange) {
      const formattedTierChangeNotification = {
        ...notif,
        tier: notif.metadata.tier,
        actions: [{
          actionEntityType: actionEntityTypes.User,
          actionEntityId: notif.initiator,
          blocknumber
        }],
        type: notificationTypes.TierChange
      }
      formattedNotifications.push(formattedTierChangeNotification)
      userIds.add(formattedTierChangeNotification.initiator)
    }

    // Handle the 'create' notification type, track/album/playlist
    if (notif.type === notificationTypes.Create.base) {
      await _processCreateNotifications(notif, tx)
    }

    // Handle the 'track added to playlist' notification type
    if (notif.type === notificationTypes.TrackAddedToPlaylist) {
      let notificationTarget = notif.metadata.track_owner_id
      const shouldNotify = shouldNotifyUser(notificationTarget, 'trackAddedToPlaylist', notificationSettings)

      if (shouldNotify.mobile || shouldNotify.browser) {
        const formattedTrackAddedToPlaylistNotification = {
          ...notif,
          actions: [{
            blocknumber
          }],
          trackId: notif.metadata.track_id
        }
        formattedNotifications.push(formattedTrackAddedToPlaylistNotification)
        userIds.add(notificationTarget)
      }
    }
  }
  const [formattedCreateNotifications, users] = await _processSubscriberPushNotifications()
  formattedNotifications.push(...formattedCreateNotifications)
  users.forEach(userIds.add, userIds)
  return { notifications: formattedNotifications, users: [...users] }
}

async function _processSubscriberPushNotifications () {
  const filteredFormattedCreateNotifications = []
  const users = []
  let currentTime = Date.now()
  for (var i = 0; i < subscriberPushNotifications.length; i++) {
    let entry = subscriberPushNotifications[i]
    let timeSince = currentTime - entry.time
    if (timeSince > notificationUtils.getPendingCreateDedupeMs()) {
      filteredFormattedCreateNotifications.push(entry)
      users.push(entry.initiator)
      entry.pending = false
    }
  }

  subscriberPushNotifications = subscriberPushNotifications.filter(x => x.pending)
  return [filteredFormattedCreateNotifications, users]
}

async function _processCreateNotifications (notif, tx) {
  let blocknumber = notif.blocknumber
  let createType = null
  let actionEntityType = null
  switch (notif.metadata.entity_type) {
    case 'track':
      createType = notificationTypes.Create.track
      actionEntityType = actionEntityTypes.Track
      break
    case 'album':
      createType = notificationTypes.Create.album
      actionEntityType = actionEntityTypes.User
      break
    case 'playlist':
      createType = notificationTypes.Create.playlist
      actionEntityType = actionEntityTypes.User
      break
    default:
      throw new Error('Invalid create type')
  }

  // Query user IDs from subscriptions table
  // Notifications go to all users subscribing to this track uploader
  let subscribers = await models.Subscription.findAll({
    where: {
      userId: notif.initiator
    },
    transaction: tx
  })

  // No operation if no users subscribe to this creator
  if (subscribers.length === 0) { return [] }

  // The notification entity id is the uploader id for tracks
  // Each track will added to the notification actions table
  // For playlist/albums, the notification entity id is the collection id itself
  let notificationEntityId =
    actionEntityType === actionEntityTypes.Track
      ? notif.initiator
      : notif.metadata.entity_id

  // Action table entity is trackId for CreateTrack notifications
  // Allowing multiple track creates to be associated w/ a single notif for your subscription
  // For collections, the entity is the owner id, producing a distinct notif for each
  let createdActionEntityId =
    actionEntityType === actionEntityTypes.Track
      ? notif.metadata.entity_id
      : notif.metadata.entity_owner_id

  // Create notification for each subscriber
  const formattedNotifications = subscribers.map((s) => {
    // send push notification to each subscriber
    return {
      ...notif,
      actions: [{
        actionEntityType: actionEntityType,
        actionEntityId: createdActionEntityId,
        blocknumber
      }],
      entityId: notificationEntityId,
      time: Date.now(),
      pending: true,
      // Add notification for this user indicating the uploader has added a track
      subscriberId: s.subscriberId,
      // we're going to overwrite this property so fetchNotificationMetadata can use it
      type: createType
    }
  })
  subscriberPushNotifications.push(...formattedNotifications)

  // Dedupe album /playlist notification
  if (createType === notificationTypes.Create.album ||
      createType === notificationTypes.Create.playlist) {
    let trackIdObjectList = notif.metadata.collection_content.track_ids
    let trackIdsArray = trackIdObjectList.map(x => x.track)

    if (trackIdObjectList.length > 0) {
      // Clear duplicate push notifications in local queue
      let dupeFound = false
      for (let i = 0; i < subscriberPushNotifications.length; i++) {
        let pushNotif = subscriberPushNotifications[i]
        let type = pushNotif.type
        if (type === notificationTypes.Create.track) {
          let pushActionEntityId = pushNotif.metadata.entity_id
          // Check if this pending notification includes a duplicate track
          if (trackIdsArray.includes(pushActionEntityId)) {
            logger.debug(`Found dupe push notif ${type}, trackId: ${pushActionEntityId}`)
            dupeFound = true
            subscriberPushNotifications[i].pending = false
          }
        }
      }

      if (dupeFound) {
        subscriberPushNotifications = subscriberPushNotifications.filter(x => x.pending)
      }
    }
  }
}

module.exports = formatNotifications
