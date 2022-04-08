const Bull = require('bull')
const axios = require('axios')
const _ = require('lodash')
const retry = require('async-retry')

const utils = require('../utils')
const models = require('../models')
const { logger } = require('../logging')
const redis = require('../redis.js')

const SyncDeDuplicator = require('./snapbackDeDuplicator')
const PeerSetManager = require('./peerSetManager')
const { CreatorNode } = require('@audius/libs')
const SecondarySyncHealthTracker = require('./secondarySyncHealthTracker')
const { generateTimestampAndSignature } = require('../apiSigning')

// Retry delay between requests during monitoring
const SyncMonitoringRetryDelayMs = 15000

// Max number of attempts to select new replica set in reconfig
const MAX_SELECT_NEW_REPLICA_SET_ATTEMPTS = 100

// Timeout for fetching batch clock values
const BATCH_CLOCK_STATUS_REQUEST_TIMEOUT = 10000 // 10s

// Timeout for fetching a clock value for a singular user
const CLOCK_STATUS_REQUEST_TIMEOUT_MS = 2000 // 2s

const MAX_BATCH_CLOCK_STATUS_BATCH_SIZE = 5000

const MAX_USER_BATCH_CLOCK_FETCH_RETRIES = 5

// Describes the type of sync operation
const SyncType = Object.freeze({
  Recurring:
    'RECURRING' /** scheduled background sync to keep secondaries up to date */,
  Manual: 'MANUAL' /** triggered by a user data write to primary */
})

// Phases in `issueUpdateReplicaSetOp`. Used for debugging if method fails
const issueUpdateReplicaSetOpPhases = Object.freeze({
  DETERMINE_NEW_REPLICA_SET: 'DETERMINE_NEW_REPLICA_SET',
  ENQUEUE_SYNCS: 'ENQUEUE_SYNCS',
  UPDATE_URSM_REPLICA_SET: 'UPDATE_URSM_REPLICA_SET'
})

// Modes used in issuing a reconfig. Each successive mode is a superset of the mode prior.
// The `key` of the reconfig states is used to identify the current reconfig mode.
// The `value` of the reconfig states is used in the superset logic of determining which type of
// reconfig is enabled.
const RECONFIG_MODES = Object.freeze({
  // Reconfiguration is entirely disabled
  RECONFIG_DISABLED: {
    key: 'RECONFIG_DISABLED',
    value: 0
  },
  // Reconfiguration is enabled only if one secondary is unhealthy
  ONE_SECONDARY: {
    key: 'ONE_SECONDARY',
    value: 1
  },
  // Reconfiguration is enabled for one secondary and multiple secondaries (currently two secondaries)
  MULTIPLE_SECONDARIES: {
    key: 'MULTIPLE_SECONDARIES',
    value: 2
  },
  // Reconfiguration is enabled for one secondary, multiple secondaries, a primary, and a primary and one secondary
  PRIMARY_AND_OR_SECONDARIES: {
    key: 'PRIMARY_AND_OR_SECONDARIES',
    value: 3
  },
  // Reconfiguration is enabled for one secondary, multiple secondaries, a primary, and a primary and one secondary,
  // and entire replica set
  // Note: this mode will probably be disabled.
  ENTIRE_REPLICA_SET: {
    key: 'ENTIRE_REPLICA_SET',
    value: 4
  }
})

const RECONFIG_MODE_KEYS = Object.keys(RECONFIG_MODES)

const STATE_MACHINE_QUEUE_INIT_DELAY_MS = 30000 // 30s

/*
  SnapbackSM aka Snapback StateMachine
  Ensures file availability through recurring sync operations
*/
class SnapbackSM {
  constructor(nodeConfig, audiusLibs) {
    this.nodeConfig = nodeConfig
    this.audiusLibs = audiusLibs

    // Toggle to switch logs
    this.debug = true

    this.endpoint = this.nodeConfig.get('creatorNodeEndpoint')
    this.spID = this.nodeConfig.get('spID')
    this.delegatePrivateKey = this.nodeConfig.get('delegatePrivateKey')
    this.manualSyncsDisabled = this.nodeConfig.get('manualSyncsDisabled')

    this.MaxManualRequestSyncJobConcurrency = this.nodeConfig.get(
      'maxManualRequestSyncJobConcurrency'
    )
    this.MaxRecurringRequestSyncJobConcurrency = this.nodeConfig.get(
      'maxRecurringRequestSyncJobConcurrency'
    )

    this.MinimumSecondaryUserSyncSuccessPercent =
      this.nodeConfig.get('minimumSecondaryUserSyncSuccessPercent') / 100
    this.MinimumFailedSyncRequestsBeforeReconfig = this.nodeConfig.get(
      'minimumFailedSyncRequestsBeforeReconfig'
    )

    this.SecondaryUserSyncDailyFailureCountThreshold = this.nodeConfig.get(
      'secondaryUserSyncDailyFailureCountThreshold'
    )

    this.MaxSyncMonitoringDurationInMs = this.nodeConfig.get(
      'maxSyncMonitoringDurationInMs'
    )

    // Throw an error if no libs are provided
    if (
      !this.audiusLibs ||
      !this.spID ||
      !this.endpoint ||
      !this.delegatePrivateKey
    ) {
      throw new Error('SnapbackSM: Missing required configs - cannot start')
    }

    // 1/<moduloBase> users are handled over <snapbackJobInterval> ms interval
    // ex: 1/<24> users are handled over <3600000> ms (1 hour)
    this.moduloBase = this.nodeConfig.get('snapbackModuloBase')

    // Incremented as users are processed
    this.currentModuloSlice = this.randomStartingSlice()

    // The interval when SnapbackSM is fired for state machine jobs
    this.snapbackJobInterval = this.nodeConfig.get('snapbackJobInterval') // ms

    // State machine queue processes all user operations
    // Settings config from https://github.com/OptimalBits/bull/blob/develop/REFERENCE.md#advanced-settings
    this.stateMachineQueue = this.createBullQueue('state-machine', {
      // Should be sufficiently larger than expected job runtime
      lockDuration: this.snapbackJobInterval * 2,
      // we never want to re-process stalled job
      maxStalledCount: 0
    })

    // Sync queues handle issuing sync request from primary -> secondary
    this.manualSyncQueue = this.createBullQueue('manual-sync-queue')
    this.recurringSyncQueue = this.createBullQueue('recurring-sync-queue')

    // Add stalled event handlers for all queues
    this.stateMachineQueue.on('global:stalled', (job) => {
      this.logError(`stateMachineQueue Job Stalled - ID ${job.id}}`)
    })
    this.manualSyncQueue.on('global:stalled', (job) => {
      this.logError(`manualSyncQueue Job Stalled - ID ${job.id}}`)
    })
    this.recurringSyncQueue.on('global:stalled', (job) => {
      this.logError(`recurringSyncQueue Job Stalled - ID ${job.id}}`)
    })

    // PeerSetManager instance to determine the peer set and its health state
    this.peerSetManager = new PeerSetManager({
      discoveryProviderEndpoint:
        audiusLibs.discoveryProvider.discoveryProviderEndpoint,
      creatorNodeEndpoint: this.endpoint
    })

    this.updateEnabledReconfigModesSet()
  }

