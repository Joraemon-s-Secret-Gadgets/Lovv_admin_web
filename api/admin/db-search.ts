import { handleDbSearchRequest } from '../../src/server/dbSearch'

type ServerGlobal = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>
  }
}

function getServerEnv() {
  return (globalThis as ServerGlobal).process?.env ?? {}
}

export default {
  fetch(request: Request) {
    const env = getServerEnv()

    return handleDbSearchRequest(request, {
      currentRole: undefined,
      featureEnabled: env.ADMIN_DB_SEARCH_ENABLED === 'true',
    })
  },
}
