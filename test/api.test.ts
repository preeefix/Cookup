import { env, fetchMock, SELF } from 'cloudflare:test';
import app from '../src/index';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

async function createList(name: string) {
  const response = await SELF.fetch('http://example.com/api/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { slug: string; id: string };
}

async function addPlace(slug: string, place: Record<string, unknown>) {
  const response = await SELF.fetch(`http://example.com/api/lists/${slug}/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(place),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function mockGoogleSearch(payload: unknown, status = 200) {
  fetchMock
    .get('https://places.googleapis.com')
    .intercept({ method: 'POST', path: /.*/ })
    .reply(status, payload);
}

async function fetchWithoutGoogleKey(path: string, options?: RequestInit) {
  const testEnv = { ...env, GOOGLE_PLACES_API_KEY: undefined } as Parameters<typeof app.fetch>[1];
  return app.fetch(new Request(`http://example.com${path}`, options), testEnv);
}

describe('phase 1 API', () => {
  it('isolates lists and rejects unknown slugs', async () => {
    const first = await createList('First');
    const second = await createList('Second');
    await addPlace(first.slug, { name: 'Only in first', tags: ['one'] });

    const secondPlaces = await SELF.fetch(`http://example.com/api/lists/${second.slug}/places`);
    expect(await secondPlaces.json()).toEqual([]);
    const crossList = await SELF.fetch(`http://example.com/api/lists/${second.slug}/places/${first.id}`);
    expect(crossList.status).toBe(404);
    const crossWrite = await SELF.fetch(`http://example.com/api/lists/${second.slug}/places/${first.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Must stay private' }),
    });
    expect(crossWrite.status).toBe(404);
    await addPlace(second.slug, { name: 'Only in second', list_id: first.id });
    const firstAfterWrite = await SELF.fetch(`http://example.com/api/lists/${first.slug}/places`);
    expect((await firstAfterWrite.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Only in first']);
    const unknown = await SELF.fetch('http://example.com/api/lists/not-a-real-slug');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe('Not Found');
  });

  it('rotates a slug and invalidates the old URL', async () => {
    const list = await createList('Rotate');
    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/rotate`, { method: 'POST' });
    expect(response.status).toBe(200);
    const rotated = (await response.json()) as { slug: string };
    expect(rotated.slug).not.toBe(list.slug);
    expect((await SELF.fetch(`http://example.com/api/lists/${list.slug}`)).status).toBe(404);
    expect((await SELF.fetch(`http://example.com/api/lists/${rotated.slug}`)).status).toBe(200);
  });

  it('deduplicates tags case-insensitively', async () => {
    const list = await createList('Tags');
    await addPlace(list.slug, { name: 'Noodles', tags: ['Ramen', 'ramen', ' RAMEN '] });
    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/tags`);
    expect(response.status).toBe(200);
    const tags = (await response.json()) as Array<{ name: string; usage_count: number }>;
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe('Ramen');
    expect(tags[0].usage_count).toBe(1);
  });

  it('splits comma-separated tags and caps tag names', async () => {
    const list = await createList('Comma tags');
    await addPlace(list.slug, {
      name: 'Comma Place',
      tags: ['ramen, cheap', 'x'.repeat(100)],
    });
    const tagsResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/tags`);
    const tags = (await tagsResponse.json()) as Array<{ id: string; name: string }>;
    expect(tags.map((tag) => tag.name)).toEqual(['cheap', 'ramen', 'x'.repeat(80)]);

    const cheapResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?tags=cheap`);
    expect((await cheapResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Comma Place']);

    const renameResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/tags/${tags.find((tag) => tag.name === 'ramen')?.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'red, spicy' }),
    });
    expect(renameResponse.status).toBe(200);
    const spicyResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?tags=spicy`);
    expect((await spicyResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Comma Place']);
  });

  it('intersects text and tag filters', async () => {
    const list = await createList('Search');
    await addPlace(list.slug, { name: 'Ramen House', address: 'Main Street', tags: ['quick', 'noodles'] });
    await addPlace(list.slug, { name: 'Ramen Garden', address: 'Main Street', tags: ['slow', 'noodles'] });
    await addPlace(list.slug, { name: 'Quick Pizza', address: 'Side Street', tags: ['quick'] });

    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?q=Ramen&tags=quick&mode=all`);
    expect(response.status).toBe(200);
    const places = (await response.json()) as Array<{ name: string }>;
    expect(places.map((place) => place.name)).toEqual(['Ramen House']);
  });

  it('supports distinct any and all tag modes', async () => {
    const list = await createList('Modes');
    await addPlace(list.slug, { name: 'Only quick', tags: ['quick'] });
    await addPlace(list.slug, { name: 'Quick noodles', tags: ['quick', 'noodles'] });

    const anyResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?tags=quick,noodles&mode=any`);
    const allResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?tags=quick,noodles&mode=all`);
    expect((await anyResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual([
      'Quick noodles',
      'Only quick',
    ]);
    expect((await allResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Quick noodles']);
  });

  it('uses LIKE fallback for a one-character query', async () => {
    const list = await createList('Short query');
    await addPlace(list.slug, { name: 'Ramen House' });
    await addPlace(list.slug, { name: 'Pizza Corner' });

    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?q=h`);
    expect((await response.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Ramen House']);
  });

  it('quotes reserved FTS terms', async () => {
    const list = await createList('Reserved term');
    await addPlace(list.slug, { name: 'OR House' });

    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?q=OR`);
    expect(response.status).toBe(200);
    expect((await response.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['OR House']);
  });

  it('escapes LIKE wildcards in short queries', async () => {
    const list = await createList('Wildcard query');
    await addPlace(list.slug, { name: 'Percent % Place' });
    await addPlace(list.slug, { name: 'Underscore _ Place' });
    await addPlace(list.slug, { name: 'Tagged Percent', tags: ['100%'] });
    await addPlace(list.slug, { name: 'Ordinary Place' });

    const percentResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?q=%25`);
    const underscoreResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?q=_`);
    expect((await percentResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual([
      'Tagged Percent',
      'Percent % Place',
    ]);
    expect((await underscoreResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Underscore _ Place']);
  });

  it('updates the FTS index when a tag is renamed', async () => {
    const list = await createList('Rename tag');
    await addPlace(list.slug, { name: 'Noodles', tags: ['old-name'] });
    const tagsResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/tags`);
    const tag = (await tagsResponse.json() as Array<{ id: string }>)[0];

    const renameResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/tags/${tag.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-name' }),
    });
    expect(renameResponse.status).toBe(200);
    const searchResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places?q=new-name`);
    expect((await searchResponse.json() as Array<{ name: string }>).map((place) => place.name)).toEqual(['Noodles']);
  });
});

describe('Google Places API', () => {
  it('maps a Text Search response to trimmed candidates', async () => {
    const list = await createList('Google search');
    mockGoogleSearch({
      places: [
        {
          id: 'places/chopped',
          displayName: { text: '  Chopped  ' },
          formattedAddress: '  1 Market Street  ',
          location: { latitude: 51.5, longitude: -0.12 },
          rating: 5,
        },
      ],
    });

    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/place-search?q=chopped`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        google_place_id: 'places/chopped',
        name: 'Chopped',
        address: '1 Market Street',
        lat: 51.5,
        lng: -0.12,
      },
    ]);
    fetchMock.assertNoPendingInterceptors();
  });

  it('returns a configured error when the Google key is absent', async () => {
    const list = await createList('Missing Google key');
    const response = await fetchWithoutGoogleKey(`/api/lists/${list.slug}/place-search?q=ramen`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Google Places search isn't configured" });
    const linkResponse = await fetchWithoutGoogleKey(`/api/lists/${list.slug}/resolve-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.google.com/maps?q=1,2' }),
    });
    expect(linkResponse.status).toBe(503);
    expect(await linkResponse.json()).toEqual({ error: "Google Places search isn't configured" });
  });

  it('rejects non-Google hosts before fetching a shared link', async () => {
    const list = await createList('Link host');
    for (const url of ['https://example.com/maps/place/Ramen', 'https://maps.google.com.evil/maps/place/Ramen']) {
      const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      expect(response.status).toBe(422);
    }
  });

  it('extracts coordinates from common Google Maps link shapes', async () => {
    const list = await createList('Link extraction');
    const links = [
      ['https://www.google.com/maps/place/Rome+Cafe/@41.9,12.5,17z', 'Rome Cafe', 41.9, 12.5],
      ['https://www.google.com/maps/place/New+York/data=!4m2!3d40.7!4d-73.9', 'New York', 40.7, -73.9],
      ['https://www.google.com/maps?q=1.2,3.4', 'Google Maps location', 1.2, 3.4],
    ] as const;

    for (const [url, name, lat, lng] of links) {
      const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ google_place_id: null, name, address: null, lat, lng });
    }
  });

  it('decodes link names once and keeps coordinate-looking text queries as text', async () => {
    const list = await createList('Link name decoding');
    const names = [
      ['https://www.google.com/maps/place/100%25+Coffee/@1,2,17z', '100% Coffee'],
      ['https://www.google.com/maps/place/C%2B%2B+Cafe/@3,4,17z', 'C++ Cafe'],
    ] as const;
    for (const [url, name] of names) {
      const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { name: string }).toMatchObject({ name });
    }

    mockGoogleSearch({
      places: [
        {
          id: 'places/suite',
          displayName: { text: 'Suite 5, 20 Broadway' },
          formattedAddress: '20 Broadway',
          location: { latitude: 40, longitude: -73 },
        },
      ],
    });
    const textResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.google.com/maps?q=Suite%205%2C%2020%20Broadway' }),
    });
    expect(textResponse.status).toBe(200);
    expect(await textResponse.json()).toMatchObject({
      google_place_id: 'places/suite',
      name: 'Suite 5, 20 Broadway',
      lat: 40,
      lng: -73,
    });
    fetchMock.assertNoPendingInterceptors();
  });

  it('enriches coordinate links only when the top result is nearby', async () => {
    const list = await createList('Link enrichment');
    mockGoogleSearch({
      places: [
        {
          id: 'places/near',
          displayName: { text: 'Near Cafe' },
          formattedAddress: '1 Near Street',
          location: { latitude: 35.0005, longitude: 139.0005 },
        },
      ],
    });
    const nearResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.google.com/maps/place/Near+Cafe/@35,139,17z' }),
    });
    expect(nearResponse.status).toBe(200);
    expect(await nearResponse.json()).toMatchObject({
      google_place_id: 'places/near',
      name: 'Near Cafe',
      address: '1 Near Street',
      lat: 35,
      lng: 139,
    });

    mockGoogleSearch({
      places: [
        {
          id: 'places/far',
          displayName: { text: 'Far Cafe' },
          formattedAddress: '1 Far Street',
          location: { latitude: 36, longitude: 140 },
        },
      ],
    });
    const farResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.google.com/maps/place/Far+Cafe/@35,139,17z' }),
    });
    expect(farResponse.status).toBe(200);
    expect(await farResponse.json()).toMatchObject({
      google_place_id: null,
      name: 'Far Cafe',
      address: null,
      lat: 35,
      lng: 139,
    });

    mockGoogleSearch({ error: 'upstream failure' }, 500);
    const failedResponse = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.google.com/maps/place/Failed+Cafe/@35,139,17z' }),
    });
    expect(failedResponse.status).toBe(200);
    expect(await failedResponse.json()).toMatchObject({
      google_place_id: null,
      name: 'Failed Cafe',
      address: null,
      lat: 35,
      lng: 139,
    });
    fetchMock.assertNoPendingInterceptors();
  });

  it('uses Text Search to resolve a named Google Maps query', async () => {
    const list = await createList('Named link');
    mockGoogleSearch({
      places: [
        {
          id: 'places/coffee',
          displayName: { text: 'Coffee Shop' },
          formattedAddress: '5 Main Street',
          location: { latitude: 10, longitude: 20 },
        },
      ],
    });
    const response = await SELF.fetch(`http://example.com/api/lists/${list.slug}/resolve-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.google.com/maps?q=Coffee%20Shop' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      google_place_id: 'places/coffee',
      name: 'Coffee Shop',
      address: '5 Main Street',
      lat: 10,
      lng: 20,
    });
    fetchMock.assertNoPendingInterceptors();
  });

  it('persists Google place source metadata when saving a candidate', async () => {
    const list = await createList('Google save');
    const place = (await addPlace(list.slug, {
      name: 'Google Ramen',
      address: '1 Noodle Road',
      lat: 35.6,
      lng: 139.7,
      source: 'google',
      google_place_id: 'places/ramen',
    })) as { source: string; google_place_id: string; name: string };
    expect(place).toMatchObject({ source: 'google', google_place_id: 'places/ramen', name: 'Google Ramen' });
    const listing = await SELF.fetch(`http://example.com/api/lists/${list.slug}/places`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual([place]);
  });
});