  /**
   * Initialize StateMachine processing:
   * - StateMachineQueue -> determines all system state changes required
   * - SyncQueue -> triggers syncs on secondaries
   */
  async init() {
    // Empty all queues to minimize memory consumption
    await this.stateMachineQueue.empty()
    await this.manualSyncQueue.empty()
    await this.recurringSyncQueue.empty()

    // SyncDeDuplicator ensure a sync for a (syncType, userWallet, secondaryEndpoint) tuple is only enqueued once
    this.syncDeDuplicator = new SyncDeDuplicator()

    /**
     * Initialize all queue processors
     */

    // Initialize stateMachineQueue job processor
    this.stateMachineQueue.process(1 /** concurrency */, async (job) => {
      const jobId = job.id
      await redis.set('stateMachineQueueLatestJobStart', Date.now())
      try {
        await this.processStateMachineOperation()
        await redis.set('stateMachineQueueLatestJobSuccess', Date.now())
      } catch (e) {
        this.logError(`StateMachineQueue processing error jobId ${jobId}: ${e}`)
      }
    })

    // Initialize manualSyncQueue job processor
    this.manualSyncQueue.process(
      this.MaxManualRequestSyncJobConcurrency,
      async (job) => {
        try {
          await this.processSyncOperation(job, SyncType.Manual)
        } catch (e) {
          this.logError(`ManualSyncQueue processing error: ${e}`)
        }
      }
    )

    // Initialize recurringSyncQueue job processor
    this.recurringSyncQueue.process(
      this.MaxRecurringRequestSyncJobConcurrency,
      async (job) => {
        try {
          await this.processSyncOperation(job, SyncType.Recurring)
        } catch (e) {
          this.logError(`RecurringSyncQueue processing error ${e}`)
        }
      }
    )

    // Enqueue stateMachineQueue jobs on a cron, after an initial delay
    await this.stateMachineQueue.add(
      /** data */ { startTime: Date.now() },
      /** opts */ { delay: STATE_MACHINE_QUEUE_INIT_DELAY_MS }
    )
    await this.stateMachineQueue.add(
      /** data */ { startTime: Date.now() },
      /** opts */ {
        repeat: { every: this.snapbackJobInterval }
      }
    )

    this.log(
      `SnapbackSM initialized with manualSyncsDisabled=${this.manualSyncsDisabled}. Added initial stateMachineQueue job; jobs will be enqueued every ${this.snapbackJobInterval}ms`
    )
  }

  logDebug(msg) {
    logger.debug(`SnapbackSM DEBUG: ${msg}`)
  }

  log(msg) {
    logger.info(`SnapbackSM: ${msg}`)
  }

  logWarn(msg) {
    logger.warn(`SnapbackSM WARNING: ${msg}`)
  }

  logError(msg) {
    logger.error(`SnapbackSM ERROR: ${msg}`)
  }

  // Initialize bull queue instance with provided name and settings
  createBullQueue(queueName, settings = {}) {
    return new Bull(queueName, {
      redis: {
        port: this.nodeConfig.get('redisPort'),
        host: this.nodeConfig.get('redisHost')
      },
      defaultJobOptions: {
        // removeOnComplete is required since the completed jobs data set will grow infinitely until memory exhaustion
        removeOnComplete: true,
        removeOnFail: true
      },
      settings
    })
  }

  // Randomly select an initial slice
  randomStartingSlice() {
    const slice = Math.floor(Math.random() * Math.floor(this.moduloBase))
    this.log(`Starting at data slice ${slice}/${this.moduloBase}`)
    return slice
  }

  // Helper function to retrieve all relevant configs
  async getSPInfo() {
    const spID = this.nodeConfig.get('spID')
    const endpoint = this.endpoint
    const delegateOwnerWallet = this.nodeConfig.get('delegateOwnerWallet')
    const delegatePrivateKey = this.nodeConfig.get('delegatePrivateKey')
    return {
      spID,
      endpoint,
      delegateOwnerWallet,
      delegatePrivateKey
    }
  }

  /**
   * Given wallets array, queries DB and returns a map of all users with
   *    those wallets and their clock values, or -1 if wallet not found
   *
   * @returns map(wallet -> clock val)
   */
  async getUserPrimaryClockValues(wallets) {
    // Query DB for all cnodeUsers with walletPublicKey in `wallets` arg array
    const cnodeUsersFromDB = await models.CNodeUser.findAll({
      where: {
        walletPublicKey: {
          [models.Sequelize.Op.in]: wallets
        }
      }
    })

    // Initialize clock values for all users to -1
    const cnodeUserClockValuesMap = {}
    wallets.forEach((wallet) => {
      cnodeUserClockValuesMap[wallet] = -1
    })

    // Populate clock values into map with DB data
    cnodeUsersFromDB.forEach((cnodeUser) => {
      cnodeUserClockValuesMap[cnodeUser.walletPublicKey] = cnodeUser.clock
    })

    return cnodeUserClockValuesMap
  }

  /**
   * Enqueues a sync request to secondary on specified syncQueue and returns job info
   *
   * @dev NOTE avoid using bull priority if possible as it significantly reduces performance
   * @dev TODO no need to accept `primaryEndpoint` as param, it always equals `this.endpoint`
   */
  async enqueueSync({
    userWallet,
    primaryEndpoint,
    secondaryEndpoint,
    syncType,
    immediate = false
  }) {
    const queue =
      syncType === SyncType.Manual
        ? this.manualSyncQueue
        : this.recurringSyncQueue

    // If duplicate sync already exists, do not add and instead return existing sync job info
    const duplicateSyncJobInfo = this.syncDeDuplicator.getDuplicateSyncJobInfo(
      syncType,
      userWallet,
      secondaryEndpoint
    )
    if (duplicateSyncJobInfo) {
      this.log(
        `enqueueSync Failure - a sync of type ${syncType} is already waiting for user wallet ${userWallet} against secondary ${secondaryEndpoint}`
      )

      return duplicateSyncJobInfo
    }

    // Define axios params for sync request to secondary
    const syncRequestParameters = {
      baseURL: secondaryEndpoint,
      url: '/sync',
      method: 'post',
      data: {
        wallet: [userWallet],
        creator_node_endpoint: primaryEndpoint,
        // Note - `sync_type` param is only used for logging by nodeSync.js
        sync_type: syncType,
        // immediate = true will ensure secondary skips debounce and evaluates sync immediately
        immediate
      }
    }

    // Add job to manualSyncQueue or recurringSyncQueue based on `syncType` param
    const jobProps = {
      syncRequestParameters,
      startTime: Date.now()
    }

    const jobInfo = await queue.add(jobProps)

    // Record sync in syncDeDuplicator
    this.syncDeDuplicator.recordSync(
      syncType,
      userWallet,
      secondaryEndpoint,
      jobInfo
    )

    return jobInfo
  }

