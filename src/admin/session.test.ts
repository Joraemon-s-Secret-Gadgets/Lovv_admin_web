import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAccessToken,
  decodeTokenRoles,
  getSessionRoles,
  getStoredAccessToken,
  resolvePrimaryRole,
  storeAccessToken,
} from './session'

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


describe('session access-token storage', () => {
  afterEach(() => {
    clearAccessToken()
    vi.unstubAllEnvs()
  })

  it('round-trips the access token in memory', () => {
    expect(getStoredAccessToken()).toBe('')
    storeAccessToken('header.payload.sig')
    expect(getStoredAccessToken()).toBe('header.payload.sig')
    clearAccessToken()
    expect(getStoredAccessToken()).toBe('')
  })

})

describe('getSessionRoles precedence', () => {
  beforeEach(() => {
    clearAccessToken()
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    clearAccessToken()
    vi.unstubAllEnvs()
  })

  it('prefers an explicitly supplied token over the stored and dev tokens', () => {
    storeAccessToken(makeToken({ roles: ['R-DATA-PROVIDER'] }))
    vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', makeToken({ roles: ['R-LOCAL-OPERATOR'] }))
    expect(getSessionRoles(makeToken({ roles: ['R-ADMIN'] }))).toEqual(['R-ADMIN'])
  })

  it('falls back to the stored token, then the dev token', () => {
    storeAccessToken(makeToken({ roles: ['R-DATA-PROVIDER'] }))
    expect(getSessionRoles()).toEqual(['R-DATA-PROVIDER'])
    clearAccessToken()
    vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', makeToken({ roles: ['R-ADMIN'] }))
    expect(getSessionRoles()).toEqual(['R-ADMIN'])
  })

  it('returns no roles when no token is available anywhere', () => {
    vi.stubEnv('VITE_LOVV_ADMIN_ACCESS_TOKEN', '')
    expect(getSessionRoles()).toEqual([])
  })
})
