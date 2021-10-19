import { JSONResponse, notFound } from './utils/json-response.js'
import { parseCid } from './utils/parse-cid.js'

/**
 * Returns pin and deal status info for a given CID.
 *
 * @see {@link ../test/fixtures/status.json|Example response}
 * @param {Request} request
 * @param {import('./env').Env} env
 * @returns {Response}
 */
export async function statusGet (request, env) {
  const cid = request.params.cid
  const normalizedCid = parseCid(cid)
  console.log('normalized', normalizedCid)
  const res = await env.db.getStatus(normalizedCid)

  if (!res) {
    return notFound()
  }

  // replace content cid for normalized cid in response
  res.cid = cid

  return new JSONResponse(res)
}