  /**
   * Depending on the size of `unhealthyReplicas`:
   * 1. Determine a new replica set
   * 2. Write new replica set to URSM
   * 3. Sync data to new replica set
   *
   * @param {number} userId user id to issue a reconfiguration for
   * @param {string} wallet wallet address of user id
   * @param {string} primary endpoint of the current primary node on replica set
   * @param {string} secondary1 endpoint of the current first secondary node on replica set
   * @param {string} secondary2 endpoint of the current second secondary node on replica set
   * @param {string[]} unhealthyReplicas array of endpoints of current replica set nodes that are unhealthy
   * @param {string[]} healthyNodes array of healthy Content Node endpoints used for selecting new replica set
   * @param {Object} replicaSetNodesToUserClockStatusesMap map of secondary endpoint strings to (map of user wallet strings to clock value of secondary for user)
   */
  async issueUpdateReplicaSetOp(
    userId,
    wallet,
    primary,
    secondary1,
    secondary2,
    unhealthyReplicas,
    healthyNodes,
    replicaSetNodesToUserClockStatusesMap
  ) {
    this.log(
      `[issueUpdateReplicaSetOp] userId=${userId} wallet=${wallet} unhealthy replica set=[${unhealthyReplicas}] numHealthyNodes=${healthyNodes.length}`
    )

    const unhealthyReplicasSet = new Set(unhealthyReplicas)
    const response = { errorMsg: null, issuedReconfig: false }
    let newReplicaSetEndpoints = []
    const newReplicaSetSPIds = []
    let phase = ''
    try {
      // Generate new replica set
      phase = issueUpdateReplicaSetOpPhases.DETERMINE_NEW_REPLICA_SET
      const {
        newPrimary,
        newSecondary1,
        newSecondary2,
        issueReconfig,
        reconfigType
      } = await this.determineNewReplicaSet({
        wallet,
        secondary1,
        secondary2,
        primary,
        unhealthyReplicasSet,
        healthyNodes,
        replicaSetNodesToUserClockStatusesMap
      })

      newReplicaSetEndpoints = [newPrimary, newSecondary1, newSecondary2]

      // If snapback is not enabled, Log reconfig op without issuing.
      if (!issueReconfig) {
        this.log(
          `[issueUpdateReplicaSetOp] Reconfig [DISABLED]: userId=${userId} wallet=${wallet} phase=${phase} old replica set=[${primary},${secondary1},${secondary2}] | new replica set=[${newReplicaSetEndpoints}] | reconfig type=[${reconfigType}]`
        )
        return response
      }

      // Create new array of replica set spIds and write to URSM
      phase = issueUpdateReplicaSetOpPhases.UPDATE_URSM_REPLICA_SET
      for (const endpt of newReplicaSetEndpoints) {
        // If for some reason any node in the new replica set is not registered on chain as a valid SP and is
        // selected as part of the new replica set, do not issue reconfig
        if (!this.peerSetManager.endpointToSPIdMap[endpt]) {
          this.logError(response.errorMsg)
          response.errorMsg = `[issueUpdateReplicaSetOp] userId=${userId} wallet=${wallet} phase=${phase} unable to find valid SPs from new replica set=[${newReplicaSetEndpoints}] | new replica set spIds=[${newReplicaSetSPIds}] | reconfig type=[${reconfigType}]. Skipping reconfig.`
          return response
        }
        newReplicaSetSPIds.push(this.peerSetManager.endpointToSPIdMap[endpt])
      }

      await this.audiusLibs.contracts.UserReplicaSetManagerClient.updateReplicaSet(
        userId,
        newReplicaSetSPIds[0], // primary
        newReplicaSetSPIds.slice(1) // [secondary1, secondary2]
      )

      response.issuedReconfig = true

      // Enqueue a sync for new primary to new secondaries. If there is no diff, then this is a no-op.
      // TODO: this fn performs a web request to enqueue a sync. this is not necessary for enqueuing syncs for the local node.
      // Add some logic to check if current node has a sync to be enqueued, and if so, locally add sync without a network request.
      await this.enqueueSync({
        userWallet: wallet,
        primaryEndpoint: newPrimary,
        secondaryEndpoint: newSecondary1,
        syncType: SyncType.Recurring
      })

      await this.enqueueSync({
        userWallet: wallet,
        primaryEndpoint: newPrimary,
        secondaryEndpoint: newSecondary2,
        syncType: SyncType.Recurring
      })

      this.log(
        `[issueUpdateReplicaSetOp] Reconfig [SUCCESS]: userId=${userId} wallet=${wallet} phase=${phase} old replica set=[${primary},${secondary1},${secondary2}] | new replica set=[${newReplicaSetEndpoints}] | reconfig type=[${reconfigType}]`
      )
    } catch (e) {
      const errorMsg = `[issueUpdateReplicaSetOp] Reconfig [ERROR]: userId=${userId} wallet=${wallet} phase=${phase} old replica set=[${primary},${secondary1},${secondary2}] | new replica set=[${newReplicaSetEndpoints}] | Error: ${e.toString()}\n${
        e.stack
      }`
      response.errorMsg = errorMsg
      this.logError(response.errorMsg)
      return response
    }

    return response
  }

  /**
   * Logic to determine the new replica set. Used in reconfig op.
   *
   * The logic below is as follows:
   * 1. Select the unhealthy replica set nodes size worth of healthy nodes to prepare for issuing reconfig
   * 2. Depending the number and type of unhealthy nodes in `unhealthyReplicaSet`, issue reconfig depending on if the reconfig mode is enabled:
   *  - if one secondary is unhealthy -> {primary: current primary, secondary1: the healthy secondary, secondary2: new healthy node}
   *  - if two secondaries are unhealthy -> {primary: current primary, secondary1: new healthy node, secondary2: new healthy node}
   *  - ** if one primary is unhealthy -> {primary: higher clock value of the two secondaries, secondary1: the healthy secondary, secondary2: new healthy node}
   *  - ** if one primary and one secondary are unhealthy -> {primary: the healthy secondary, secondary1: new healthy node, secondary2: new healthy node}
   *  - if entire replica set is unhealthy -> {primary: null, secondary1: null, secondary2: null, eissueReconfig: false}
   *
   * ** - If in the case a primary is ever unhealthy, we do not want to pre-emptively issue a reconfig and cycle out the primary. See
   * `peerSetManager` instance variable for more information.
   *
   * Also, there is the notion of `issueReconfig` flag. This value is used to determine whether or not to issue a reconfig based on the
   * curretly enabled reconfig mode. See `RECONFIG_MODE` variable for more information.
   *
   * @param {Object} param
   * @param {string} param.primary current user's primary endpoint
   * @param {string} param.secondary1 current user's first secondary endpoint
   * @param {string} param.secondary2 current user's second secondary endpoint
   * @param {string} param.wallet current user's wallet address
   * @param {Set<string>} param.unhealthyReplicasSet a set of endpoints of unhealthy replica set nodes
   * @param {string[]} param.healthyNodes array of healthy Content Node endpoints used for selecting new replica set
   * @param {Object} replicaSetNodesToUserClockStatusesMap map of secondary endpoint strings to (map of user wallet strings to clock value of secondary for user)
   * @returns {Object}
   * {
   *  newPrimary: {string | null} the endpoint of the newly selected primary or null,
   *  newSecondary1: {string | null} the endpoint of the newly selected secondary #1,
   *  newSecondary2: {string | null} the endpoint of the newly selected secondary #2,
   *  issueReconfig: {boolean} flag to issue reconfig or not
   * }
   */
  async determineNewReplicaSet({
    primary,
    secondary1,
    secondary2,
    wallet,
    unhealthyReplicasSet,
    healthyNodes,
    replicaSetNodesToUserClockStatusesMap
  }) {
    const response = {
      newPrimary: null,
      newSecondary1: null,
      newSecondary2: null,
      issueReconfig: false,
      reconfigType: null
    }

    const currentReplicaSet = [primary, secondary1, secondary2]
    const healthyReplicaSet = new Set(
      currentReplicaSet.filter((node) => !unhealthyReplicasSet.has(node))
    )
    const newReplicaNodes = await this.selectRandomReplicaSetNodes({
      healthyReplicaSet,
      numberOfUnhealthyReplicas: unhealthyReplicasSet.size,
      healthyNodes,
      wallet
    })

    let newPrimary
    if (unhealthyReplicasSet.size === 1) {
      if (unhealthyReplicasSet.has(primary)) {
        // If snapbackSM has already checked this primary and it failed the health check, select the higher clock
        // value of the two secondaries as the new primary, leave the other as the first secondary, and select a new second secondary
        let currentHealthySecondary
        ;[newPrimary, currentHealthySecondary] =
          replicaSetNodesToUserClockStatusesMap[secondary1][wallet] >=
          replicaSetNodesToUserClockStatusesMap[secondary2][wallet]
            ? [secondary1, secondary2]
            : [secondary2, secondary1]
        response.newPrimary = newPrimary
        response.newSecondary1 = currentHealthySecondary
        response.newSecondary2 = newReplicaNodes[0]
        response.issueReconfig = this.isReconfigEnabled(
          RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
        )
        response.reconfigType = RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
      } else {
        // If one secondary is unhealthy, select a new secondary
        const currentHealthySecondary = !unhealthyReplicasSet.has(secondary1)
          ? secondary1
          : secondary2
        response.newPrimary = primary
        response.newSecondary1 = currentHealthySecondary
        response.newSecondary2 = newReplicaNodes[0]
        response.issueReconfig = this.isReconfigEnabled(
          RECONFIG_MODES.ONE_SECONDARY.key
        )
        response.reconfigType = RECONFIG_MODES.ONE_SECONDARY.key
      }
    } else if (unhealthyReplicasSet.size === 2) {
      if (unhealthyReplicasSet.has(primary)) {
        // If primary + secondary is unhealthy, use other healthy secondary as primary and 2 random secondaries
        response.newPrimary = !unhealthyReplicasSet.has(secondary1)
          ? secondary1
          : secondary2
        response.issueReconfig = this.isReconfigEnabled(
          RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
        )
        response.reconfigType = RECONFIG_MODES.PRIMARY_AND_OR_SECONDARIES.key
      } else {
        // If both secondaries are unhealthy, keep original primary and select two random secondaries
        response.newPrimary = primary
        response.issueReconfig = this.isReconfigEnabled(
          RECONFIG_MODES.MULTIPLE_SECONDARIES.key
        )
        response.reconfigType = RECONFIG_MODES.MULTIPLE_SECONDARIES.key
      }
      response.newSecondary1 = newReplicaNodes[0]
      response.newSecondary2 = newReplicaNodes[1]
    }

    return response
  }

