import { describe, expect, it } from 'vitest'
import { decodeTokenRoles, resolvePrimaryRole } from './session'

function base64url(input: string) {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeToken(payload: Record<string, unknown>) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  return `${header}.${body}.signature`
}

describe('session role decoding', () => {
  it('extracts known admin roles from a token payload array', () => {
    const token = makeToken({ sub: 'u1', roles: ['R-ADMIN', 'R-USER'] })
    expect(decodeTokenRoles(token)).toEqual(['R-ADMIN'])
  })

  it('supports comma-separated role strings', () => {
    const token = makeToken({ sub: 'u1', roles: 'R-DATA-PROVIDER,R-LOCAL-OPERATOR' })
    expect(decodeTokenRoles(token)).toEqual(['R-DATA-PROVIDER', 'R-LOCAL-OPERATOR'])
  })

  it('returns no roles for empty, malformed, or unknown-role tokens', () => {
    expect(decodeTokenRoles(undefined)).toEqual([])
    expect(decodeTokenRoles('')).toEqual([])
    expect(decodeTokenRoles('not-a-jwt')).toEqual([])
    expect(decodeTokenRoles(makeToken({ sub: 'u1', roles: ['R-USER'] }))).toEqual([])
  })

  it('resolves the highest-authority role first', () => {
    expect(resolvePrimaryRole(['R-LOCAL-OPERATOR', 'R-ADMIN'])).toBe('R-ADMIN')
    expect(resolvePrimaryRole(['R-DATA-PROVIDER', 'R-LOCAL-OPERATOR'])).toBe('R-DATA-PROVIDER')
    expect(resolvePrimaryRole([])).toBeNull()
  })
})
