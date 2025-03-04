const _ = require('lodash')
const axios = require('axios')
const { CancelToken } = axios

const config = require('../../../config')
const Utils = require('../../../utils')
const { isPrimaryHealthy } = require('../CNodeHealthManager')
const { logger } = require('../../../logging')
const SecondarySyncHealthTracker = require('../../../snapbackSM/secondarySyncHealthTracker')
const {
  AGGREGATE_RECONFIG_AND_POTENTIAL_SYNC_OPS_BATCH_SIZE,
  GET_NODE_USERS_TIMEOUT_MS,
  GET_NODE_USERS_CANCEL_TOKEN_MS,
  GET_NODE_USERS_DEFAULT_PAGE_SIZE
} = require('../stateMachineConstants')

const MIN_FAILED_SYNC_REQUESTS_BEFORE_RECONFIG = config.get(
  'minimumFailedSyncRequestsBeforeReconfig'
)
const MIN_SECONDARY_USER_SYNC_SUCCESS_PERCENT =
  config.get('minimumSecondaryUserSyncSuccessPercent') / 100

/**
 * @param discoveryNodeEndpoint the endpoint of the Discovery Node to request the latest user ID from
 * @returns the ID of the newest user on Audius
 */
const getLatestUserIdFromDiscovery = async (discoveryNodeEndpoint) => {
  // Will throw error on non-200 response
  let latestUserId = 0
  try {
    // Request all users that have this node as a replica (either primary or secondary)
    const resp = await Utils.asyncRetry({
      logLabel: 'fetch the ID of the newest user on Audius',
      asyncFn: async () => {
        return axios({
          method: 'get',
          baseURL: discoveryNodeEndpoint,
          url: `latest/user`,
          timeout: 10_000 // 10s
        })
      },
      logger
    })
    latestUserId = resp.data.data
  } catch (e) {
    throw new Error(
      `getLatestUserIdFromDiscovery() Error: ${e.toString()} - connected discovery node: [${discoveryNodeEndpoint}]`
    )
  }

  return latestUserId
}

/**
 * Retrieve users with this node as replica (primary or secondary).
 * Makes single request to discovery node to retrieve all users, optionally paginated
 *
 * @notice Discovery Nodes will ignore these params if they're not updated to the version which added pagination
 * @param {string} discoveryNodeEndpoint the IP address / URL of a Discovery Node to make requests to
 * @param {string} contentNodeEndpoint the IP address / URL of the Content Node to fetch users from (users must have this CN as their primary or secondary)
 * @param prevUserId user_id is used for pagination, where each paginated request returns
 *                   maxUsers number of users starting at a user with id=user_id
 * @param maxUsers the maximum number of users to fetch
 * @returns {Object[]} array of objects of shape { primary, secondary1, secondary2, user_id, wallet, primarySpID, secondary1SpID, secondary2SpID }
 */
