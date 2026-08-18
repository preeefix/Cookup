import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
};

type List = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  last_seen_at: string;
};

type Variables = {
  list: List;
};

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

type Place = {
  id: string;
  list_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: 'manual';
  notes: string | null;
  created_at: string;
  updated_at: string;
  tags: Tag[];
};

type Tag = {
  id: string;
  list_id: string;
  name: string;
  color: string | null;
  usage_count?: number;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const MAX_PLACES = 500;
const MAX_NOTES_LENGTH = 2000;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

app.use('/api/*', cors());

function now() {
  return new Date().toISOString();
}

function jsonError(c: AppContext, message: string, status: 400 | 404 | 409 | 413 | 422) {
  return c.json({ error: message }, status);
}

function makeSlug() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let slug = '';
  while (value > 0n) {
    slug = BASE58[Number(value % 58n)] + slug;
    value /= 58n;
  }
  return slug.padStart(22, '1');
}

function cleanTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const name = value.trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      tags.push(name);
    }
  }
  return tags;
}

function parseNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeTags(value: unknown): Tag[] {
  if (typeof value !== 'string') return [];
  try {
    return JSON.parse(value) as Tag[];
  } catch {
    return [];
  }
}

function placeFromRow(row: Record<string, unknown>): Place {
  return {
    id: String(row.id),
    list_id: String(row.list_id),
    name: String(row.name),
    address: row.address === null ? null : String(row.address),
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    source: 'manual',
    notes: row.notes === null ? null : String(row.notes),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    tags: decodeTags(row.tags_json),
  };
}

async function getList(db: D1Database, slug: string) {
  return db.prepare('SELECT * FROM lists WHERE slug = ?1 LIMIT 1').bind(slug).first<List>();
}

async function getPlace(db: D1Database, listId: string, placeId: string) {
  const row = await db
    .prepare(
      `SELECT p.*, COALESCE((
        SELECT json_group_array(json_object('id', t.id, 'list_id', t.list_id, 'name', t.name, 'color', t.color))
        FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = p.id
      ), '[]') AS tags_json
      FROM places p WHERE p.id = ?1 AND p.list_id = ?2`,
    )
    .bind(placeId, listId)
    .first<Record<string, unknown>>();
  return row ? placeFromRow(row) : null;
}

async function ensureTags(db: D1Database, listId: string, names: string[]) {
  if (!names.length) return [];
  const existing = await db
    .prepare(
      `SELECT id, list_id, name, color FROM tags
       WHERE list_id = ?1 AND name COLLATE NOCASE IN (${names.map(() => '?').join(',')})`,
    )
    .bind(listId, ...names)
    .all<Tag>();
  const byName = new Map(existing.results.map((tag) => [tag.name.toLocaleLowerCase(), tag]));
  const missing: Tag[] = [];
  for (const name of names) {
    if (!byName.has(name.toLocaleLowerCase())) {
      const tag = { id: crypto.randomUUID(), list_id: listId, name, color: null };
      byName.set(name.toLocaleLowerCase(), tag);
      missing.push(tag);
    }
  }
  if (missing.length) {
    await db.batch(
      missing.map((tag) =>
        db
          .prepare('INSERT INTO tags (id, list_id, name, color) VALUES (?1, ?2, ?3, ?4)')
          .bind(tag.id, tag.list_id, tag.name, tag.color),
      ),
    );
  }
  return names.map((name) => byName.get(name.toLocaleLowerCase()) as Tag);
}

async function resolveList(c: AppContext, next: Next) {
  const slug = c.req.param('slug') ?? '';
  const list = await getList(c.env.DB, slug);
  if (!list) return c.text('Not Found', 404);
  await c.env.DB.prepare('UPDATE lists SET last_seen_at = ?1 WHERE id = ?2')
    .bind(now(), list.id)
    .run();
  c.set('list', list);
  return next();
}

app.use('/api/lists/:slug', async (c, next) => {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return resolveList(c, next);
});
app.use('/api/lists/:slug/*', async (c, next) => {
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  return resolveList(c, next);
});

app.post('/api/lists', async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'My places';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const list = {
      id: crypto.randomUUID(),
      name,
      slug: makeSlug(),
      created_at: now(),
      last_seen_at: now(),
    };
    try {
      await c.env.DB.prepare(
        'INSERT INTO lists (id, name, slug, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
        .bind(list.id, list.name, list.slug, list.created_at, list.last_seen_at)
        .run();
      return c.json({ ...list, url: new URL(`/l/${list.slug}`, c.req.url).toString() }, 201);
    } catch (error) {
      if (attempt === 2 || !String(error).toLowerCase().includes('unique')) throw error;
    }
  }
  return c.text('Unable to create list', 500);
});

app.get('/api/lists/:slug', (c) => c.json(c.get('list')));

