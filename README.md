# Cookup

Cookup is a small, unlisted restaurant and place saver. Each list is
reachable through a random URL, with personal tags and notes for finding saved
places again.

The project will run as a Cloudflare Worker with a Hono API, Cloudflare D1,
and a Vite/React frontend served from Workers Static Assets.

## Development

Phase 1 development setup is being built from the approved plan in
`/home/ubuntu/cookup-plan.md`. Once the application scaffolding is in place:

```sh
pnpm install
pnpm dev
```

See the project scripts and `wrangler.toml` for local D1 and deployment
commands.
