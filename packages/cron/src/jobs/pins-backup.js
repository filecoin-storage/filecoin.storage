import { Upload } from '@aws-sdk/lib-storage'
import * as pb from '@ipld/dag-pb'
import AWS from 'aws-sdk'
import debug from 'debug'
import formatNumber from 'format-number'
import batch from 'it-batch'
import { pipe } from 'it-pipe'
import { CID } from 'multiformats'
import * as raw from 'multiformats/codecs/raw'
import { Readable } from 'stream'

const UPDATE_BACKUP_URL = `UPDATE psa_pin_request SET (backup_urls) VALUES ($1)
      WHERE id = $2 AND content_cid = $3`

/**
 * @param {import('pg').Client} db
 */
export function registerBackup (db, contentCid, rowId) {
  /**
   * @param {AsyncIterable<import('./bindings').RemoteBackup} source
   */
  return async function (source) {
    for await (const bak of source) {
      await db.query(UPDATE_BACKUP_URL, [bak.backupUrl.toString(), rowId, contentCid])
      log(`saved backup record for upload ${bak.uploadId}: ${bak.backupUrl}`)
    }
  }
}

/**
 * @param {import('@aws-sdk/client-s3').S3Client} s3
 * @param {string} bucketName
 */
export function uploadCar (s3, bucketName) {
  /**
   * @param {AsyncIterable<import('./bindings').BackupContent} source
   */
  return async function * (source) {
    for await (const bak of source) {
      const backupUrl = await s3Upload(s3, bucketName, bak)
      /** @type {import('./bindings').RemoteBackup} */
      const backup = { ...bak, backupUrl }
      yield backup
    }
  }
}

/**
 * @param {import('@aws-sdk/client-s3').S3Client} s3
 * @param {string} bucketName
 * @param {import('./bindings').BackupContent} bak
 */
async function s3Upload (s3, bucketName, bak) {
  const log = debug(`backup:remote:${bak.sourceCid}`)
  const key = `complete/${bak.contentCid}.car`
  const region = await s3.config.region()
  const url = new URL(`https://${bucketName}.s3.${region}.amazonaws.com/${key}`)
  log(`uploading to ${url}`)
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucketName,
      Key: key,
      Body: Readable.from(bak.content),
      Metadata: { structure: 'Complete' }
    }
  })
  await upload.done()
  log('done')
  return url
}

const fmt = formatNumber()

const SIZE_TIMEOUT = 1000 * 10 // timeout if we can't figure out the size in 10s
const BLOCK_TIMEOUT = 1000 * 30 // timeout if we don't receive a block after 30s
const REPORT_INTERVAL = 1000 * 60 // log download progress every minute
const MAX_DAG_SIZE = 1024 * 1024 * 1024 * 32 // don't try to transfer a DAG that's bigger than 32GB

/**
 * @param {() => Promise<import('ipfs-core').IPFS>} getIpfs
 * @param {Object} [options]
 * @param {number} [options.maxDagSize] Skip DAGs that are bigger than this.
 */
export function exportCar (ipfs, options = {}) {
  /**
   * @param {AsyncIterable<import('./bindings').BackupCandidate>} source
   * @returns {AsyncIterableIterator<import('./bindings').BackupContent>}
   */
  return async function * (source) {
    for await (const candidate of source) {
      yield { ...candidate, content: ipfsDagExport(ipfs, candidate.sourceCid, options) }
    }
  }
}

/**
 * Export a CAR for the passed CID.
 *
 * @param {import('./ipfs-client').IpfsClient} ipfs
 * @param {import('multiformats').CID} cid
 * @param {Object} [options]
 * @param {number} [options.maxDagSize]
 */
