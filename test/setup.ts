import { env } from 'cloudflare:test';
import migrationSql from '../migrations/0001_initial.sql?raw';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const statements = migrationSql
    .trim()
    .split(/;\s*(?=CREATE)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
});
