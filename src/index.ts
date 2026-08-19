import { Hono } from 'hono';
import type { Context, Next } from 'hono';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_PLACES_API_KEY?: string;
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
  source: 'manual' | 'google' | 'link';
  google_place_id: string | null;
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

type GoogleCandidate = {
  google_place_id: string | null;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const MAX_PLACES = 500;
const MAX_NOTES_LENGTH = 2000;
const MAX_TAG_NAME_LENGTH = 80;
const LAST_SEEN_REFRESH_MS = 60 * 60 * 1000;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function now() {
  return new Date().toISOString();
}

function jsonError(c: AppContext, message: string, status: 400 | 404 | 409 | 413 | 422 | 502 | 503) {
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
    for (const part of value.split(',')) {
      const name = part.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_NAME_LENGTH);
      const key = name.toLocaleLowerCase();
      if (name && !seen.has(key)) {
        seen.add(key);
        tags.push(name);
      }
    }
  }
  return tags;
}

function parseNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validCoordinate(value: number | null, minimum: number, maximum: number) {
  return value === null || (value >= minimum && value <= maximum);
}

function decodeTags(value: unknown): Tag[] {
  if (typeof value !== 'string') return [];
  try {
    return JSON.parse(value) as Tag[];
  } catch {
    return [];
  }
}

function mapGoogleCandidate(value: unknown): GoogleCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const place = value as {
    id?: unknown;
    displayName?: { text?: unknown };
    formattedAddress?: unknown;
    location?: { latitude?: unknown; longitude?: unknown };
  };
  const id = typeof place.id === 'string' ? place.id.trim() : '';
  const name = typeof place.displayName?.text === 'string' ? place.displayName.text.trim() : '';
  if (!id || !name) return null;
  const address = typeof place.formattedAddress === 'string' && place.formattedAddress.trim() ? place.formattedAddress.trim() : null;
  const lat = typeof place.location?.latitude === 'number' && Number.isFinite(place.location.latitude) ? place.location.latitude : null;
  const lng = typeof place.location?.longitude === 'number' && Number.isFinite(place.location.longitude) ? place.location.longitude : null;
  return { google_place_id: id, name, address, lat, lng };
}

function mapGoogleCandidates(value: unknown) {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { places?: unknown }).places)) return [];
  return (value as { places: unknown[] }).places.map(mapGoogleCandidate).filter((place): place is GoogleCandidate => place !== null);
}

async function searchGooglePlaces(apiKey: string, query: string) {
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 8 }),
  });
  if (!response.ok) {
    console.error('Google Places upstream status', response.status);
    throw new Error('Google Places upstream request failed');
  }
  const payload = await response.json().catch(() => null);
  return mapGoogleCandidates(payload);
}

function isAllowedGoogleHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'google.com' || host === 'www.google.com' || host === 'goo.gl' || host === 'maps.app.goo.gl') return true;
  if (!host.startsWith('maps.google.')) return false;
  const countryDomain = host.slice('maps.google.'.length);
  return /^[a-z]{2}$/.test(countryDomain) || /^(?:com|co|net|org)\.[a-z]{2}$/.test(countryDomain);
}

function isShortGoogleHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'goo.gl' || host === 'maps.app.goo.gl';
}

function parseGoogleMapsUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !isAllowedGoogleHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function followGoogleMapsRedirects(start: URL) {
  let current = start;
  for (let hop = 0; hop <= 3; hop += 1) {
    const response = await fetch(current, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return current;
    if (hop === 3) throw new Error('Too many Google Maps redirects');
    const location = response.headers.get('location');
    const next = location ? parseGoogleMapsUrl(new URL(location, current).toString()) : null;
    if (!next) throw new Error('Google Maps redirect left the allowlist');
    current = next;
  }
  throw new Error('Too many Google Maps redirects');
}

function parseCoordinatePair(value: string | null) {
  if (!value) return null;
  const match = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && validCoordinate(lat, -90, 90) && validCoordinate(lng, -180, 180)
    ? { lat, lng }
    : null;
}

function distanceMeters(firstLat: number, firstLng: number, secondLat: number, secondLng: number) {
  const latitudeRadians = ((firstLat + secondLat) / 2) * (Math.PI / 180);
  const latitudeDelta = (secondLat - firstLat) * (Math.PI / 180);
  const longitudeDelta = (secondLng - firstLng) * (Math.PI / 180) * Math.cos(latitudeRadians);
  return 6_371_000 * Math.sqrt(latitudeDelta ** 2 + longitudeDelta ** 2);
}

function decodeGooglePlaceName(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' ')).trim() || null;
  } catch {
    return null;
  }
}