app.post('/api/lists/:slug/rotate', async (c) => {
  const list = c.get('list');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = makeSlug();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE lists SET slug = ?1, last_seen_at = ?2 WHERE id = ?3 AND slug = ?4').bind(
          slug,
          now(),
          list.id,
          list.slug,
        ),
      ]);
      return c.json({ slug, url: new URL(`/l/${slug}`, c.req.url).toString() });
    } catch (error) {
      if (attempt === 2 || !String(error).toLowerCase().includes('unique')) throw error;
    }
  }
  return c.text('Unable to rotate slug', 500);
});

app.get('/api/lists/:slug/tags', async (c) => {
  const list = c.get('list');
  const result = await c.env.DB.prepare(
    `SELECT t.id, t.list_id, t.name, t.color, COUNT(pt.place_id) AS usage_count
     FROM tags t LEFT JOIN place_tags pt ON pt.tag_id = t.id
     WHERE t.list_id = ?1 GROUP BY t.id ORDER BY lower(t.name)`,
  )
    .bind(list.id)
    .all<Tag>();
  return c.json(result.results);
});

app.patch('/api/lists/:slug/tags/:id', async (c) => {
  const list = c.get('list');
  const body = await c.req.json<{ name?: unknown; color?: unknown }>().catch(() => ({}) as { name?: unknown; color?: unknown });
  const name = body.name === undefined ? undefined : typeof body.name === 'string' ? body.name.trim() : '';
  const color = body.color === null || body.color === undefined ? body.color : typeof body.color === 'string' ? body.color.trim() : '';
  if (name === '') return jsonError(c, 'Tag name cannot be empty', 422);
  try {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (name !== undefined) {
      fields.push('name = ?');
      values.push(name.slice(0, 80));
    }
    if (color !== undefined) {
      fields.push('color = ?');
      values.push(typeof color === 'string' && color ? color.slice(0, 32) : null);
    }
    if (!fields.length) return jsonError(c, 'No changes supplied', 422);
    values.push(c.req.param('id'), list.id);
    const result = await c.env.DB.prepare(
      `UPDATE tags SET ${fields.join(', ')} WHERE id = ? AND list_id = ?`,
    )
      .bind(...values)
      .run();
    if (!result.meta.changes) return c.text('Not Found', 404);
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) return jsonError(c, 'Tag already exists', 409);
    throw error;
  }
  const tag = await c.env.DB.prepare('SELECT id, list_id, name, color FROM tags WHERE id = ?1 AND list_id = ?2')
    .bind(c.req.param('id'), list.id)
    .first<Tag>();
  return c.json(tag);
});

const placeSelect = `SELECT p.*, COALESCE((
  SELECT json_group_array(json_object('id', t.id, 'list_id', t.list_id, 'name', t.name, 'color', t.color))
  FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = p.id
), '[]') AS tags_json FROM places p`;

app.get('/api/lists/:slug/places', async (c) => {
  const list = c.get('list');
  const q = (c.req.query('q') ?? '').trim();
  const tagNames = cleanTags((c.req.query('tags') ?? '').split(','));
  const mode = c.req.query('mode') === 'any' ? 'any' : 'all';
  const sort = c.req.query('sort') === 'name' ? 'p.name COLLATE NOCASE ASC' : 'p.created_at DESC';
  const clauses = ['p.list_id = ?'];
  const params: unknown[] = [list.id];
  if (q) {
    const terms = q
      .split(/\s+/)
      .map((term) => term.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(Boolean);
    if (q.length >= 2 && terms.length) {
      clauses.push(`p.id IN (SELECT place_id FROM places_fts WHERE places_fts MATCH ? AND list_id = ?)`);
      params.push(terms.map((term) => `${term}*`).join(' AND '), list.id);
    } else {
      clauses.push(`(p.name LIKE ? OR COALESCE(p.address, '') LIKE ? OR COALESCE(p.notes, '') LIKE ?
        OR EXISTS (SELECT 1 FROM place_tags qpt JOIN tags qt ON qt.id = qpt.tag_id WHERE qpt.place_id = p.id AND qt.name LIKE ?))`);
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
  }
  if (tagNames.length) {
    const placeholders = tagNames.map(() => '?').join(',');
    const tagSubquery = `SELECT pt.place_id FROM place_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE t.list_id = ? AND lower(t.name) IN (${placeholders}) GROUP BY pt.place_id
      ${mode === 'all' ? `HAVING COUNT(DISTINCT lower(t.name)) = ${tagNames.length}` : ''}`;
    clauses.push(`p.id IN (${tagSubquery})`);
    params.push(list.id, ...tagNames.map((tag) => tag.toLocaleLowerCase()));
  }
  const result = await c.env.DB.prepare(`${placeSelect} WHERE ${clauses.join(' AND ')} ORDER BY ${sort}`)
    .bind(...params)
    .all<Record<string, unknown>>();
  return c.json(result.results.map(placeFromRow));
});

app.post('/api/lists/:slug/places', async (c) => {
  const list = c.get('list');
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const address = body.address === null || body.address === undefined ? null : typeof body.address === 'string' ? body.address.trim() : undefined;
  const lat = parseNullableNumber(body.lat);
  const lng = parseNullableNumber(body.lng);
  const notes = body.notes === null || body.notes === undefined ? null : typeof body.notes === 'string' ? body.notes : undefined;
  if (!name) return jsonError(c, 'Name is required', 422);
  if (address === undefined || lat === undefined || lng === undefined || notes === undefined) return jsonError(c, 'Invalid place fields', 422);
  if (notes && notes.length > MAX_NOTES_LENGTH) return jsonError(c, 'Notes are too long', 413);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM places WHERE list_id = ?1').bind(list.id).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_PLACES) return jsonError(c, 'Place limit reached', 413);
  const tags = await ensureTags(c.env.DB, list.id, cleanTags(body.tags));
  const id = crypto.randomUUID();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO places (id, list_id, name, address, lat, lng, source, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)',
    ).bind(id, list.id, name, address, lat, lng, 'manual', notes, timestamp, timestamp),
    ...tags.map((tag) => c.env.DB.prepare('INSERT INTO place_tags (place_id, tag_id) VALUES (?1, ?2)').bind(id, tag.id)),
  ]);
  return c.json(await getPlace(c.env.DB, list.id, id), 201);
});

