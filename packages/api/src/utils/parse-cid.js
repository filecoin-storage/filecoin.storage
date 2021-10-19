import { CID } from 'multiformats/cid'
import { InvalidCidError } from '../errors.js'

/**
 * Parse CID and return v1 and original
 *
 * @param {string} cid
 */
export function parseCid (cid) {
  try {
    const c = CID.parse(cid)
    return c.toV1().toString()
  } catch (err) {
    throw new InvalidCidError(cid)
  }
}
