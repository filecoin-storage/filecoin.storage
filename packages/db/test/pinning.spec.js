/* eslint-env mocha, browser */
import assert from 'assert'
import { DBClient } from '../index'
import { createUpload, createUser, createUserAuthKey, token } from './utils.js'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as pb from '@ipld/dag-pb'
import { normalizeCid } from '../../api/src/utils/normalize-cid'
/* global crypto */

const pinRequestTable = 'pa_pin_request'

/**
 * @param {number} code
 * @returns {Promise<string>}
 */
async function randomCid (code = pb.code) {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  const hash = await sha256.digest(bytes)
  return CID.create(1, code, hash).toString()
}

/**
 *
 * @param {*} pinRequestOutput
 * @param {object} opt
 * @param {boolean} [opt.withContent]
 */
const assertCorrectPinRequestOutputTypes = (pinRequestOutput, { withContent = true } = {}) => {
  assert.ok(typeof pinRequestOutput._id === 'string', '_id should be a string')
  assert.ok(typeof pinRequestOutput.requestedCid === 'string', 'requestedCid should be a string')
  assert.ok(Array.isArray(pinRequestOutput.pins), 'pin should be an array')
  assert.ok(Date.parse(pinRequestOutput.created), 'created should be valid date string')
  assert.ok(Date.parse(pinRequestOutput.updated), 'updated should be valid date string')

  if (withContent) {
    assert.ok(typeof pinRequestOutput.contentCid === 'string', 'requestedCid should be a string')
  } else {
    assert.ifError(pinRequestOutput.contentCid)
  }
}

