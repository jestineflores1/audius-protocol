/* eslint-disable no-unused-expressions */
const chai = require('chai')
const sinon = require('sinon')
const { expect } = chai
const proxyquire = require('proxyquire')
const _ = require('lodash')

const { getApp } = require('./lib/app')
const { getLibsMock } = require('./lib/libsMock')

const config = require('../src/config')
const {
  QUEUE_NAMES,
  JOB_NAMES
} = require('../src/services/stateMachineManager/stateMachineConstants')

chai.use(require('sinon-chai'))

describe('test monitorState job processor', function () {
  let server,
    sandbox,
    logger,
    originalContentNodeEndpoint,
    getNodeUsersStub,
    getUnhealthyPeersStub,
    buildReplicaSetNodesToUserWalletsMapStub,
    retrieveClockStatusesForUsersAcrossReplicaSetStub,
    computeUserSecondarySyncSuccessRatesMapStub,
    getCNodeEndpointToSpIdMapStub
  beforeEach(async function () {
    const appInfo = await getApp(getLibsMock())
    await appInfo.app.get('redisClient').flushdb()
    server = appInfo.server
    sandbox = sinon.createSandbox()
    config.set('spID', 1)
    originalContentNodeEndpoint = config.get('creatorNodeEndpoint')
  })

  afterEach(async function () {
    await server.close()
    sandbox.restore()

    config.set('creatorNodeEndpoint', originalContentNodeEndpoint)
    getNodeUsersStub = null
    getUnhealthyPeersStub = null
    buildReplicaSetNodesToUserWalletsMapStub = null
    retrieveClockStatusesForUsersAcrossReplicaSetStub = null
    computeUserSecondarySyncSuccessRatesMapStub = null
    getCNodeEndpointToSpIdMapStub = null
  })

  const LAST_PROCESSED_USER_ID = 5
  const NUM_USERS_TO_PROCESS = 4
  const DISCOVERY_NODE_ENDPOINT = 'http://default_dn1.co'
  const CONTENT_NODE_ENDPOINT = 'http://default_cn1.co'
  const USER_ID = 999
  const USERS = [{ user_id: USER_ID }]
  const UNHEALTHY_PEERS = new Set(['testUnhealthyPeer'])
  const REPLICA_SET_NODES_TO_USER_WALLETS_MAP = {
    'http://healthCn1.co': ['wallet1']
  }
  const REPLICAS_TO_USER_CLOCK_STATUS_MAP = {
    'http://healthCn1.co': { wallet1: 1 }
  }
  const RETRIEVE_CLOCK_STATUS_EXTRA_UNHEALTHY_PEERS = new Set()
  const RETRIEVE_CLOCK_STATUSES_FOR_USERS_ACROSS_REPLICA_SET_RESP = {
    replicasToUserClockStatusMap: REPLICAS_TO_USER_CLOCK_STATUS_MAP,
    unhealthyPeers: RETRIEVE_CLOCK_STATUS_EXTRA_UNHEALTHY_PEERS
  }
  const USER_SECONDARY_SYNC_SUCCESS_RATES_MAP = { dummyMap: 'dummyMap' }
  const CNODE_ENDPOINT_TO_SP_ID_MAP = { dummyCNodeMap: 'dummyCNodeMap' }

  // Return processStateMonitoringJob with each step stubbed to return
  // the given params or default values
  function makeProcessStateMonitoringJob({
    users = USERS,
    unhealthyPeers = UNHEALTHY_PEERS,
    replicaSetNodesToUserWalletsMap = REPLICA_SET_NODES_TO_USER_WALLETS_MAP,
    retrieveClockStatusesForUsersAcrossReplicaSetResp = RETRIEVE_CLOCK_STATUSES_FOR_USERS_ACROSS_REPLICA_SET_RESP,
    userSecondarySyncSuccessRatesMap = USER_SECONDARY_SYNC_SUCCESS_RATES_MAP,
    cNodeEndpointToSpIdMap = CNODE_ENDPOINT_TO_SP_ID_MAP
  }) {
    // Make the stubs return the given params if they're not already set
    if (!getNodeUsersStub) {
      getNodeUsersStub = sandbox.stub().resolves(users)
    }
    if (!getUnhealthyPeersStub) {
      getUnhealthyPeersStub = sandbox.stub().resolves(unhealthyPeers)
    }
    if (!buildReplicaSetNodesToUserWalletsMapStub) {
      buildReplicaSetNodesToUserWalletsMapStub = sandbox
        .stub()
        .returns(replicaSetNodesToUserWalletsMap)
    }
    if (!retrieveClockStatusesForUsersAcrossReplicaSetStub) {
      retrieveClockStatusesForUsersAcrossReplicaSetStub = sandbox
        .stub()
        .resolves(retrieveClockStatusesForUsersAcrossReplicaSetResp)
    }
    if (!computeUserSecondarySyncSuccessRatesMapStub) {
      computeUserSecondarySyncSuccessRatesMapStub = sandbox
        .stub()
        .resolves(userSecondarySyncSuccessRatesMap)
    }
    if (!getCNodeEndpointToSpIdMapStub) {
      getCNodeEndpointToSpIdMapStub = sandbox
        .stub()
        .returns(cNodeEndpointToSpIdMap)
    }

    // Make monitorState.jobProcessor.js's imports return our stubs
    return proxyquire(
      '../src/services/stateMachineManager/stateMonitoring/monitorState.jobProcessor.js',
      {
        '../../../config': config,
        './stateMonitoringUtils': {
          getNodeUsers: getNodeUsersStub,
          buildReplicaSetNodesToUserWalletsMap:
            buildReplicaSetNodesToUserWalletsMapStub,
          computeUserSecondarySyncSuccessRatesMap:
            computeUserSecondarySyncSuccessRatesMapStub
        },
        '../CNodeHealthManager': {
          getUnhealthyPeers: getUnhealthyPeersStub
        },
        '../CNodeToSpIdMapManager': {
          getCNodeEndpointToSpIdMap: getCNodeEndpointToSpIdMapStub
        },
        '../stateMachineUtils': {
          retrieveClockStatusesForUsersAcrossReplicaSet:
            retrieveClockStatusesForUsersAcrossReplicaSetStub
        }
      }
    )
  }

  // Return the promise created from running processStateMonitoringJob with the given params
  // and with each step mocked to the given steps (or default mocked steps above)
  function processStateMonitoringJob({
    lastProcessedUserId = LAST_PROCESSED_USER_ID,
    discoveryNodeEndpoint = DISCOVERY_NODE_ENDPOINT,
    contentNodeEndpoint = CONTENT_NODE_ENDPOINT,
    numUsersToProcess = NUM_USERS_TO_PROCESS,
    steps = {}
  }) {
    config.set('creatorNodeEndpoint', contentNodeEndpoint)
    config.set('snapbackUsersPerJob', numUsersToProcess)
    const jobFunc = makeProcessStateMonitoringJob({ ...steps })
    logger = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub()
    }
    return jobFunc({ logger, lastProcessedUserId, discoveryNodeEndpoint })
  }

  function verifyJobResult({
    jobResult,
    lastProcessedUserId,
    users = USERS,
    unhealthyPeers = UNHEALTHY_PEERS,
    replicaSetNodesToUserClockStatusesMap = REPLICAS_TO_USER_CLOCK_STATUS_MAP,
    userSecondarySyncMetricsMap = USER_SECONDARY_SYNC_SUCCESS_RATES_MAP
  }) {
    const monitorJobs = jobResult.jobsToEnqueue[QUEUE_NAMES.STATE_MONITORING]

    // Verify that there are 3 jobs all being added to the state monitoring queue
    expect(monitorJobs).to.have.lengthOf(3)

    // Verify jobResult enqueues the correct monitorState job starting at the expected userId
    expect(monitorJobs).to.deep.include({
      jobName: JOB_NAMES.MONITOR_STATE,
      jobData: {
        lastProcessedUserId,
        discoveryNodeEndpoint: DISCOVERY_NODE_ENDPOINT
      }
    })
    // Verify jobResult enqueues the correct findSyncRequests job
    expect(monitorJobs).to.deep.include({
      jobName: JOB_NAMES.FIND_SYNC_REQUESTS,
      jobData: {
        users,
        unhealthyPeers: Array.from(unhealthyPeers),
        replicaSetNodesToUserClockStatusesMap,
        userSecondarySyncMetricsMap
      }
    })
    // Verify jobResult enqueues the correct findReplicaSetUpdates job
    expect(monitorJobs).to.deep.include({
      jobName: JOB_NAMES.FIND_REPLICA_SET_UPDATES,
      jobData: {
        users,
        unhealthyPeers: Array.from(unhealthyPeers),
        replicaSetNodesToUserClockStatusesMap,
        userSecondarySyncMetricsMap
      }
    })
  }

  it('should process the correct number of users and resolve successfully', async function () {
    // Set constants and generate the users to process
    const lastProcessedUserId = 200
    const numUsersToProcess = 100
    const users = []
    _.range(
      lastProcessedUserId,
      lastProcessedUserId + numUsersToProcess
    ).forEach((userId) => {
      users.push({
        user_id: userId,
        wallet: `wallet${userId}`,
        primary: 'http://cn1.co',
        secondary1: 'http://cn2.co',
        secondary2: 'http://cn3.co',
        primarySpID: 1,
        secondary1SpID: 2,
        secondary2SpID: 3
      })
    })

    // Verify that the state monitoring job processed `usersToProcess` users
    const jobResult = await processStateMonitoringJob({
      lastProcessedUserId,
      numUsersToProcess,
      steps: { users }
    })
    verifyJobResult({
      jobResult,
      lastProcessedUserId: lastProcessedUserId + numUsersToProcess - 1,
      users
    })
  })

  it('should loop back to userId 0 when getNodeUsers returns empty', async function () {
    // Call processStateMonitoringJob with each step succeeding and getNodeUsers returning an empty array
    const jobResult = await processStateMonitoringJob({
      steps: { users: [] }
    })

    // Verify that the job succeeds and returns userId=0 as the last processed user
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    verifyJobResult({
      jobResult,
      lastProcessedUserId: 0,
      users: []
    })
  })

  it('should call the steps and return state data for users slice without throwing', async function () {
    // Run processStateMonitoringJob with each step succeeding
    const jobResult = await processStateMonitoringJob({})

    // Verify that each step was called with the expected params
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    expect(getUnhealthyPeersStub).to.have.been.calledOnceWithExactly(USERS)
    expect(
      buildReplicaSetNodesToUserWalletsMapStub
    ).to.have.been.calledOnceWithExactly(USERS)
    expect(
      retrieveClockStatusesForUsersAcrossReplicaSetStub
    ).to.have.been.calledOnceWithExactly(REPLICA_SET_NODES_TO_USER_WALLETS_MAP)
    expect(
      computeUserSecondarySyncSuccessRatesMapStub
    ).to.have.been.calledOnceWithExactly(USERS)
    verifyJobResult({
      jobResult,
      lastProcessedUserId: USER_ID
    })
  })

  it('should return without throwing when computeUserSecondarySyncSuccessRatesMap throws an error', async function () {
    // Run processStateMonitoringJob with each step succeeding except computeUserSecondarySyncSuccessRatesMapStub
    computeUserSecondarySyncSuccessRatesMapStub = sandbox
      .stub()
      .rejects('test unexpected error')
    const jobResult = await processStateMonitoringJob({})

    // Verify that computeUserSecondarySyncSuccessRatesMapStub fails and steps before it succeed
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    expect(getUnhealthyPeersStub).to.have.been.calledOnceWithExactly(USERS)
    expect(
      buildReplicaSetNodesToUserWalletsMapStub
    ).to.have.been.calledOnceWithExactly(USERS)
    expect(
      retrieveClockStatusesForUsersAcrossReplicaSetStub
    ).to.have.been.calledOnceWithExactly(REPLICA_SET_NODES_TO_USER_WALLETS_MAP)
    expect(
      computeUserSecondarySyncSuccessRatesMapStub
    ).to.have.been.calledOnceWithExactly(USERS)
    verifyJobResult({
      jobResult,
      lastProcessedUserId: USER_ID,
      userSecondarySyncMetricsMap: {}
    })
  })

  it('should return without throwing when retrieveClockStatusesForUsersAcrossReplicaSet throws an error', async function () {
    // Run processStateMonitoringJob with each step succeeding except retrieveClockStatusesForUsersAcrossReplicaSetStub
    retrieveClockStatusesForUsersAcrossReplicaSetStub = sandbox
      .stub()
      .rejects('test unexpected error')
    const jobResult = await processStateMonitoringJob({})

    // Verify that retrieveClockStatusesForUsersAcrossReplicaSetStub fails and other steps succeed
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    expect(getUnhealthyPeersStub).to.have.been.calledOnceWithExactly(USERS)
    expect(
      buildReplicaSetNodesToUserWalletsMapStub
    ).to.have.been.calledOnceWithExactly(USERS)
    expect(
      retrieveClockStatusesForUsersAcrossReplicaSetStub
    ).to.have.been.calledOnceWithExactly(REPLICA_SET_NODES_TO_USER_WALLETS_MAP)
    expect(computeUserSecondarySyncSuccessRatesMapStub).to.not.have.been.called
    verifyJobResult({
      jobResult,
      lastProcessedUserId: USER_ID,
      replicaSetNodesToUserClockStatusesMap: {},
      userSecondarySyncMetricsMap: {}
    })
  })

  it('should return without throwing when buildReplicaSetNodesToUserWalletsMap throws an error', async function () {
    // Run processStateMonitoringJob with each step succeeding except buildReplicaSetNodesToUserWalletsMapStub
    buildReplicaSetNodesToUserWalletsMapStub = sandbox
      .stub()
      .throws('test unexpected error')
    const jobResult = await processStateMonitoringJob({})

    // Verify that buildReplicaSetNodesToUserWalletsMapStub fails and other steps succeed
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    expect(getUnhealthyPeersStub).to.have.been.calledOnceWithExactly(USERS)
    expect(
      buildReplicaSetNodesToUserWalletsMapStub
    ).to.have.been.calledOnceWithExactly(USERS)
    expect(retrieveClockStatusesForUsersAcrossReplicaSetStub).to.not.have.been
      .called
    expect(computeUserSecondarySyncSuccessRatesMapStub).to.not.have.been.called
    verifyJobResult({
      jobResult,
      lastProcessedUserId: USER_ID,
      replicaSetNodesToUserClockStatusesMap: {},
      userSecondarySyncMetricsMap: {}
    })
  })

  it('should return without throwing when getUnhealthyPeers throws an error', async function () {
    // Run processStateMonitoringJob with each step succeeding except getUnhealthyPeers
    getUnhealthyPeersStub = sandbox.stub().rejects('test unexpected error')
    const jobResult = await processStateMonitoringJob({})

    // Verify that each step was called with the expected params
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    expect(getUnhealthyPeersStub).to.have.been.calledOnceWithExactly(USERS)
    expect(buildReplicaSetNodesToUserWalletsMapStub).to.not.have.been.called
    expect(retrieveClockStatusesForUsersAcrossReplicaSetStub).to.not.have.been
      .called
    expect(computeUserSecondarySyncSuccessRatesMapStub).to.not.have.been.called
    verifyJobResult({
      jobResult,
      lastProcessedUserId: USER_ID,
      unhealthyPeers: new Set(),
      replicaSetNodesToUserClockStatusesMap: {},
      userSecondarySyncMetricsMap: {}
    })
  })

  it('should return without throwing when getNodeUsers throws an error', async function () {
    // Run processStateMonitoringJob with each step succeeding except getNodeUsers
    getNodeUsersStub = sandbox.stub().rejects('test unexpected error')
    const jobResult = await processStateMonitoringJob({})

    // Verify that each step was called with the expected params
    expect(getNodeUsersStub).to.have.been.calledOnceWithExactly(
      DISCOVERY_NODE_ENDPOINT,
      CONTENT_NODE_ENDPOINT,
      LAST_PROCESSED_USER_ID,
      NUM_USERS_TO_PROCESS
    )
    expect(getUnhealthyPeersStub).to.not.have.been.called
    expect(buildReplicaSetNodesToUserWalletsMapStub).to.not.have.been.called
    expect(retrieveClockStatusesForUsersAcrossReplicaSetStub).to.not.have.been
      .called
    expect(computeUserSecondarySyncSuccessRatesMapStub).to.not.have.been.called
    verifyJobResult({
      jobResult,
      lastProcessedUserId: LAST_PROCESSED_USER_ID,
      users: [{ user_id: LAST_PROCESSED_USER_ID }],
      unhealthyPeers: new Set(),
      replicaSetNodesToUserClockStatusesMap: {},
      userSecondarySyncMetricsMap: {}
    })
  })
})