const getNodeUsers = async (
  discoveryNodeEndpoint,
  contentNodeEndpoint,
  prevUserId = 0,
  maxUsers = GET_NODE_USERS_DEFAULT_PAGE_SIZE
) => {
  // Will throw error on non-200 response
  let nodeUsers
  try {
    // Cancel the request if it hasn't succeeded/failed/timed out after 70 seconds
    const cancelTokenSource = CancelToken.source()
    setTimeout(
      () =>
        cancelTokenSource.cancel(
          `getNodeUsers() took more than ${GET_NODE_USERS_CANCEL_TOKEN_MS}ms and did not time out`
        ),
      GET_NODE_USERS_CANCEL_TOKEN_MS
    )

    // Request all users that have this node as a replica (either primary or secondary)
    const resp = await Utils.asyncRetry({
      logLabel: 'fetch all users with this node in replica',
      asyncFn: async () => {
        return axios({
          method: 'get',
          baseURL: discoveryNodeEndpoint,
          url: `v1/full/users/content_node/all`,
          params: {
            creator_node_endpoint: contentNodeEndpoint,
            prev_user_id: prevUserId,
            max_users: maxUsers
          },
          timeout: GET_NODE_USERS_TIMEOUT_MS,
          cancelToken: cancelTokenSource.token
        })
      },
      logger
    })
    nodeUsers = resp.data.data
  } catch (e) {
    if (axios.isCancel(e)) {
      logger.error(`getNodeUsers() request canceled: ${e.message}`)
    }
    throw new Error(
      `getNodeUsers() Error: ${e.toString()} - connected discovery node [${discoveryNodeEndpoint}]`
    )
  } finally {
    logger.info(`getNodeUsers() nodeUsers.length: ${nodeUsers?.length}`)
  }

  // Ensure every object in response array contains all required fields
  for (const nodeUser of nodeUsers) {
    const requiredFields = [
      'user_id',
      'wallet',
      'primary',
      'secondary1',
      'secondary2',
      'primarySpID',
      'secondary1SpID',
      'secondary2SpID'
    ]
    const responseFields = Object.keys(nodeUser)
    const allRequiredFieldsPresent = requiredFields.every((requiredField) =>
      responseFields.includes(requiredField)
    )
    if (!allRequiredFieldsPresent) {
      throw new Error(
        'getNodeUsers() Error: Unexpected response format during getNodeUsers() call'
      )
    }
  }

  return nodeUsers
}

/**
 * Converts provided array of nodeUser info to issue to a map(replica set node => userWallets[]) for easier access
 *
 * @param {Array} nodeUsers array of objects with schema { user_id, wallet, primary, secondary1, secondary2 }
 * @returns {Object} map of replica set endpoint strings to array of wallet strings of users with that node as part of replica set
 */
const buildReplicaSetNodesToUserWalletsMap = (nodeUsers) => {
  const replicaSetNodesToUserWalletsMap = {}

  nodeUsers.forEach((userInfo) => {
    const { wallet, primary, secondary1, secondary2 } = userInfo
    const replicaSet = [primary, secondary1, secondary2]

    replicaSet.forEach((node) => {
      if (!replicaSetNodesToUserWalletsMap[node]) {
        replicaSetNodesToUserWalletsMap[node] = []
      }

      replicaSetNodesToUserWalletsMap[node].push(wallet)
    })
  })

  return replicaSetNodesToUserWalletsMap
}

const computeUserSecondarySyncSuccessRatesMap = async (nodeUsers) => {
  // Map each nodeUser to truthy secondaries (ignore empty secondaries that result from incomplete replica sets)
  const walletsToSecondariesMapping = {}
  for (const nodeUser of nodeUsers) {
    const { wallet, secondary1, secondary2 } = nodeUser
    const secondaries = [secondary1, secondary2].filter(Boolean)
    walletsToSecondariesMapping[wallet] = secondaries
  }

  const userSecondarySyncMetricsMap =
    await SecondarySyncHealthTracker.computeUsersSecondarySyncSuccessRatesForToday(
      walletsToSecondariesMapping
    )

  return userSecondarySyncMetricsMap
}

/**
 * For every node user, record sync requests to issue to secondaries if this node is primary
 * and record replica set updates to issue for any unhealthy replicas
 *
 * @param {Object} nodeUser { primary, secondary1, secondary2, primarySpID, secondary1SpID, secondary2SpID, user_id, wallet }
 * @param {Set<string>} unhealthyPeers set of unhealthy peers
 * @param {string (wallet): Object{ string (secondary endpoint): Object{ successRate: number (0-1), successCount: number, failureCount: number }}} userSecondarySyncMetricsMap mapping of nodeUser's wallet (string) to metrics for their sync success to secondaries
 * @param {Object} endpointToSPIdMap
 * @returns
 * {
 *  requiredUpdateReplicaSetOps: {Object[]} array of {...nodeUsers, unhealthyReplicas: {string[]} endpoints of unhealthy rset nodes }
 *  potentialSyncRequests: {Object[]} array of {...nodeUsers, endpoint: {string} endpoint to sync to }
 * }
 * @notice this will issue sync to healthy secondary and update replica set away from unhealthy secondary
 */