describe('Pin Request', () => {
  /** @type {DBClient & {_client}} */
  const client = (new DBClient({
    endpoint: 'http://127.0.0.1:3000',
    token
  }))
  let user
  let authKey
  /**
   * @type {import('../db-client-types').PAPinRequestUpsertInput}
   */
  let aPinRequestInput

  /**
   * @type {import('../db-client-types').PAPinRequestUpsertOutput}
   */
  let aPinRequestOutput

  /**
   * @type {import('../db-client-types').PAPinRequestUpsertInput}
   */
  let aPinRequestInputForExistingContent

  /**
   * @type {import('../db-client-types').PAPinRequestUpsertOutput}
   */
  let aPinRequestOutputForExistingContent

  const cids = [
    'bafybeiczsscdsbs7aaqz55asqdf3smv6klcw3gofszvwlyarci47bgf356',
    'bafybeiczsscdsbs7aaqz55asqdf3smv6klcw3gofszvwlyarci47bgf358'
  ]

  const pins = [
    {
      status: 'Pinning',
      location: {
        peerId: '12D3KooWFe387JFDpgNEVCP5ARut7gRkX7YuJCXMStpkq714ziK6',
        peerName: 'web3-storage-sv15',
        region: 'region'
      }
    },
    {
      status: 'Pinning',
      location: {
        peerId: '12D3KooWFe387JFDpgNEVCP5ARut7gRkX7YuJCXMStpkq714ziK7',
        peerName: 'web3-storage-sv16',
        region: 'region'
      }
    }
  ]

  // Create user and auth key`
  before(async () => {
    user = await createUser(client)
    authKey = await createUserAuthKey(client, user._id)
  })

  // Guarantee no Pin requests exist and create the ones needed for our tests
  before(async () => {
    // Make sure we don't have pinRequest and content
    await client._client.from(pinRequestTable).delete()
    const { count: countR } = await client._client.from(pinRequestTable).select('id', {
      count: 'exact'
    })
    assert.strictEqual(countR, 0, 'There are still requests in the db')

    await createUpload(client, user._id, authKey, cids[1], { pins: pins })

    aPinRequestInput = {
      requestedCid: cids[0],
      authKey
    }

    aPinRequestInputForExistingContent = {
      requestedCid: cids[1],
      authKey
    }

    aPinRequestOutput = await client.createPAPinRequest(aPinRequestInput)
    aPinRequestOutputForExistingContent = await client.createPAPinRequest(aPinRequestInputForExistingContent)
  })

  describe('Create Pin', () => {
    it('it creates a Pin Request', async () => {
      const savedPinRequest = await client.getPAPinRequest(aPinRequestOutput._id)
      assert.ok(savedPinRequest)
    })

    it('it returns the right object', async () => {
      assertCorrectPinRequestOutputTypes(aPinRequestOutput, { withContent: false })
      assert.strictEqual(aPinRequestOutput.requestedCid, cids[0], 'requestedCid is the one provided')
    })

    it('returns no pins if they do not exists', async () => {
      assert.strictEqual(aPinRequestOutput.pins.length, 0)
    })

    it('it returns the right object when it has content associated', async () => {
      assertCorrectPinRequestOutputTypes(aPinRequestOutputForExistingContent)
      assert.strictEqual(aPinRequestOutputForExistingContent.requestedCid, cids[1], 'rrequestedCid is the one provided')
    })

    it('returns a content cid if exists contentCid', async () => {
      assert.strictEqual(aPinRequestOutputForExistingContent.contentCid, cids[1])
    })

    it('returns pins if pins if content exists', async () => {
      // Only checking statuses for simplicity
      const statuses = aPinRequestOutputForExistingContent.pins
        .map((p) => p.status)
      assert.deepStrictEqual(statuses, [pins[0].status, pins[1].status])
    })
  })

  describe('Get Pin', () => {
    let savedPinRequest
    let savedPinRequestForExistingContent

    before(async () => {
      savedPinRequest = await client.getPAPinRequest(aPinRequestOutput._id)
      savedPinRequestForExistingContent = await client.getPAPinRequest(aPinRequestOutputForExistingContent._id)
    })

    it('it creates a Pin Request', async () => {
      assert.ok(savedPinRequest)
    })

    it('it returns the right object', async () => {
      assertCorrectPinRequestOutputTypes(savedPinRequest, { withContent: false })
      assert.strictEqual(savedPinRequest.requestedCid, cids[0], 'requestedCid is the one provided')
    })

    it('returns no pins if they do not exists', async () => {
      assert.strictEqual(savedPinRequest.pins.length, 0)
    })

    it('it returns the right object when it has content associated', async () => {
      assertCorrectPinRequestOutputTypes(savedPinRequestForExistingContent)
      assert.strictEqual(savedPinRequestForExistingContent.requestedCid, cids[1], 'rrequestedCid is the one provided')
    })

    it('returns a content cid if exists contentCid', async () => {
      assert.strictEqual(savedPinRequestForExistingContent.contentCid, cids[1])
    })

    it('returns pins if pins if content exists', async () => {
      // Only checking statuses for simplicity
      const statuses = savedPinRequestForExistingContent.pins
        .map((p) => p.status)
      assert.deepStrictEqual(statuses, [pins[0].status, pins[1].status])
    })

    it('throws if does not exists', async () => {
      assert.rejects(client.getPAPinRequest(1000))
    })
  })

  describe.only('Get Pins', () => {
    const pins = [
      {
        status: 'Pinning',
        location: {
          peerId: '12D3KooWFe387JFDpgNEVCP5ARut7gRkX7YuJCXMStpkq714ziK6',
          peerName: 'web3-storage-sv15',
          region: 'region'
        }
      },
      {
        status: 'Pinning',
        location: {
          peerId: '12D3KooWFe387JFDpgNEVCP5ARut7gRkX7YuJCXMStpkq714ziK7',
          peerName: 'web3-storage-sv16',
          region: 'region'
        }
      }
    ]
    let pinRequestsInputs

    let userPinList
    let authKeyPinList
    let createdPinningRequests
    let cidWithContent
    let normalizeCidWithContent

    before(async () => {
      userPinList = await createUser(client)
      authKeyPinList = await createUserAuthKey(client, userPinList._id)
    })

    before(async () => {
      cidWithContent = await randomCid()
      normalizeCidWithContent = normalizeCid(cidWithContent)
      await createUpload(client, userPinList._id, authKeyPinList, normalizeCidWithContent, { pins: pins })
      pinRequestsInputs = [
        {
          name: 'horse',
          date: [2020, 0, 1],
          requestedCid: cidWithContent,
          cid: normalizeCidWithContent
        }, {
          name: 'capybara',
          date: [2020, 1, 1]
        }, {
          name: 'Camel',
          date: [2020, 2, 1]
        }, {
          name: 'Giant Panda Bear',
          date: [2020, 3, 1]
        }, {
          name: 'giant Schnoodle',
          date: [2020, 4, 1]
        }, {
          name: 'giant worm',
          date: [2020, 5, 1]
        }, {
          name: 'Zonkey Schnoodle',
          date: [2020, 6, 1]
        }, {
          name: 'Zorse',
          date: [2020, 7, 1]
        }, {
          date: [2020, 8, 1]
        }, {
          name: '',
          date: [2020, 9, 1]
        }, {
          name: 'Bear',
          date: [2020, 10, 1]
        }
      ]
      createdPinningRequests = await Promise.all(pinRequestsInputs.map(async (item) => {
        const requestedCid = item.requestedCid || await randomCid()
        const normalizedCid = item.cid || normalizeCid(requestedCid)

        return client.createPAPinRequest({
          ...(item.name) && { name: item.name },
          authKey: authKeyPinList,
          requestedCid: requestedCid,
          cid: normalizedCid
        })
      }))
    })

    it('it limits the results to 10', async () => {
      const prs = await client.listPAPinRequests(authKeyPinList)
      assert.strictEqual(prs.length, 10)
    })

    it('it limits the results to the provided limit', async () => {
      const limit = 8
      const prs = await client.listPAPinRequests(authKeyPinList, {
        limit
      })
      assert.strictEqual(prs.length, limit)
    })

    it('it returns only requests for the provided token', async () => {
      const prs = await client.listPAPinRequests('10')
      assert.strictEqual(prs.length, 0)
    })

    it('it sorts by date', async () => {
      const prs = await client.listPAPinRequests(authKeyPinList)

      const sorted = prs.reduce((n, item) => n !== false && item.created <= n.created && item)
      assert(sorted)
    })

    it.skip('it filters items by provided status', async () => {
      // TODO: status filtering is currently not working
      const prs = await client.listPAPinRequests(authKeyPinList, {
        status: ['Pinning']
      })

      assert.strictEqual(prs.length, 1)
      assert.strictEqual(createdPinningRequests._id, prs[0]._id)
    })

    it('it filters items by provided cid', async () => {
      const cids = [createdPinningRequests[0].requestedCid, createdPinningRequests[1].requestedCid]
      const prs = await client.listPAPinRequests(authKeyPinList, {
        cid: cids
      })

      assert.strictEqual(prs.length, 2)
      assert(prs.map(p => p.requestedCid).includes(cids[0]))
      assert(prs.map(p => p.requestedCid).includes(cids[1]))
    })

    it('it filters items by exact match by default', async () => {
      const name = 'capybara'
      const prs = await client.listPAPinRequests(authKeyPinList, {
        name
      })

      assert.strictEqual(prs.length, 1)
      prs.forEach(pr => {
        assert.strictEqual(pr.name, name)
      })
    })

    it('it filters items by iexact match', async () => {
      const name = 'camel'
      const prs = await client.listPAPinRequests(authKeyPinList, {
        name,
        match: 'iexact'
      })

      assert.strictEqual(prs.length, 1)
      prs.forEach(pr => {
        assert.strictEqual(pr.name.toLowerCase(), name.toLowerCase())
      })
    })

    it('it filters items by partial match', async () => {
      const name = 'giant'
      const prs = await client.listPAPinRequests(authKeyPinList, {
        name,
        match: 'partial'
      })

      assert.strictEqual(prs.length, 2)
      prs.forEach(pr => {
        assert(pr.name.includes(name))
      })
    })

    it('it filters items by ipartial match', async () => {
      const name = 'giant'
      const prs = await client.listPAPinRequests(authKeyPinList, {
        name,
        match: 'ipartial'
      })

      assert.strictEqual(prs.length, 3)
      prs.forEach(pr => {
        assert(pr.name.toLowerCase().includes(name.toLowerCase()))
      })
    })
  })
})
