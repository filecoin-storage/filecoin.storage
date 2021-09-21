/* eslint-env serviceworker */
import { gql } from '@web3-storage/db'
import { CarBlockIterator } from '@ipld/car'
import { Block } from 'multiformats/block'
import * as raw from 'multiformats/codecs/raw'
import * as cbor from '@ipld/dag-cbor'
import * as pb from '@ipld/dag-pb'
import retry from 'p-retry'
import { GATEWAY, LOCAL_ADD_THRESHOLD, MAX_BLOCK_SIZE } from './constants.js'
import { JSONResponse } from './utils/json-response.js'
import { toPinStatusEnum } from './utils/pin.js'

const decoders = [pb, raw, cbor]

const CREATE_UPLOAD = gql`
  mutation CreateUpload($data: CreateUploadInput!) {
    createUpload(data: $data) {
      content {
        _id
        dagSize
      }
    }
  }
`

const CREATE_OR_UPDATE_PIN = gql`
  mutation CreateOrUpdatePin($data: CreateOrUpdatePinInput!) {
    createOrUpdatePin(data: $data) {
      _id
    }
  }
`

const INCREMENT_USER_USED_STORAGE = gql`
  mutation IncrementUserUsedStorage($user: ID!, $amount: Long!) {
    incrementUserUsedStorage(user: $user, amount: $amount) {
      usedStorage
    }
  }
`

// Duration between status check polls in ms.
const PIN_STATUS_CHECK_INTERVAL = 5000
// Max time in ms to spend polling for an OK status.
const MAX_PIN_STATUS_CHECK_TIME = 30000
// Pin statuses considered OK.
const PIN_OK_STATUS = ['Pinned', 'Pinning', 'PinQueued']
// Times to retry the transaction after the first failure.
const CREATE_UPLOAD_RETRIES = 4
// Time in ms before starting the first retry.
const CREATE_UPLOAD_MAX_TIMEOUT = 100

/**
 * TODO: ipfs should let us ask the size of a CAR file.
 * This consumes the CAR response from ipfs to find the content-length.
 *
 * @param {Request} request
 * @param {import('./env').Env} env
 * @param {import('./index').Ctx} ctx
 */
export async function carHead (request, env, ctx) {
  // cache the thing. can't cache a HEAD request, so make a new one.
  const get = new Request(request.url, { method: 'GET' })
  // add the router params
  get.params = request.params
  const res = await carGet(get, env, ctx)
  const size = await sizeOf(res)
  const headers = new Headers(res.headers)
  headers.set('Content-Length', size)
  // skip the body, it's a HEAD.
  return new Response(null, { headers })
}

/**
 * @param {Request} request
 * @param {import('./env').Env} env
 * @param {import('./index').Ctx} ctx
 */
export async function carGet (request, env, ctx) {
  const cache = caches.default
  let res = await cache.match(request)

  if (res) {
    return res
  }

  const {
    params: { cid }
  } = request
  // gateway does not support `carversion` yet.
  // using it now means we can skip the cache if it is supported in the future
  const url = new URL(`/api/v0/dag/export?arg=${cid}&carversion=1`, GATEWAY)
  res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    // bail early. dont cache errors.
    return res
  }
  // Clone the response so that it's no longer immutable. Ditch the original headers.
  // Note: keeping the original headers seems to prevent the carHead function from setting Content-Length
  res = new Response(res.body)
  res.headers.set('Content-Type', 'application/car')
  // cache for 1 year, the max max-age value.
  res.headers.set('Cache-Control', 'public, max-age=31536000')
  // without the content-disposition, firefox describes them as DMS files.
  res.headers.set('Content-Disposition', `attachment; filename="${cid}.car"`)
  // always https pls.
  res.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload"')
  // // compress if asked for? is it worth it?
  // if (request.headers.get('Accept-Encoding').match('gzip')) {
  //   headers['Content-Encoding'] = 'gzip'
  // }
  ctx.waitUntil(cache.put(request, res.clone()))
  return res
}

/**
 * Post a CAR file.
 *
 * @param {import('./user').AuthenticatedRequest} request
 * @param {import('./env').Env} env
 * @param {import('./index').Ctx} ctx
 */
