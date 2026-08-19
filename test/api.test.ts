import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

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