  /**
   * Select a random node that is not from the current replica set. Make sure the random node does not have any
   * existing user data for the current user. If there is pre-existing data in the randomly selected node, keep
   * searching for a node that has no state.
   *
   * If an insufficient amount of new replica set nodes are chosen, this method will throw an error.
   * @param {Object} param
   * @param {Set<string>} param.healthyReplicasSet a set of the healthy replica set endpoints
   * @param {Set<string>} param.numberOfUnhealthyReplicas the number of unhealthy replica set endpoints
   * @param {string[]} param.healthyNodes an array of all the healthy nodes available on the network
   * @param {string} param.wallet the wallet of the current user
   * @returns a string[] of the new replica set nodes
   */
  async selectRandomReplicaSetNodes({
    healthyReplicaSet,
    numberOfUnhealthyReplicas,
    healthyNodes,
    wallet
  }) {
    const logStr = `[selectRandomReplicaSetNodes] wallet=${wallet} healthyReplicaSet=[${[
      ...healthyReplicaSet
    ]}] numberOfUnhealthyReplicas=${numberOfUnhealthyReplicas} numberHealthyNodes=${
      healthyNodes.length
    } ||`

    const newReplicaNodesSet = new Set()
    let selectNewReplicaSetAttemptCounter = 0
    while (
      newReplicaNodesSet.size < numberOfUnhealthyReplicas &&
      selectNewReplicaSetAttemptCounter++ < MAX_SELECT_NEW_REPLICA_SET_ATTEMPTS
    ) {
      const randomHealthyNode = _.sample(healthyNodes)

      // If node is already present in new replica set or is part of the exiting replica set, keep finding a unique healthy node
      if (
        newReplicaNodesSet.has(randomHealthyNode) ||
        healthyReplicaSet.has(randomHealthyNode)
      )
        continue

      // Check to make sure that the newly selected secondary does not have existing user state
      try {
        const clockValue = await this._retrieveClockValueForUserFromReplica(
          randomHealthyNode,
          wallet
        )
        if (clockValue === -1) {
          newReplicaNodesSet.add(randomHealthyNode)
        } else if (clockValue === 0) {
          newReplicaNodesSet.add(randomHealthyNode)
          this.logWarn(
            `${logStr} Found a node with clock value of 0, selecting anyway`
          )
        }
      } catch (e) {
        // Something went wrong in checking clock value. Reselect another secondary.
        this.logError(`${logStr} ${e.message}`)
      }
    }

    if (newReplicaNodesSet.size < numberOfUnhealthyReplicas) {
      throw new Error(
        `${logStr} Not enough healthy nodes found to issue new replica set after ${MAX_SELECT_NEW_REPLICA_SET_ATTEMPTS} attempts`
      )
    }

    return Array.from(newReplicaNodesSet)
  }

  /**
   * Given map(replica node => userWallets[]), retrieves clock values for every (node, userWallet) pair
   * @param {Object} replicaSetNodesToUserWalletsMap map of <replica set node : wallets>
   * @param {Set<string>} unhealthyPeers set of unhealthy peer endpoints
   *
   * @returns {Object} map(replica node => map(wallet => clockValue))
   */
  async retrieveClockStatusesForUsersAcrossReplicaSet(
    replicasToWalletsMap,
    unhealthyPeers
  ) {
    const replicasToUserClockStatusMap = {}

    /** In parallel for every replica, fetch clock status for all users on that replica */
    const replicas = Object.keys(replicasToWalletsMap)
    await Promise.all(
      replicas.map(async (replica) => {
        replicasToUserClockStatusMap[replica] = {}

        const walletsOnReplica = replicasToWalletsMap[replica]

        // Make requests in batches, sequentially, to ensure POST request body does not exceed max size
        for (
          let i = 0;
          i < walletsOnReplica.length;
          i += MAX_BATCH_CLOCK_STATUS_BATCH_SIZE
        ) {
          const walletsOnReplicaSlice = walletsOnReplica.slice(
            i,
            i + MAX_BATCH_CLOCK_STATUS_BATCH_SIZE
          )

          const axiosReqParams = {
            baseURL: replica,
            url: '/users/batch_clock_status',
            method: 'post',
            data: { walletPublicKeys: walletsOnReplicaSlice },
            timeout: BATCH_CLOCK_STATUS_REQUEST_TIMEOUT
          }

          // Sign request to other CN to bypass rate limiting
          const { timestamp, signature } = generateTimestampAndSignature(
            { spID: this.spID },
            this.delegatePrivateKey
          )
          axiosReqParams.params = { spID: this.spID, timestamp, signature }

          let batchClockStatusResp = []
          let errorMsg
          try {
            batchClockStatusResp = (
              await retry(async () => axios(axiosReqParams), {
                retries: MAX_USER_BATCH_CLOCK_FETCH_RETRIES
              })
            ).data.data.users
          } catch (e) {
            errorMsg = e
          }

          // If failed to get response after all attempts, add replica to `unhealthyPeers` list for reconfig
          if (errorMsg) {
            this.logError(
              `[retrieveClockStatusesForUsersAcrossReplicaSet] Could not fetch clock values for wallets=${walletsOnReplica} on replica=${replica} ${errorMsg.toString()}`
            )
            unhealthyPeers.add(replica)
          }

          // Add batch response data to aggregate output map
          batchClockStatusResp.forEach((userClockValueResp) => {
            const { walletPublicKey, clock } = userClockValueResp
            replicasToUserClockStatusMap[replica][walletPublicKey] = clock
          })
        }
      })
    )

    return replicasToUserClockStatusMap
  }

  /**
   * Issues SyncRequests for every user from primary (this node) to secondary if needed
   * Only issues requests if primary clock value is greater than secondary clock value
   *
   * @param {Object[]} userReplicaSets array of objects of schema { user_id, wallet, primary, secondary1, secondary2, endpoint }
   *      `endpoint` field indicates secondary on which to issue SyncRequest
   * @param {Object} replicaSetNodesToUserClockStatusesMap map(replica set node => map(userWallet => clockValue))
   * @returns {Object} number of syncs required, enqueued, and errors if any
   */
  async issueSyncRequestsToSecondaries(
    userReplicaSets,
    replicaSetNodesToUserClockStatusesMap
  ) {
    // Retrieve clock values for all users on this node, which is their primary
    let numSyncRequestsRequired = 0
    let numSyncRequestsEnqueued = 0
    const enqueueSyncRequestErrors = []

    await Promise.all(
      userReplicaSets.map(async (user) => {
        try {
          const {
            wallet,
            primary,
            secondary1,
            secondary2,
            endpoint: secondary
          } = user

          // Short-circuit if primary is not self - this function is meant to be called from primary to secondaries only
          if (primary !== this.endpoint) {
            this.logError(
              `issueSyncRequests || Can only be called by user's primary. User ${wallet} - replicaset [${primary}, ${secondary1}, ${secondary2}].`
            )
            return
          }

          // Determine if secondary requires a sync by comparing clock values against primary (this node)
          const userPrimaryClockVal =
            replicaSetNodesToUserClockStatusesMap[primary][wallet]
          const userSecondaryClockVal =
            replicaSetNodesToUserClockStatusesMap[secondary][wallet]

          if (userPrimaryClockVal > userSecondaryClockVal) {
            numSyncRequestsRequired += 1

            await this.enqueueSync({
              userWallet: wallet,
              secondaryEndpoint: secondary,
              primaryEndpoint: this.endpoint,
              syncType: SyncType.Recurring
            })

            numSyncRequestsEnqueued += 1
          }

          // Swallow error without short-circuiting other processing
        } catch (e) {
          enqueueSyncRequestErrors.push(
            `issueSyncRequestsToSecondaries() Error for user ${JSON.stringify(
              user
            )} - ${e.message}`
          )
        }
      })
    )

    return {
      numSyncRequestsRequired,
      numSyncRequestsEnqueued,
      enqueueSyncRequestErrors
    }
  }