const aggregateReconfigAndPotentialSyncOps = async (
  nodeUsers,
  unhealthyPeers,
  userSecondarySyncMetricsMap,
  endpointToSPIdMap,
  thisContentNodeEndpoint
) => {
  // Parallelize calling _aggregateOps on chunks of 500 nodeUsers at a time
  const nodeUserBatches = _.chunk(
    nodeUsers,
    AGGREGATE_RECONFIG_AND_POTENTIAL_SYNC_OPS_BATCH_SIZE
  )
  const results = []
  for (const nodeUserBatch of nodeUserBatches) {
    const resultBatch = await Promise.allSettled(
      nodeUserBatch.map((nodeUser) =>
        _aggregateOps(
          nodeUser,
          unhealthyPeers,
          userSecondarySyncMetricsMap[nodeUser.wallet],
          endpointToSPIdMap,
          thisContentNodeEndpoint
        )
      )
    )
    results.push(...resultBatch)
  }

  // Combine each batch's requiredUpdateReplicaSetOps and potentialSyncRequests
  let requiredUpdateReplicaSetOps = []
  let potentialSyncRequests = []
  for (const promiseResult of results) {
    // Skip and log failed promises
    const {
      status: promiseStatus,
      value: reconfigAndSyncOps,
      reason: promiseError
    } = promiseResult
    if (promiseStatus !== 'fulfilled') {
      logger.error(
        `aggregateReconfigAndPotentialSyncOps encountered unexpected failure: ${
          promiseError.message || promiseError
        }`
      )
      continue
    }

    // Combine each promise's requiredUpdateReplicaSetOps and potentialSyncRequests
    const {
      requiredUpdateReplicaSetOps: requiredUpdateReplicaSetOpsFromPromise,
      potentialSyncRequests: potentialSyncRequestsFromPromise
    } = reconfigAndSyncOps
    requiredUpdateReplicaSetOps = requiredUpdateReplicaSetOps.concat(
      requiredUpdateReplicaSetOpsFromPromise
    )
    potentialSyncRequests = potentialSyncRequests.concat(
      potentialSyncRequestsFromPromise
    )
  }

  return { requiredUpdateReplicaSetOps, potentialSyncRequests }
}

/**
 * Used to determine the `requiredUpdateReplicaSetOps` and `potentialSyncRequests` for a given nodeUser.
 * @param {Object} nodeUser { primary, secondary1, secondary2, primarySpID, secondary1SpID, secondary2SpID, user_id, wallet}
 * @param {Set<string>} unhealthyPeers set of unhealthy peers
 * @param {string (secondary endpoint): Object{ successRate: number (0-1), successCount: number, failureCount: number }} userSecondarySyncMetrics mapping of each secondary to the success metrics the nodeUser has had syncing to it
 * @param {Object} endpointToSPIdMap
 */
