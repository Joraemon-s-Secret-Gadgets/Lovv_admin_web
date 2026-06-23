import type { AdminRole } from './types'

// UI gating only. The browser does NOT verify the token signature; the backend
// re-checks roles on every request. Decoding here just lets the console show the
// correct tabs/actions for whoever the access token belongs to.

const KNOWN_ROLES: AdminRole[] = ['R-ADMIN', 'R-DATA-PROVIDER', 'R-LOCAL-OPERATOR']
// Highest-authority role wins when a token carries several.
const ROLE_PRIORITY: AdminRole[] = ['R-ADMIN', 'R-DATA-PROVIDER', 'R-LOCAL-OPERATOR']

// localStorage key for the cached admin access token. The token is restored from
// /api/v1/auth/session on first load and kept here so a page refresh does not
// require re-hitting the session endpoint.
const SESSION_ACCESS_TOKEN_KEY = 'lovv.admin.accessToken'

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.length % 4 === 0 ? base64 : base64 + '='.repeat(4 - (base64.length % 4))
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function isAdminRole(value: string): value is AdminRole {
  return (KNOWN_ROLES as string[]).includes(value)
}

// Extract the roles[] claim from the JWT payload segment (base64url-decoded).
// Returns [] for missing/malformed tokens or unknown roles, so callers fail closed.
export function decodeTokenRoles(token: string | null | undefined): AdminRole[] {
  if (!token) {
    return []
  }
  const parts = token.split('.')
  if (parts.length < 2) {
    return []
  }
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { roles?: unknown }
    const raw = payload.roles
    const list = Array.isArray(raw)
      ? raw
      : typeof raw === 'string'
        ? raw.split(',')
        : []
    const roles = list
      .map((role) => (typeof role === 'string' ? role.trim() : ''))
      .filter(isAdminRole)
    return Array.from(new Set(roles))
  } catch {
    return []
  }
}

// Read/persist/clear the cached access token. Every storage access is guarded so a
// disabled or unavailable localStorage (privacy mode, SSR) degrades to "no token"
// instead of throwing.
export function getStoredAccessToken(storage: Storage | undefined = globalThis.localStorage): string {
  try {
    return storage?.getItem(SESSION_ACCESS_TOKEN_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function storeAccessToken(token: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SESSION_ACCESS_TOKEN_KEY, token)
  } catch {
    // Ignore storage failures; the in-memory token still drives this session.
  }
}

export function clearAccessToken(storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.removeItem(SESSION_ACCESS_TOKEN_KEY)
  } catch {
    // Ignore storage failures; logout still clears the in-memory token.
  }
}

// Resolve the roles that drive UI gating. Precedence: an explicitly supplied token
// (the live restored session), then the cached token, then the Vite dev token.
export function getSessionRoles(token?: string | null): AdminRole[] {
  const resolved =
    token?.trim() ||
    getStoredAccessToken() ||
    import.meta.env.VITE_LOVV_ADMIN_ACCESS_TOKEN?.trim() ||
    ''
  return decodeTokenRoles(resolved)
}

// Choose the single highest-authority role to drive the default tab and gating.
export function resolvePrimaryRole(roles: AdminRole[]): AdminRole | null {
  for (const role of ROLE_PRIORITY) {
    if (roles.includes(role)) {
      return role
    }
  }
  return null
}