  /**
   * Main state machine processing function
   * - Processes all users in chunks
   * - For every user on an unhealthy replica, issues an updateReplicaSet op to cycle them off
   * - For every (primary) user on a healthy secondary replica, issues SyncRequest op to secondary
   */
  async processStateMachineOperation() {
    // Record all stages of this function along with associated information for use in logging
    const decisionTree = []
    this._addToStateMachineQueueDecisionTree(
      decisionTree,
      'BEGIN processStateMachineOperation()',
      {
        currentModuloSlice: this.currentModuloSlice,
        moduloBase: this.moduloBase
      }
    )

    try {
      let nodeUsers
      try {
        nodeUsers = await this.peerSetManager.getNodeUsers()
        nodeUsers = this.sliceUsers(nodeUsers)

        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'getNodeUsers() and sliceUsers() Success',
          { nodeUsersLength: nodeUsers.length }
        )
      } catch (e) {
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'getNodeUsers() or sliceUsers() Error',
          { error: e.message }
        )
        throw new Error(
          `processStateMachineOperation():getNodeUsers()/sliceUsers() Error: ${e.toString()}`
        )
      }

      let unhealthyPeers
      try {
        unhealthyPeers = await this.peerSetManager.getUnhealthyPeers(nodeUsers)
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'getUnhealthyPeers() Success',
          {
            unhealthyPeerSetLength: unhealthyPeers.size,
            unhealthyPeers: Array.from(unhealthyPeers)
          }
        )
      } catch (e) {
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'processStateMachineOperation():getUnhealthyPeers() Error',
          { error: e.message }
        )
        throw new Error(
          `processStateMachineOperation():getUnhealthyPeers() Error: ${e.toString()}`
        )
      }

      // Build map of <replica set node : [array of wallets that are on this replica set node]>
      const replicaSetNodesToUserWalletsMap =
        this.peerSetManager.buildReplicaSetNodesToUserWalletsMap(nodeUsers)
      this._addToStateMachineQueueDecisionTree(
        decisionTree,
        'buildReplicaSetNodesToUserWalletsMap() Success',
        {
          numReplicaSetNodes: Object.keys(replicaSetNodesToUserWalletsMap)
            .length
        }
      )

      // Setup the mapping of Content Node endpoint to service provider id
      try {
        await this.peerSetManager.updateEndpointToSpIdMap(
          this.audiusLibs.ethContracts
        )

        // Update enabledReconfigModesSet after successful `updateEndpointToSpIDMap()` call
        this.updateEnabledReconfigModesSet()

        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'updateEndpointToSpIdMap() Success',
          {
            endpointToSPIdMapSize: Object.keys(
              this.peerSetManager.endpointToSPIdMap
            ).length
          }
        )
      } catch (e) {
        // Disable reconfig after failed `updateEndpointToSpIDMap()` call
        this.updateEnabledReconfigModesSet(
          /* override */ RECONFIG_MODES.RECONFIG_DISABLED.key
        )
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'updateEndpointToSpIdMap() Error',
          { error: e.message }
        )
      }

      // Retrieve clock statuses for all users and their current replica sets
      let replicaSetNodesToUserClockStatusesMap
      try {
        replicaSetNodesToUserClockStatusesMap =
          await this.retrieveClockStatusesForUsersAcrossReplicaSet(
            replicaSetNodesToUserWalletsMap,
            unhealthyPeers
          )
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'retrieveClockStatusesForUsersAcrossReplicaSet() Success'
        )
      } catch (e) {
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'retrieveClockStatusesForUsersAcrossReplicaSet() Error',
          { error: e.message }
        )
        throw new Error(
          'processStateMachineOperation():retrieveClockStatusesForUsersAcrossReplicaSet() Error'
        )
      }

      const { requiredUpdateReplicaSetOps, potentialSyncRequests } =
        await this.aggregateReconfigAndPotentialSyncOps(
          nodeUsers,
          unhealthyPeers
        )
      this._addToStateMachineQueueDecisionTree(
        decisionTree,
        'Build requiredUpdateReplicaSetOps and potentialSyncRequests arrays',
        {
          requiredUpdateReplicaSetOpsLength: requiredUpdateReplicaSetOps.length,
          potentialSyncRequestsLength: potentialSyncRequests.length
        }
      )

      // Issue all required sync requests
      let numSyncRequestsRequired,
        numSyncRequestsEnqueued,
        enqueueSyncRequestErrors
      try {
        const resp = await this.issueSyncRequestsToSecondaries(
          potentialSyncRequests,
          replicaSetNodesToUserClockStatusesMap
        )
        numSyncRequestsRequired = resp.numSyncRequestsRequired
        numSyncRequestsEnqueued = resp.numSyncRequestsEnqueued
        enqueueSyncRequestErrors = resp.enqueueSyncRequestErrors

        // Error if > 50% syncRequests fail
        if (enqueueSyncRequestErrors.length > numSyncRequestsEnqueued) {
          throw new Error('More than 50% of SyncRequests failed to be enqueued')
        }

        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'issueSyncRequestsToSecondaries() Success',
          {
            numSyncRequestsRequired,
            numSyncRequestsEnqueued,
            numEnqueueSyncRequestErrors: enqueueSyncRequestErrors.length,
            enqueueSyncRequestErrors
          }
        )
      } catch (e) {
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'issueSyncRequestsToSecondaries() Error',
          {
            error: e.message,
            numSyncRequestsRequired,
            numSyncRequestsEnqueued,
            numEnqueueSyncRequestErrors: enqueueSyncRequestErrors.length,
            enqueueSyncRequestErrors
          }
        )
      }

      /**
       * Issue all required replica set updates
       * TODO move to chunked parallel (maybe?) + wrap each in try-catch to not halt on single error
       */
      let numUpdateReplicaOpsIssued = 0
      try {
        /**
         * Fetch all the healthy nodes while disabling sync checks to select nodes for new replica set
         * Note: sync checks are disabled because there should not be any syncs occurring for a particular user
         * on a new replica set. Also, the sync check logic is coupled with a user state on the userStateManager.
         * There will be an explicit clock value check on the newly selected replica set nodes instead.
         */
        const { services: healthyServicesMap } =
          await this.audiusLibs.ServiceProvider.autoSelectCreatorNodes({
            performSyncCheck: false,
            log: false
          })

        const healthyNodes = Object.keys(healthyServicesMap)
        if (healthyNodes.length === 0)
          throw new Error(
            'Auto-selecting Content Nodes returned an empty list of healthy nodes.'
          )

        let numIssueUpdateReplicaSetOpErrors = 0
        for await (const userInfo of requiredUpdateReplicaSetOps) {
          const { errorMsg, issuedReconfig } =
            await this.issueUpdateReplicaSetOp(
              userInfo.user_id,
              userInfo.wallet,
              userInfo.primary,
              userInfo.secondary1,
              userInfo.secondary2,
              userInfo.unhealthyReplicas,
              healthyNodes,
              replicaSetNodesToUserWalletsMap
            )

          if (errorMsg) numIssueUpdateReplicaSetOpErrors++
          if (issuedReconfig) numUpdateReplicaOpsIssued++
        }
        if (numIssueUpdateReplicaSetOpErrors > 0)
          throw new Error(
            `issueUpdateReplicaSetOp() failed for ${numIssueUpdateReplicaSetOpErrors} users`
          )

        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'issueUpdateReplicaSetOp() Success',
          { numUpdateReplicaOpsIssued }
        )
      } catch (e) {
        this._addToStateMachineQueueDecisionTree(
          decisionTree,
          'issueUpdateReplicaSetOp() Error',
          { error: e.message }
        )
        throw new Error(
          'processStateMachineOperation():issueUpdateReplicaSetOp() Error'
        )
      }
    } catch (e) {
      this._addToStateMachineQueueDecisionTree(
        decisionTree,
        'processStateMachineOperation() Error',
        { error: e.message }
      )
    } finally {
      this._addToStateMachineQueueDecisionTree(
        decisionTree,
        'END processStateMachineOperation()',
        {
          currentModuloSlice: this.currentModuloSlice,
          moduloBase: this.moduloBase
        }
      )

      // Log decision tree
      this._printStateMachineQueueDecisionTree(decisionTree)

      // Increment and adjust current slice by this.moduloBase
      this.currentModuloSlice = (this.currentModuloSlice + 1) % this.moduloBase
    }
  }

  _addToStateMachineQueueDecisionTree(decisionTree, stage, data = {}) {
    const obj = { stage, data, time: Date.now() }

    if (decisionTree.length > 0) {
      // Set duration if both objs have time field
      const lastObj = decisionTree[decisionTree.length - 1]
      if (lastObj && lastObj.time) {
        const duration = obj.time - lastObj.time
        obj.duration = duration
      }
    }
    decisionTree.push(obj)
  }

  _printStateMachineQueueDecisionTree(decisionTree, msg = '') {
    // Compute and record `fullDuration`
    if (decisionTree.length > 2) {
      const startTime = decisionTree[0].time
      const endTime = decisionTree[decisionTree.length - 1].time
      const duration = endTime - startTime
      decisionTree[decisionTree.length - 1].fullDuration = duration
    }
    try {
      this.log(
        `processStateMachineOperation() Decision Tree${
          msg ? ` - ${msg} - ` : ''
        }${JSON.stringify(decisionTree)}`
      )
    } catch (e) {
      this.logError(
        `Error printing processStateMachineOperation() Decision Tree ${decisionTree}`
      )
    }
  }

  /**
   * Make request to given replica to get its clock value for given user
   * Signs request with spID to bypass rate limits
   */
  async _retrieveClockValueForUserFromReplica(replica, wallet) {
    const spID = this.spID

    const { timestamp, signature } = generateTimestampAndSignature(
      { spID },
      this.delegatePrivateKey
    )

    const clockValue = await CreatorNode.getClockValue(
      replica,
      wallet,
      CLOCK_STATUS_REQUEST_TIMEOUT_MS,
      {
        spID,
        timestamp,
        signature
      }
    )

    return clockValue
  }

  /**
   * For every node user, record sync requests to issue to secondaries if this node is primary
   *    and record replica set updates to issue for any unhealthy replicas
   *
   * Purpose for the if/else case is that if the current node is a primary, issue reconfig or sync requests.
   * Else, if the current node is a secondary, only issue reconfig requests.
   *
   * @param {Object} nodeUser { primary, secondary1, secondary2, [primarySpID?], [secondary1SpID?], [secondary2SpID?], user_id, wallet}
   * @param {Set<string>} unhealthyPeers set of unhealthy peers
   * @returns
   * {
   *  requiredUpdateReplicaSetOps: {Object[]} array of {...nodeUsers, unhealthyReplicas: {string[]} endpoints of unhealthy rset nodes }
   *  potentialSyncRequests: {Object[]} array of {...nodeUsers, endpoint: {string} endpoint to sync to }
   * }
   * @notice this will issue sync to healthy secondary and update replica set away from unhealthy secondary
   */
  async aggregateReconfigAndPotentialSyncOps(nodeUsers, unhealthyPeers) {
    let requiredUpdateReplicaSetOps = []
    let potentialSyncRequests = []

    for (const nodeUser of nodeUsers) {
      const { primarySpID, secondary1SpID, secondary2SpID } = nodeUser

      // If these spIds are undefined, it means that the Discovery Node does not have the latest code to return
      // these fields. Fallback to the original aggregation logic. If present, use the spIds to determine whether
      // reconfigs/syncs are necessary.
      let subsetReplicaOps, subsetSyncReqs
      if (primarySpID && secondary1SpID && secondary2SpID) {
        ;({
          requiredUpdateReplicaSetOps: subsetReplicaOps,
          potentialSyncRequests: subsetSyncReqs
        } = await this._aggregateOpsWithQueriedSpIds(nodeUser, unhealthyPeers))
      } else {
        // TODO: remove this else case once all the Discovery Nodes have upgraded and return the necessary replica set spIds
        ;({
          requiredUpdateReplicaSetOps: subsetReplicaOps,
          potentialSyncRequests: subsetSyncReqs
        } = await this._aggregateOpsWithoutQueriedSpIds(
          nodeUser,
          unhealthyPeers
        ))
      }

      requiredUpdateReplicaSetOps =
        requiredUpdateReplicaSetOps.concat(subsetReplicaOps)
      potentialSyncRequests = potentialSyncRequests.concat(subsetSyncReqs)
    }

    return { requiredUpdateReplicaSetOps, potentialSyncRequests }
  }

  /**
   * Used to determine the `requiredUpdateReplicaSetOps` and `potentialSyncRequests` for a given nodeUser.
   * @param {Object} nodeUser { primary, secondary1, secondary2, primarySpID, secondary1SpID, secondary2SpID, user_id, wallet}
   * @param {Set<string>} unhealthyPeers set of unhealthy peers
   */
  async _aggregateOpsWithQueriedSpIds(nodeUser, unhealthyPeers) {
    const requiredUpdateReplicaSetOps = []
    const potentialSyncRequests = []
    const unhealthyReplicas = []

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

    if (primary === this.endpoint) {
      // filter out false-y values to account for incomplete replica sets
      const secondariesInfo = replicaSetNodesToObserve.filter(
        (entry) => entry.endpoint
      )
      const secondariesEndpoint = secondariesInfo.map((entry) => entry.endpoint)

      /**
       * For each secondary, enqueue `potentialSyncRequest` if healthy else add to `unhealthyReplicas`
       */
      const userSecondarySyncMetrics =
        await this._computeUserSecondarySyncSuccessRates(
          nodeUser,
          secondariesEndpoint
        )
      for (const secondaryInfo of secondariesInfo) {
        const secondary = secondaryInfo.endpoint

        const { successRate, successCount, failureCount } =
          userSecondarySyncMetrics[secondary]

        // Error case 1 - mismatched spID
        if (
          this.peerSetManager.endpointToSPIdMap[secondary] !==
          secondaryInfo.spId
        ) {
          this.logError(
            `processStateMachineOperation(): Secondary ${secondary} for user ${wallet} mismatched spID. Expected ${secondaryInfo.spId}, found ${this.peerSetManager.endpointToSPIdMap[secondary]}. Marking replica as unhealthy.`
          )
          unhealthyReplicas.push(secondary)

          // Error case 2 - already marked unhealthy
        } else if (unhealthyPeers.has(secondary)) {
          this.logError(
            `processStateMachineOperation(): Secondary ${secondary} for user ${wallet} in unhealthy peer set. Marking replica as unhealthy.`
          )
          unhealthyReplicas.push(secondary)

          // Error case 3 - low user sync success rate
        } else if (
          failureCount >= this.MinimumFailedSyncRequestsBeforeReconfig &&
          successRate < this.MinimumSecondaryUserSyncSuccessPercent
        ) {
          this.logError(
            `processStateMachineOperation(): Secondary ${secondary} for user ${wallet} has userSyncSuccessRate of ${successRate}, which is below threshold of ${this.MinimumSecondaryUserSyncSuccessPercent}. ${successCount} Successful syncs vs ${failureCount} Failed syncs. Marking replica as unhealthy.`
          )
          unhealthyReplicas.push(secondary)

          // Success case
        } else {
          potentialSyncRequests.push({ ...nodeUser, endpoint: secondary })
        }
      }

      /**
       * If any unhealthy replicas found for user, enqueue an updateReplicaSetOp for later processing
       */
      if (unhealthyReplicas.length > 0) {
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
        return entry.endpoint && entry.endpoint !== this.endpoint
      })

      for (const replica of replicaSetNodesToObserve) {
        // If the map's spId does not match the query's spId, then regardless
        // of the relationship of the node to the user, issue a reconfig for that node
        if (
          this.peerSetManager.endpointToSPIdMap[replica.endpoint] !==
          replica.spId
        ) {
          unhealthyReplicas.push(replica.endpoint)
        } else if (unhealthyPeers.has(replica.endpoint)) {
          // Else, continue with conducting extra health check if the current observed node is a primary, and
          // add to `unhealthyReplicas` if observed node is a secondary
          let addToUnhealthyReplicas = true

          if (replica.endpoint === primary) {
            addToUnhealthyReplicas =
              !(await this.peerSetManager.isPrimaryHealthy(primary))
          }

          if (addToUnhealthyReplicas) {
            unhealthyReplicas.push(replica.endpoint)
          }
        }
      }

      if (unhealthyReplicas.length > 0) {
        requiredUpdateReplicaSetOps.push({ ...nodeUser, unhealthyReplicas })
      }
    }

    return { requiredUpdateReplicaSetOps, potentialSyncRequests }
  }

  /**
   * Used to determine the `requiredUpdateReplicaSetOps` and `potentialSyncRequests` for a given nodeUser, given that the
   * nodeUser observed did not return any spIds for the replica set from the Discovery query.
   * @param {Object} nodeUser {secondary1, secondary2, primary, user_id, wallet}
   * @param {Set<string>} unhealthyPeers set of unhealthy peers
   * @param {Object[]} requiredUpdateReplicaSetOps array of {...nodeUsers, unhealthyReplicas: {string[]} endpoints of unhealthy rset nodes }
   * @param {Object[]} potentialSyncRequests array of {...nodeUsers, endpoint: {string} endpoint to sync to }
   *
   * @note this is for backwards compatibility. Once all the discovery nodes have upgraded, we can deprecate and remove this method.
   */
  async _aggregateOpsWithoutQueriedSpIds(nodeUser, unhealthyPeers) {
    const requiredUpdateReplicaSetOps = []
    const potentialSyncRequests = []
    const unhealthyReplicas = []

    const { secondary1, secondary2, primary } = nodeUser

    /**
     * If this node is primary for user, check both secondaries for health
     * Enqueue SyncRequests against healthy secondaries, and enqueue UpdateReplicaSetOps against unhealthy secondaries
     */
    if (primary === this.endpoint) {
      // filter out false-y values to account for incomplete replica sets
      const secondaries = [secondary1, secondary2].filter(Boolean)

      /**
       * For each secondary, enqueue `potentialSyncRequest` if healthy else add to `unhealthyReplicas`
       */
      const userSecondarySyncMetrics =
        await this._computeUserSecondarySyncSuccessRates(
          nodeUser.wallet,
          secondaries
        )
      for (const secondary of secondaries) {
        const { successRate, successCount, failureCount } =
          userSecondarySyncMetrics[secondary]

        // Error case 1 - already marked unhealty
        if (unhealthyPeers.has(secondary)) {
          this.logError(
            `processStateMachineOperation(): Secondary ${secondary} for user ${nodeUser.wallet} in unhealthy peer set. Marking replica as unhealthy.`
          )
          unhealthyReplicas.push(secondary)

          // Error case 2 - low user sync success rate
        } else if (
          failureCount >= this.MinimumFailedSyncRequestsBeforeReconfig &&
          successRate < this.MinimumSecondaryUserSyncSuccessPercent
        ) {
          this.logError(
            `processStateMachineOperation(): Secondary ${secondary} for user ${nodeUser.wallet} has userSyncSuccessRate of ${successRate}, which is below threshold of ${this.MinimumSecondaryUserSyncSuccessPercent}. ${successCount} Successful syncs vs ${failureCount} Failed syncs. Marking replica as unhealthy.`
          )
          unhealthyReplicas.push(secondary)

          // Success case
        } else {
          potentialSyncRequests.push({ ...nodeUser, endpoint: secondary })
        }
      }

      /**
       * If any unhealthy replicas found for user, enqueue an updateReplicaSetOp for later processing
       */
      if (unhealthyReplicas.length > 0) {
        requiredUpdateReplicaSetOps.push({ ...nodeUser, unhealthyReplicas })
      }

      /**
       * If this node is secondary for user, check both secondaries for health and enqueue SyncRequests against healthy secondaries
       * Ignore unhealthy secondaries for now
       */
    } else {
      // filter out false-y values to account for incomplete replica sets
      let replicas = [primary, secondary1, secondary2].filter(Boolean)
      // filter out this endpoint
      replicas = replicas.filter((replica) => replica !== this.endpoint)

      for (const replica of replicas) {
        if (unhealthyPeers.has(replica)) {
          let addToUnhealthyReplicas = true

          // If the current replica is the primary, perform a second health check.
          // and determine if the primary is truly unhealthy
          if (replica === primary) {
            addToUnhealthyReplicas =
              !(await this.peerSetManager.isPrimaryHealthy(primary))
          }

          if (addToUnhealthyReplicas) unhealthyReplicas.push(replica)
        }
      }

      if (unhealthyReplicas.length > 0) {
        requiredUpdateReplicaSetOps.push({ ...nodeUser, unhealthyReplicas })
      }
    }

    return { requiredUpdateReplicaSetOps, potentialSyncRequests }
  }

  // Wrapper fn
  async _computeUserSecondarySyncSuccessRates(nodeUser, secondaries) {
    return SecondarySyncHealthTracker.computeUserSecondarySyncSuccessRates(
      nodeUser.wallet,
      secondaries
    )
  }

  /**
   * Monitor an ongoing sync operation for a given secondaryUrl and user wallet
   * Return boolean indicating if an additional sync is required
   * Record SyncRequest outcomes to SecondarySyncHealthTracker
   */
  async additionalSyncIsRequired(
    userWallet,
    primaryClockValue = -1,
    secondaryUrl,
    syncType
  ) {
    const logMsgString = `additionalSyncIsRequired (${syncType}): wallet ${userWallet} secondary ${secondaryUrl} primaryClock ${primaryClockValue}`

    const startTimeMs = Date.now()
    const maxMonitoringTimeMs = startTimeMs + this.MaxSyncMonitoringDurationInMs

    /**
     * Poll secondary for sync completion, up to `maxMonitoringTimeMs`
     */

    let secondaryCaughtUpToPrimary = false
    let initialSecondaryClock = null
    let finalSecondaryClock = null

    while (Date.now() < maxMonitoringTimeMs) {
      try {
        const secondaryClockValue =
          await this._retrieveClockValueForUserFromReplica(
            secondaryUrl,
            userWallet
          )
        this.logDebug(`${logMsgString} secondaryClock ${secondaryClockValue}`)

        // Record starting and current clock values for secondary to determine future action
        if (initialSecondaryClock === null) {
          initialSecondaryClock = secondaryClockValue
        }
        finalSecondaryClock = secondaryClockValue

        /**
         * Stop monitoring if secondary has caught up to primary
         * Note - secondaryClockValue can be greater than primaryClockValue if additional
         *    data was written to primary after primaryClockValue was computed
         */
        if (secondaryClockValue >= primaryClockValue) {
          secondaryCaughtUpToPrimary = true
          break
        }
      } catch (e) {
        this.logError(`${logMsgString} || Error: ${e.message}`)
      }

      // Delay between retries
      await utils.timeout(SyncMonitoringRetryDelayMs, false)
    }

    const monitoringTimeMs = Date.now() - startTimeMs

    /**
     * As Primary for user, record SyncRequest outcomes to all secondaries
     * Also check whether additional sync is required
     */
    let additionalSyncIsRequired
    if (secondaryCaughtUpToPrimary) {
      await SecondarySyncHealthTracker.recordSuccess(
        secondaryUrl,
        userWallet,
        syncType
      )
      additionalSyncIsRequired = false
      this.logDebug(
        `${logMsgString} || Sync completed in ${monitoringTimeMs}ms`
      )

      // Secondary completed sync but is still behind primary since it was behind by more than max export range
      // Since syncs are all-or-nothing, if secondary clock has increased at all, we know it successfully completed sync
    } else if (finalSecondaryClock > initialSecondaryClock) {
      await SecondarySyncHealthTracker.recordSuccess(
        secondaryUrl,
        userWallet,
        syncType
      )
      additionalSyncIsRequired = true
      this.log(
        `${logMsgString} || Secondary successfully synced from clock ${initialSecondaryClock} to ${finalSecondaryClock} but hasn't caught up to Primary. Enqueuing additional syncRequest.`
      )

      // (1) secondary did not catch up to primary AND (2) secondary did not complete sync
    } else {
      await SecondarySyncHealthTracker.recordFailure(
        secondaryUrl,
        userWallet,
        syncType
      )
      additionalSyncIsRequired = true
      this.logError(
        `${logMsgString} || Secondary failed to progress from clock ${initialSecondaryClock}. Enqueuing additional syncRequest.`
      )
    }

    return additionalSyncIsRequired
  }

  /**
   * Processes job as it is picked off the queue
   *  - Handles sync jobs for manualSyncQueue and recurringSyncQueue
   *  - Given job data, triggers sync request to secondary
   *
   * @param job instance of Bull queue job
   */
  async processSyncOperation(job, syncType) {
    const { id } = job
    const { syncRequestParameters } = job.data

    const isValidSyncJobData =
      'baseURL' in syncRequestParameters &&
      'url' in syncRequestParameters &&
      'method' in syncRequestParameters &&
      'data' in syncRequestParameters
    if (!isValidSyncJobData) {
      logger.error(`Invalid sync data found`, job.data)
      return
    }

    const userWallet = syncRequestParameters.data.wallet[0]
    const secondaryEndpoint = syncRequestParameters.baseURL

    const logMsgString = `(${syncType}) User ${userWallet} | Secondary: ${secondaryEndpoint}`

    /**
     * Remove sync from syncDeDuplicator once it moves to Active status, before processing
     * It is ok for two identical syncs to be present in Active and Waiting, just not two in Waiting
     */
    this.syncDeDuplicator.removeSync(syncType, userWallet, secondaryEndpoint)

    /**
     * Do not issue syncRequest if SecondaryUserSyncFailureCountForToday already exceeded threshold
     */
    const secondaryUserSyncFailureCountForToday =
      await SecondarySyncHealthTracker.getSecondaryUserSyncFailureCountForToday(
        secondaryEndpoint,
        userWallet,
        syncType
      )
    if (
      secondaryUserSyncFailureCountForToday >
      this.SecondaryUserSyncDailyFailureCountThreshold
    ) {
      this.logError(
        `${logMsgString} || Secondary has already met SecondaryUserSyncDailyFailureCountThreshold (${this.SecondaryUserSyncDailyFailureCountThreshold}). Will not issue further syncRequests today.`
      )
      return
    }

    // primaryClockValue is used in additionalSyncIsRequired() call below
    const primaryClockValue = (
      await this.getUserPrimaryClockValues([userWallet])
    )[userWallet]

    this.log(
      `------------------Process SYNC | ${logMsgString} | Primary clock value ${primaryClockValue} | jobID: ${id}------------------`
    )

    // Issue sync request to secondary
    try {
      await axios(syncRequestParameters)
    } catch (e) {
      // Axios request will throw on non-200 response -> swallow error to ensure below logic is executed
      this.logError(
        `${logMsgString} || Error issuing sync request: ${e.message}`
      )
    }

    // Wait until has sync has completed (within time threshold)
    const additionalSyncIsRequired = await this.additionalSyncIsRequired(
      userWallet,
      primaryClockValue,
      secondaryEndpoint,
      syncType
    )

    // Re-enqueue sync if required
    if (additionalSyncIsRequired) {
      await this.enqueueSync({
        userWallet,
        primaryEndpoint: this.endpoint,
        secondaryEndpoint,
        syncType
      })
    }

    this.log(
      `------------------END Process SYNC | ${logMsgString} | jobID: ${id}------------------`
    )
  }

  /**
   * Returns all jobs from manualSyncQueue and recurringSyncQueue, keyed by status
   *
   * @dev TODO may be worth manually recording + exposing completed jobs count
   *    completed and failed job records are disabled in createBullQueue()
   */
  async getSyncQueueJobs() {
    const [manualWaiting, manualActive, recurringWaiting, recurringActive] =
      await Promise.all([
        this.manualSyncQueue.getJobs(['waiting']),
        this.manualSyncQueue.getJobs(['active']),
        this.recurringSyncQueue.getJobs(['waiting']),
        this.recurringSyncQueue.getJobs(['active'])
      ])

    return {
      manualWaiting,
      manualActive,
      recurringWaiting,
      recurringActive
    }
  }

  /**
   * Select chunk of users to process in this run
   *  - User is selected if (user_id % moduloBase = currentModuloSlice)
   * @param {Object[]} nodeUsers array of objects of schema { primary, secondary1, secondary2, user_id, wallet }
   */
  sliceUsers(nodeUsers) {
    return nodeUsers.filter(
      (nodeUser) =>
        nodeUser.user_id % this.moduloBase === this.currentModuloSlice
    )
  }

  /**
   * Issues syncRequest for user against secondary, and polls for replication up to primary
   * If secondary fails to sync within specified timeoutMs, will error
   */
  async issueSyncRequestsUntilSynced(
    secondaryUrl,
    wallet,
    primaryClockVal,
    timeoutMs
  ) {
    // Issue syncRequest before polling secondary for replication
    await this.enqueueSync({
      userWallet: wallet,
      secondaryEndpoint: secondaryUrl,
      primaryEndpoint: this.endpoint,
      syncType: SyncType.Manual,
      immediate: true
    })

    // Poll clock status and issue syncRequests until secondary is caught up or until timeoutMs
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        // Retrieve secondary clock status for user
        const secondaryClockStatusResp = await axios({
          method: 'get',
          baseURL: secondaryUrl,
          url: `/users/clock_status/${wallet}`,
          responseType: 'json',
          timeout: 1000 // 1000ms = 1s
        })
        const { clockValue: secondaryClockVal, syncInProgress } =
          secondaryClockStatusResp.data.data

        // If secondary is synced, return successfully
        if (secondaryClockVal >= primaryClockVal) {
          return

          // Else, if a sync is not already in progress on the secondary, issue a new SyncRequest
        } else if (!syncInProgress) {
          await this.enqueueSync({
            userWallet: wallet,
            secondaryEndpoint: secondaryUrl,
            primaryEndpoint: this.endpoint,
            syncType: SyncType.Manual
          })
        }

        // Give secondary some time to process ongoing or newly enqueued sync
        // NOTE - we might want to make this timeout longer
        await utils.timeout(500)
      } catch (e) {
        // do nothing and let while loop continue
      }
    }

    // This condition will only be hit if the secondary has failed to sync within timeoutMs
    throw new Error(
      `Secondary ${secondaryUrl} did not sync up to primary for user ${wallet} within ${timeoutMs}ms`
    )
  }

  /**
   * Given the current snapback mode, determine if reconfig is enabled
   * @param {string} mode current mode in snapback
   * @returns boolean of whether or not reconfig is enabled
   */
  isReconfigEnabled(mode) {
    if (mode === RECONFIG_MODES.RECONFIG_DISABLED.key) return false
    return this.enabledReconfigModesSet.has(mode)
  }

  /**
   * Updates `enabledReconfigModesSet` and `highestEnabledReconfigMode`.
   * Uses `override` if provided, else uses config var.
   * `enabledReconfigModesSet` contains every mode with rank <= `highestEnabledReconfigMode`
   *   - e.g. `highestEnabledReconfigMode = 'PRIMARY_AND_SECONDARY'
   *      `enabledReconfigModesSet = { 'RECONFIG_DISABLED', 'ONE_SECONDARY', 'MULTIPLE_SECONDARIES', 'PRIMARY_AND_SECONDARY' }
   */
  updateEnabledReconfigModesSet(override) {
    let highestEnabledReconfigMode

    // Set mode to override if provided
    if (override) {
      highestEnabledReconfigMode = override

      // Else, set mode to config var, defaulting to RECONFIG_DISABLED if invalid
    } else {
      highestEnabledReconfigMode = RECONFIG_MODE_KEYS.includes(
        this.nodeConfig.get('snapbackHighestReconfigMode')
      )
        ? this.nodeConfig.get('snapbackHighestReconfigMode')
        : RECONFIG_MODES.RECONFIG_DISABLED.key
    }

    // All modes with lower rank than `highestEnabledReconfigMode` should be enabled
    const enabledReconfigModesSet = new Set(
      RECONFIG_MODE_KEYS.filter(
        (mode) =>
          RECONFIG_MODES[mode].value <=
          RECONFIG_MODES[highestEnabledReconfigMode].value
      )
    )

    // Update class variables for external access
    this.highestEnabledReconfigMode = highestEnabledReconfigMode
    this.enabledReconfigModesSet = enabledReconfigModesSet
  }
}

module.exports = { SnapbackSM, SyncType, RECONFIG_MODE_KEYS, RECONFIG_MODES }