export async function carPost (request, env, ctx) {
  let blob = await request.blob()
  // Ensure car blob.type is set; it is used by the cluster client to set the format=car flag on the /add call.
  blob = blob.slice(0, blob.size, 'application/car')

  return handleCarUpload(request, env, ctx, blob)
}

/**
 * Request handler for a CAR file upload.
 *
 * @param {import('./user').AuthenticatedRequest} request
 * @param {import('./env').Env} env
 * @param {import('./index').Ctx} ctx
 * @param {Blob} car
 * @param {string} [uploadType = 'Car']
 */
export async function handleCarUpload (request, env, ctx, car, uploadType = 'Car') {
  const { user, authToken } = request.auth
  const { headers } = request

  // Throws if CAR is invalid by our standards.
  // Returns either the sum of the block sizes in the CAR, or the cumulative size of the DAG for a dag-pb root.
  const { size: dagSize } = await carStat(car)

  // Note: We can't make use of `bytes` or `size` properties on the response from cluster.add
  // `bytes` is the sum of block sizes in bytes. Where the CAR is a partial, it'll only be a shard of the total dag size.
  // `size` is UnixFS FileSize which is 0 for directories, and is not set for raw encoded files, only dag-pb ones.
  const { cid/*, bytes, size */ } = await env.cluster.add(car, {
    metadata: { size: car.size.toString() },
    // When >2.5MB, use local add, because waiting for blocks to be sent to
    // other cluster nodes can take a long time. Replication to other nodes
    // will be done async by bitswap instead.
    local: car.size > LOCAL_ADD_THRESHOLD
  })

  const { peerMap } = await env.cluster.status(cid)
  const pins = toPins(peerMap)
  if (!pins.length) { // should not happen
    throw new Error('not pinning on any node')
  }

  let name = headers.get('x-name')
  if (!name || typeof name !== 'string') {
    name = `Upload at ${new Date().toISOString()}`
  }

  // Store in DB
  // Retried because it's possible to receive the error:
  // "Transaction was aborted due to detection of concurrent modification."
  const { createUpload: upload } = await retry(() => (
    env.db.query(CREATE_UPLOAD, {
      data: {
        user: user._id,
        authToken: authToken?._id,
        cid,
        name,
        type: uploadType,
        pins,
        dagSize
      }
    })
  ), {
    retries: CREATE_UPLOAD_RETRIES,
    minTimeout: CREATE_UPLOAD_MAX_TIMEOUT
  })

  /** @type {(() => Promise<any>)[]} */
  const tasks = []

  // TODO: this should be handled in the db code as part of the CREATE_UPLOAD
  // Update the user's used storage
  tasks.push(async () => {
    try {
      await env.db.query(INCREMENT_USER_USED_STORAGE, {
        user: user._id,
        amount: dagSize
      })
    } catch (err) {
      console.error(`failed to update user used storage: ${err.stack}`)
    }
  })

  // Retrieve current pin status and info about the nodes pinning the content.
  // Keep querying Cluster until one of the nodes reports something other than
  // Unpinned i.e. PinQueued or Pinning or Pinned.
  if (!pins.some(p => PIN_OK_STATUS.includes(p.status))) {
    tasks.push(async () => {
      const start = Date.now()
      while (Date.now() - start > MAX_PIN_STATUS_CHECK_TIME) {
        await new Promise(resolve => setTimeout(resolve, PIN_STATUS_CHECK_INTERVAL))
        const { peerMap } = await env.cluster.status(cid)
        const pins = toPins(peerMap)
        if (!pins.length) { // should not happen
          throw new Error('not pinning on any node')
        }

        const okPins = pins.filter(p => PIN_OK_STATUS.includes(p.status))
        if (!okPins.length) continue

        for (const pin of okPins) {
          await env.db.query(CREATE_OR_UPDATE_PIN, {
            data: { content: upload.content._id, ...pin }
          })
        }
        return
      }
    })
  }

  if (ctx.waitUntil) {
    tasks.forEach(t => ctx.waitUntil(t()))
  }

  return new JSONResponse({ cid })
}

