import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(new URL('./migrations', import.meta.url).pathname);
  return {
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      poolOptions: {
        workers: {
          wrangler: {
            configPath: './wrangler.toml',
          },
          miniflare: {
            bindings: { TEST_MIGRATIONS: migrations, GOOGLE_PLACES_API_KEY: 'test-key' },
          },
        },
      },
    },
  };
});
