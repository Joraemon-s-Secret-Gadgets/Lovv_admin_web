import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.ts',
    // Keep tests independent of any local .env (API base URL / dev token).
    // Per-test session role is injected with vi.stubEnv where needed.
    env: {
      VITE_LOVV_API_BASE_URL: '',
      VITE_LOVV_ADMIN_ACCESS_TOKEN: '',
    },
  },
})
