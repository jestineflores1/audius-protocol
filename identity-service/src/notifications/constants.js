const notificationTypes = Object.freeze({
  Follow: 'Follow',
  Repost: {
    base: 'Repost',
    track: 'RepostTrack',
    album: 'RepostAlbum',
    playlist: 'RepostPlaylist'
  },
  Favorite: {
    base: 'Favorite',
    track: 'FavoriteTrack',
    album: 'FavoriteAlbum',
    playlist: 'FavoritePlaylist'
  },
  Create: {
    base: 'Create',
    track: 'CreateTrack',
    album: 'CreateAlbum',
    playlist: 'CreatePlaylist'
  },
  RemixCreate: 'RemixCreate',
  RemixCosign: 'RemixCosign',
  Milestone: 'Milestone',
  MilestoneFollow: 'MilestoneFollow',
  MilestoneRepost: 'MilestoneRepost',
  MilestoneFavorite: 'MilestoneFavorite',
  MilestoneListen: 'MilestoneListen',
  Announcement: 'Announcement',
  TrendingTrack: 'TrendingTrack',
  ChallengeReward: 'ChallengeReward',
  PlaylistUpdate: 'PlaylistUpdate',
  Tip: 'Tip',
  TipReceive: 'TipReceive',
  TipSend: 'TipSend',
  Reaction: 'Reaction',
  SupporterRankUp: 'SupporterRankUp',
  SupportingRankUp: 'SupportingRankUp'
})

const actionEntityTypes = Object.freeze({
  User: 'User',
  Track: 'Track',
  Album: 'Album',
  Playlist: 'Playlist'
})

const dayInHours = 24
const weekInHours = 168
const notificationJobType = 'notificationProcessJob'
const solanaNotificationJobType = 'solanaNotificationProcessJob'
const announcementJobType = 'pushAnnouncementsJob'
const unreadEmailJobType = 'unreadEmailJob'
const downloadEmailJobType = 'downloadEmailJobType'

const deviceType = Object.freeze({
  Mobile: 'mobile',
  Browser: 'browser'
})

module.exports = {
  notificationTypes,
  actionEntityTypes,
  dayInHours,
  weekInHours,
  notificationJobType,
  solanaNotificationJobType,
  announcementJobType,
  unreadEmailJobType,
  downloadEmailJobType,
  deviceType
}