async function * ipfsDagExport (ipfs, cid, options) {
  const log = debug(`backup:export:${cid}`)
  const maxDagSize = options.maxDagSize || MAX_DAG_SIZE

  let reportInterval
  try {
    log('determining size...')
    let bytesReceived = 0
    const bytesTotal = await getSize(ipfs, cid)
    log(bytesTotal == null ? 'unknown size' : `size: ${fmt(bytesTotal)} bytes`)

    if (bytesTotal != null && bytesTotal > maxDagSize) {
      throw Object.assign(
        new Error(`DAG too big: ${fmt(bytesTotal)} > ${fmt(maxDagSize)}`),
        { code: 'ERR_TOO_BIG' }
      )
    }

    reportInterval = setInterval(() => {
      const formattedTotal = bytesTotal ? fmt(bytesTotal) : 'unknown'
      log(`received ${fmt(bytesReceived)} of ${formattedTotal} bytes`)
    }, REPORT_INTERVAL)

    for await (const chunk of ipfs.dagExport(cid, { timeout: BLOCK_TIMEOUT })) {
      bytesReceived += chunk.byteLength
      yield chunk
    }

    log('done')
  } finally {
    clearInterval(reportInterval)
  }
}

/**
 * @param {import('./ipfs-client').IpfsClient} ipfs
 * @param {import('multiformats').CID} cid
 * @returns {Promise<number | undefined>}
 */
async function getSize (ipfs, cid) {
  if (cid.code === raw.code) {
    const block = await ipfs.blockGet(cid, { timeout: SIZE_TIMEOUT })
    return block.byteLength
  } else if (cid.code === pb.code) {
    const stat = await ipfs.objectStat(cid, { timeout: SIZE_TIMEOUT })
    return stat.CumulativeSize
  }
}

const log = debug('backup:pins')
const LIMIT = process.env.QUERY_LIMIT ?? 10000

/**
 * Fetch a list of CIDs that need to be backed up.
 *
 * @param {import('pg').Client} db Postgres client.
 * @param {Object} [options]
 * @param {Date} [options.startDate]
 * @param {(cid: CID) => Promise<boolean>} [options.filter]
 */
export async function * getPinsNotBackedUp (db, options = {}) {
  const { rows } = await db.query(GET_PINNED_PINS_QUERY, [
    LIMIT
  ])
  if (!rows.length) return
  const uploads = rows.filter(r => !r.url)

  for (const [, upload] of uploads.entries()) {
    const sourceCid = CID.parse(upload.source_cid)
    const pin = {
      sourceCid,
      contentCid: CID.parse(upload.content_cid),
      userId: String(upload.user_id),
      uploadId: String(upload.id)
    }
    yield pin
  }
}

// TODO: Cast id to string
const GET_PINNED_PINS_QUERY = `
  SELECT *
  FROM psa_pin_request psa
    JOIN pin p ON p.content_cid = psa.content_cid
  WHERE p.status = 'Pinned'
    AND psa.backup_urls IS NULL
  LIMIT $1
`

const s3 = new AWS.S3({})
const CONCURRENCY = 10

/**
 * This job grabs 10,000 pins which do not have a backup URL and sends them to S3 and updates the record with the S3 URL
 * @param {{ env: NodeJS.ProcessEnv, rwPg: Client, roPg: Client, cluster: import('@nftstorage/ipfs-cluster').Cluster }} config
 */
export async function backupPins ({ env, roPg, rwPg, cluster, concurrency = CONCURRENCY }) {
  if (!log.enabled) {
    console.log('ℹ️ Enable logging by setting DEBUG=pins:backupPins')
  }

  let totalProcessed = 0
  let totalSuccessful = 0

  await pipe(getPinsNotBackedUp(roPg), async (source) => {
    for await (const pins of batch(source, concurrency)) {
      await Promise.all(pins.map(async pin => {
        log(`processing pin ${JSON.stringify(pin)}`)
        try {
          await pipe(
            [pin],
            exportCar(cluster),
            uploadCar(s3, env.s3PickupBucketName),
            registerBackup(rwPg, pin.content_cid, pin.id)
          )
          totalSuccessful++
        } catch (err) {
          log(`failed to backup ${pin.sourceCid}`, err)
        }
      }))
      totalProcessed++
      log(`processed ${totalSuccessful} of ${totalProcessed} CIDs successfully`)
    }
  })
  log('backup complete 🎉')
}