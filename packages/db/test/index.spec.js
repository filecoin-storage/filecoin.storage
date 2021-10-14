/* eslint-env mocha, browser */
import assert from 'assert'
import { DBClient } from '../index'

describe('db', () => {
  it('can create postgres client', () => {
    const dbClient = new DBClient({
      endpoint: 'http://127.0.0.1:3000',
      token: 'super-secret-jwt-token-with-at-least-32-characters-long',
      postgres: true
    })

    assert(dbClient._client, 'postgres client created')
    assert.strictEqual(dbClient._isPostgres, true, 'postgres running')
  })

  it('can create fauna client', () => {
    const dbClient = new DBClient({
      token: 'super-secret-jwt-token-with-at-least-32-characters-long'
    })

    assert(dbClient._client, 'fauna client created')
    assert.notStrictEqual(dbClient._isPostgres, true, 'fauna running')
  })
})