const _aggregateOps = async (
  nodeUser,
  unhealthyPeers,
  userSecondarySyncMetrics,
  endpointToSPIdMap,
  thisContentNodeEndpoint
) => {
  const requiredUpdateReplicaSetOps = []
  const potentialSyncRequests = []
  const unhealthyReplicas = new Set()

  const {
    wallet,
    primary,
    secondary1,
    secondary2,
    primarySpID,
    secondary1SpID,
    secondary2SpID
  } = nodeUser

  /**
   * If this node is primary for user, check both secondaries for health
   * Enqueue SyncRequests against healthy secondaries, and enqueue UpdateReplicaSetOps against unhealthy secondaries
   */
  let replicaSetNodesToObserve = [
    { endpoint: secondary1, spId: secondary1SpID },
    { endpoint: secondary2, spId: secondary2SpID }
  ]

  if (primary === thisContentNodeEndpoint) {
    // filter out false-y values to account for incomplete replica sets
    const secondariesInfo = replicaSetNodesToObserve.filter(
      (entry) => entry.endpoint
    )

    /**
     * For each secondary, enqueue `potentialSyncRequest` if healthy else add to `unhealthyReplicas`
     */
    for (const secondaryInfo of secondariesInfo) {
      const secondary = secondaryInfo.endpoint

      const { successRate, successCount, failureCount } =
        userSecondarySyncMetrics[secondary]

      // Error case 1 - mismatched spID
      if (endpointToSPIdMap[secondary] !== secondaryInfo.spId) {
        logger.error(
          `processStateMachineOperation Secondary ${secondary} for user ${wallet} mismatched spID. Expected ${secondaryInfo.spId}, found ${endpointToSPIdMap[secondary]}. Marking replica as unhealthy.`
        )
        unhealthyReplicas.add(secondary)

        // Error case 2 - already marked unhealthy
      } else if (unhealthyPeers.has(secondary)) {
        logger.error(
          `processStateMachineOperation Secondary ${secondary} for user ${wallet} in unhealthy peer set. Marking replica as unhealthy.`
        )
        unhealthyReplicas.add(secondary)

        // Error case 3 - low user sync success rate
      } else if (
        failureCount >= MIN_FAILED_SYNC_REQUESTS_BEFORE_RECONFIG &&
        successRate < MIN_SECONDARY_USER_SYNC_SUCCESS_PERCENT
      ) {
        logger.error(
          `processStateMachineOperation Secondary ${secondary} for user ${wallet} has userSyncSuccessRate of ${successRate}, which is below threshold of ${MIN_SECONDARY_USER_SYNC_SUCCESS_PERCENT}. ${successCount} Successful syncs vs ${failureCount} Failed syncs. Marking replica as unhealthy.`
        )
        unhealthyReplicas.add(secondary)

        // Success case
      } else {
        potentialSyncRequests.push({ ...nodeUser, endpoint: secondary })
      }
    }

    /**
     * If any unhealthy replicas found for user, enqueue an updateReplicaSetOp for later processing
     */
    if (unhealthyReplicas.size > 0) {
      requiredUpdateReplicaSetOps.push({ ...nodeUser, unhealthyReplicas })
    }

    /**
     * If this node is secondary for user, check both secondaries for health and enqueue SyncRequests against healthy secondaries
     * Ignore unhealthy secondaries for now
     */
  } else {
    // filter out false-y values to account for incomplete replica sets and filter out the
    // the self node
    replicaSetNodesToObserve = [
      { endpoint: primary, spId: primarySpID },
      ...replicaSetNodesToObserve
    ]
    replicaSetNodesToObserve = replicaSetNodesToObserve.filter((entry) => {
      return entry.endpoint && entry.endpoint !== thisContentNodeEndpoint
    })

    for (const replica of replicaSetNodesToObserve) {
      // If the map's spId does not match the query's spId, then regardless
      // of the relationship of the node to the user, issue a reconfig for that node
      if (endpointToSPIdMap[replica.endpoint] !== replica.spId) {
        unhealthyReplicas.add(replica.endpoint)
      } else if (unhealthyPeers.has(replica.endpoint)) {
        // Else, continue with conducting extra health check if the current observed node is a primary, and
        // add to `unhealthyReplicas` if observed node is a secondary
        let addToUnhealthyReplicas = true

        if (replica.endpoint === primary) {
          addToUnhealthyReplicas = !(await isPrimaryHealthy(primary))
        }

        if (addToUnhealthyReplicas) {
          unhealthyReplicas.add(replica.endpoint)
        }
      }
    }

    if (unhealthyReplicas.size > 0) {
      requiredUpdateReplicaSetOps.push({ ...nodeUser, unhealthyReplicas })
    }
  }

  return { requiredUpdateReplicaSetOps, potentialSyncRequests }
}

module.exports = {
  getLatestUserIdFromDiscovery,
  getNodeUsers,
  buildReplicaSetNodesToUserWalletsMap,
  computeUserSecondarySyncSuccessRatesMap,
  aggregateReconfigAndPotentialSyncOps
}