function extractGoogleMapsCandidate(url: URL) {
  const segments = url.pathname.split('/').filter(Boolean);
  const placeSegmentIndex = segments.findIndex((segment) => segment.toLowerCase() === 'place');
  const name = placeSegmentIndex >= 0 && segments[placeSegmentIndex + 1] ? decodeGooglePlaceName(segments[placeSegmentIndex + 1]) : null;
  let decodedHref = url.href;
  try {
    decodedHref = decodeURIComponent(decodedHref);
  } catch {
    // Keep the original URL when an unrelated component is malformed.
  }
  const atCoordinates = decodedHref.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const dataCoordinates = decodedHref.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  const q = url.searchParams.get('q');
  const coordinates = parseCoordinatePair(atCoordinates ? `${atCoordinates[1]},${atCoordinates[2]}` : dataCoordinates ? `${dataCoordinates[1]},${dataCoordinates[2]}` : q);
  const query = coordinates ? name : name ?? q?.trim() ?? null;
  return {
    name: query,
    lat: coordinates?.lat ?? null,
    lng: coordinates?.lng ?? null,
  };
}

function placeFromRow(row: Record<string, unknown>): Place {
  return {
    id: String(row.id),
    list_id: String(row.list_id),
    name: String(row.name),
    address: row.address === null ? null : String(row.address),
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    source: String(row.source) as Place['source'],
    google_place_id: row.google_place_id === null || row.google_place_id === undefined ? null : String(row.google_place_id),
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
  if (Date.parse(list.last_seen_at) < Date.now() - LAST_SEEN_REFRESH_MS) {
    await c.env.DB.prepare('UPDATE lists SET last_seen_at = ?1 WHERE id = ?2')
      .bind(now(), list.id)
      .run();
  }
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

app.get('/api/lists/:slug/place-search', async (c) => {
  if (!c.env.GOOGLE_PLACES_API_KEY) return jsonError(c, "Google Places search isn't configured", 503);
  const query = (c.req.query('q') ?? '').trim();
  if (query.length < 2) return jsonError(c, 'Search query must be at least 2 characters', 422);
  try {
    return c.json(await searchGooglePlaces(c.env.GOOGLE_PLACES_API_KEY, query));
  } catch {
    return jsonError(c, 'Google Places search failed', 502);
  }
});

app.post('/api/lists/:slug/resolve-link', async (c) => {
  if (!c.env.GOOGLE_PLACES_API_KEY) return jsonError(c, "Google Places search isn't configured", 503);
  const body = await c.req.json<unknown>().catch(() => null);
  const urlValue = body && typeof body === 'object' && 'url' in body ? (body as { url?: unknown }).url : undefined;
  if (typeof urlValue !== 'string' || !urlValue.trim()) return jsonError(c, 'A Google Maps URL is required', 422);
  const parsed = parseGoogleMapsUrl(urlValue.trim());
  if (!parsed) return jsonError(c, 'Only HTTPS Google Maps links are supported', 422);

  let finalUrl: URL;
  try {
    finalUrl = isShortGoogleHost(parsed.hostname) ? await followGoogleMapsRedirects(parsed) : parsed;
  } catch {
    return jsonError(c, 'Could not follow that Google Maps link', 422);
  }
  const extracted = extractGoogleMapsCandidate(finalUrl);
  const coordinateCandidate = {
    google_place_id: null,
    name: extracted.name ?? 'Google Maps location',
    address: null,
    lat: extracted.lat,
    lng: extracted.lng,
  } satisfies GoogleCandidate;
  if (extracted.lat === null || extracted.lng === null) {
    if (!extracted.name) return jsonError(c, 'Could not extract a place from that Google Maps link', 422);
    try {
      const candidates = await searchGooglePlaces(c.env.GOOGLE_PLACES_API_KEY, extracted.name);
      if (!candidates.length) return jsonError(c, 'No place was found for that Google Maps link', 422);
      return c.json(candidates[0]);
    } catch {
      return jsonError(c, 'Google Places search failed', 502);
    }
  }
  if (extracted.name) {
    try {
      const candidates = await searchGooglePlaces(c.env.GOOGLE_PLACES_API_KEY, extracted.name);
      const topCandidate = candidates[0];
      if (
        topCandidate &&
        topCandidate.lat !== null &&
        topCandidate.lng !== null &&
        distanceMeters(extracted.lat, extracted.lng, topCandidate.lat, topCandidate.lng) <= 200
      ) {
        return c.json({
          google_place_id: topCandidate.google_place_id,
          name: extracted.name,
          address: topCandidate.address,
          lat: extracted.lat,
          lng: extracted.lng,
        } satisfies GoogleCandidate);
      }
    } catch {
      // Keep the URL-derived candidate when optional enrichment fails.
    }
  }
  return c.json(coordinateCandidate);
});

app.post('/api/lists/:slug/rotate', async (c) => {
  const list = c.get('list');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = makeSlug();
    try {
      const [result] = await c.env.DB.batch([
        c.env.DB.prepare('UPDATE lists SET slug = ?1, last_seen_at = ?2 WHERE id = ?3 AND slug = ?4').bind(
          slug,
          now(),
          list.id,
          list.slug,
        ),
      ]);
      if (!result.meta.changes) return jsonError(c, 'List URL changed; retry with the current URL', 409);
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
  const names = body.name === undefined ? undefined : cleanTags([body.name]);
  if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
    return jsonError(c, 'Invalid tag color', 422);
  }
  const color = body.color === null || body.color === undefined ? body.color : body.color.trim();
  if (body.name !== undefined && !names?.length) return jsonError(c, 'Tag name cannot be empty', 422);
  try {
    if (names && names.length > 1) {
      const current = await c.env.DB.prepare('SELECT id FROM tags WHERE id = ?1 AND list_id = ?2')
        .bind(c.req.param('id'), list.id)
        .first<{ id: string }>();
      if (!current) return c.text('Not Found', 404);
      const places = await c.env.DB.prepare('SELECT place_id FROM place_tags WHERE tag_id = ?1')
        .bind(current.id)
        .all<{ place_id: string }>();
      const splitTags = await ensureTags(c.env.DB, list.id, names);
      const statements = splitTags.flatMap((tag) =>
        places.results.map((place) =>
          c.env.DB.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?1, ?2)').bind(place.place_id, tag.id),
        ),
      );
      statements.push(c.env.DB.prepare('DELETE FROM place_tags WHERE tag_id = ?1').bind(current.id));
      if (!splitTags.some((tag) => tag.id === current.id)) {
        statements.push(c.env.DB.prepare('DELETE FROM tags WHERE id = ?1 AND list_id = ?2').bind(current.id, list.id));
      }
      if (color !== undefined) {
        statements.push(
          ...splitTags.map((tag) =>
            c.env.DB.prepare('UPDATE tags SET color = ?1 WHERE id = ?2 AND list_id = ?3')
              .bind(color ? color.slice(0, 32) : null, tag.id, list.id),
          ),
        );
      }
      await c.env.DB.batch(statements);
      return c.json(
        await c.env.DB.prepare('SELECT id, list_id, name, color FROM tags WHERE id = ?1 AND list_id = ?2')
          .bind(splitTags[0].id, list.id)
          .first<Tag>(),
      );
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    if (names !== undefined) {
      fields.push('name = ?');
      values.push(names[0]);
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
      .flatMap((term) => term.split(/[^a-zA-Z0-9]+/))
      .filter(Boolean);
    if (q.length >= 2 && terms.length) {
      clauses.push(`p.id IN (SELECT place_id FROM places_fts WHERE places_fts MATCH ? AND list_id = ?)`);
      params.push(terms.map((term) => `"${term}"*`).join(' AND '), list.id);
    } else {
      clauses.push(`(p.name LIKE ? ESCAPE '!' OR COALESCE(p.address, '') LIKE ? ESCAPE '!' OR COALESCE(p.notes, '') LIKE ? ESCAPE '!'
        OR EXISTS (SELECT 1 FROM place_tags qpt JOIN tags qt ON qt.id = qpt.tag_id WHERE qpt.place_id = p.id AND qt.name LIKE ? ESCAPE '!'))`);
      const like = `%${q.replace(/[!%_]/g, (character) => `!${character}`)}%`;
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
  const source = body.source === undefined ? 'manual' : body.source;
  const googlePlaceId =
    body.google_place_id === null || body.google_place_id === undefined
      ? null
      : typeof body.google_place_id === 'string' && body.google_place_id.trim()
        ? body.google_place_id.trim()
        : undefined;
  if (!name) return jsonError(c, 'Name is required', 422);
  if (
    address === undefined ||
    lat === undefined ||
    lng === undefined ||
    notes === undefined ||
    !validCoordinate(lat, -90, 90) ||
    !validCoordinate(lng, -180, 180)
  ) {
    return jsonError(c, 'Invalid place fields', 422);
  }
  if (source !== 'manual' && source !== 'google' && source !== 'link') return jsonError(c, 'Invalid place source', 422);
  if (googlePlaceId === undefined) return jsonError(c, 'Invalid Google place ID', 422);
  if (notes && notes.length > MAX_NOTES_LENGTH) return jsonError(c, 'Notes are too long', 413);
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM places WHERE list_id = ?1').bind(list.id).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_PLACES) return jsonError(c, 'Place limit reached', 413);
  const tags = await ensureTags(c.env.DB, list.id, cleanTags(body.tags));
  const id = crypto.randomUUID();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO places (id, list_id, name, address, lat, lng, source, google_place_id, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)',
    ).bind(id, list.id, name, address, lat, lng, source, googlePlaceId, notes, timestamp, timestamp),
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
      const bounds = field === 'lat' ? [-90, 90] : [-180, 180];
      if (number === undefined || !validCoordinate(number, bounds[0], bounds[1])) {
        return jsonError(c, `Invalid ${field}`, 422);
      }
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