export async function carPut (request, env, ctx) {
  return new Response(`${request.method} /car no can has`, { status: 501 })
}

export async function sizeOf (response) {
  const reader = response.body.getReader()
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    // this should be ok up to about 9 Petabytes.
    // Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991
    size += value.byteLength
  }
  return size
}

/**
 * Returns the sum of all block sizes and total blocks. Throws if the CAR does
 * not conform to our idea of a valid CAR i.e.
 * - Missing root CIDs
 * - >1 root CID
 * - Any block bigger than MAX_BLOCK_SIZE (1MiB)
 * - 0 blocks
 * - Missing root block
 * - Missing non-root blocks (when root block has links)
 *
 * @typedef {{ size: number, blocks: number }} CarStat
 * @param {Blob} carBlob
 * @returns {Promise<CarStat>}
 */
async function carStat (carBlob) {
  const carBytes = new Uint8Array(await carBlob.arrayBuffer())
  const blocksIterator = await CarBlockIterator.fromBytes(carBytes)
  const roots = await blocksIterator.getRoots()
  if (roots.length === 0) {
    throw new Error('missing roots')
  }
  if (roots.length > 1) {
    throw new Error('too many roots')
  }
  const rootCid = roots[0]
  let rawRootBlock
  let blocks = 0
  let size = 0
  for await (const block of blocksIterator) {
    const blockSize = block.bytes.byteLength
    if (blockSize > MAX_BLOCK_SIZE) {
      throw new Error(`block too big: ${blockSize} > ${MAX_BLOCK_SIZE}`)
    }
    if (!rawRootBlock && block.cid.equals(rootCid)) {
      rawRootBlock = block
    }
    size += blockSize
    blocks++
  }
  if (blocks === 0) {
    throw new Error('empty CAR')
  }
  if (!rawRootBlock) {
    throw new Error('missing root block')
  }
  const decoder = decoders.find(d => d.code === rootCid.code)
  if (decoder) {
    const rootBlock = new Block({ cid: rootCid, bytes: rawRootBlock.bytes, value: decoder.decode(rawRootBlock.bytes) })
    const links = Array.from(rootBlock.links())
    // if the root block has links, then we should have at least 2 blocks in the CAR
    if (blocks === 1 && links.length > 0) {
      throw new Error('CAR must contain at least one non-root block')
    }
    // get the size of the full dag for this root, even if we only have a partial CAR.
    if (rootBlock.cid.code === pb.code) {
      size = cumulativeSize(rootBlock.bytes, rootBlock.value)
    }
  }
  return { size, blocks }
}

/**
 * The sum of the node size and size of each link
 * @param {import('@ipld/dag-pb/src/interface').PBNode} pbNode
 * @returns {number} the size of the DAG in bytes
 */
function cumulativeSize (pbNodeBytes, pbNode) {
  // NOTE: Tsize is optional, but all ipfs implementations we know of set it.
  // It's metadata, that could be missing or deliberately set to an incorrect value.
  // This logic is the same as used by go/js-ipfs to display the cumulative size of a dag-pb dag.
  return pbNodeBytes.length + pbNode.Links.reduce((acc, curr) => acc + (curr.Tsize || 0), 0)
}

/**
 * The sum of the node size and size of each link
 * @param {import('@ipld/dag-pb/src/interface').PBNode} pbNode
 * @returns {number} the size of the DAG in bytes
 */
function cumulativeSize (pbNodeBytes, pbNode) {
  // NOTE: Tsize is optional, but all ipfs implementations we know of set it.
  // It's metadata, that could be missing or deliberately set to an incorrect value.
  // This logic is the same as used by go/js-ipfs to display the cumulative size of a dag-pb dag.
  return pbNodeBytes.length + pbNode.Links.reduce((acc, curr) => acc + (curr.Tsize || 0), 0)
}

/**
 * @param {import('@nftstorage/ipfs-cluster').StatusResponse['peerMap']} peerMap
 */
function toPins (peerMap) {
  return Object.entries(peerMap).map(([peerId, { peerName, status }]) => ({
    status: toPinStatusEnum(status),
    location: { peerId, peerName }
  }))
}