app.get('/api/lists/:slug/places/:id', async (c) => {
  const place = await getPlace(c.env.DB, c.get('list').id, c.req.param('id'));
  return place ? c.json(place) : c.text('Not Found', 404);
});

app.patch('/api/lists/:slug/places/:id', async (c) => {
  const list = c.get('list');
  const placeId = c.req.param('id');
  const current = await getPlace(c.env.DB, list.id, placeId);
  if (!current) return c.text('Not Found', 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const field of ['name', 'address', 'notes', 'lat', 'lng'] as const) {
    if (!(field in body)) continue;
    if (field === 'name') {
      if (typeof body.name !== 'string' || !body.name.trim()) return jsonError(c, 'Name is required', 422);
      fields.push('name = ?');
      values.push(body.name.trim());
    } else if (field === 'notes') {
      if (body.notes !== null && typeof body.notes !== 'string') return jsonError(c, 'Invalid notes', 422);
      if (typeof body.notes === 'string' && body.notes.length > MAX_NOTES_LENGTH) return jsonError(c, 'Notes are too long', 413);
      fields.push('notes = ?');
      values.push(body.notes);
    } else if (field === 'address') {
      if (body.address !== null && typeof body.address !== 'string') return jsonError(c, 'Invalid address', 422);
      fields.push('address = ?');
      values.push(body.address);
    } else {
      const number = parseNullableNumber(body[field]);
      if (number === undefined) return jsonError(c, `Invalid ${field}`, 422);
      fields.push(`${field} = ?`);
      values.push(number);
    }
  }
  const tags = 'tags' in body ? await ensureTags(c.env.DB, list.id, cleanTags(body.tags)) : null;
  if (!fields.length && tags === null) return c.json(current);
  const statements = [];
  if (fields.length) {
    fields.push('updated_at = ?');
    values.push(now(), placeId, list.id);
    statements.push(c.env.DB.prepare(`UPDATE places SET ${fields.join(', ')} WHERE id = ? AND list_id = ?`).bind(...values));
  }
  if (tags !== null) {
    statements.push(c.env.DB.prepare('DELETE FROM place_tags WHERE place_id = ?').bind(placeId));
    statements.push(...tags.map((tag) => c.env.DB.prepare('INSERT INTO place_tags (place_id, tag_id) VALUES (?, ?)').bind(placeId, tag.id)));
  }
  await c.env.DB.batch(statements);
  return c.json(await getPlace(c.env.DB, list.id, placeId));
});

app.delete('/api/lists/:slug/places/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM places WHERE id = ?1 AND list_id = ?2')
    .bind(c.req.param('id'), c.get('list').id)
    .run();
  return result.meta.changes ? c.body(null, 204) : c.text('Not Found', 404);
});

app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));

function secureAssetResponse(response: Response) {
  const secured = new Response(response.body, response);
  secured.headers.set('Referrer-Policy', 'no-referrer');
  secured.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return secured;
}

app.all('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.text('Not Found', 404);
  const listPage = /^\/l\/[^/]+$/.test(c.req.path);
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  if (asset.status !== 404) {
    return listPage ? secureAssetResponse(asset) : asset;
  }
  const fallback = new URL('/index.html', c.req.url);
  const response = await c.env.ASSETS.fetch(new Request(fallback, c.req.raw));
  return listPage ? secureAssetResponse(response) : response;
});

export default app;
export { makeSlug };
