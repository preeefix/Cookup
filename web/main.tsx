import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import './styles.css';

type Tag = { id: string; name: string; color: string | null; usage_count?: number };
type Place = {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: 'manual' | 'google' | 'link';
  google_place_id: string | null;
  notes: string | null;
  tags: Tag[];
};

type GoogleCandidate = {
  google_place_id: string | null;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

const DEFAULT_MAP_CENTER: L.LatLngExpression = [20, 0];
const DEFAULT_MAP_ZOOM = 2;

L.Marker.prototype.options.icon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const seenKey = 'cookup-slugs';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
    ...options,
  });
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
  return response.status === 204 ? (undefined as T) : response.json();
}

function rememberSlug(slug: string, replacedSlug?: string) {
  const slugs = JSON.parse(localStorage.getItem(seenKey) ?? '[]') as string[];
  const previous = slugs.filter((item) => item !== slug && item !== replacedSlug);
  localStorage.setItem(seenKey, JSON.stringify([slug, ...previous].slice(0, 20)));
}

function Landing() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [slugs] = useState<string[]>(() => JSON.parse(localStorage.getItem(seenKey) ?? '[]'));

  async function createList(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      const list = await api<{ slug: string }>('/api/lists', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      rememberSlug(list.slug);
      window.location.href = `/l/${list.slug}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create list');
    }
  }

  return (
    <main className="shell landing">
      <div className="eyebrow">COOKUP</div>
      <h1>Your places, your way.</h1>
      <p className="lede">Save restaurants and spots with tags that make sense to you.</p>
      <form className="card create-card" onSubmit={createList}>
        <label htmlFor="list-name">Start a new list</label>
        <div className="inline-form">
          <input id="list-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Weekend favourites" />
          <button type="submit">Create list</button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
      {slugs.length > 0 && (
        <section className="card">
          <h2>Lists on this device</h2>
          <div className="saved-links">
            {slugs.map((slug) => (
              <a key={slug} href={`/l/${slug}`}>
                {slug}
              </a>
            ))}
          </div>
        </section>
      )}
      <p className="privacy-note">Your list URL is its key. Anyone with it can edit the list.</p>
    </main>
  );
}

function TagInput({ tags, value, setValue }: { tags: Tag[]; value: string[]; setValue: (tags: string[]) => void }) {
  const [text, setText] = useState('');
  const suggestions = tags.filter((tag) => !value.some((item) => item.toLowerCase() === tag.name.toLowerCase()) && tag.name.toLowerCase().includes(text.toLowerCase()));
  function addTag(raw: string) {
    const next = [...value];
    for (const part of raw.split(',')) {
      const tag = part.trim();
      if (tag && !next.some((item) => item.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    if (next.length !== value.length) setValue(next);
    setText('');
  }
  return (
    <div className="tag-input">
      <div className="chips">
        {value.map((tag) => (
          <button type="button" className="chip active" key={tag} onClick={() => setValue(value.filter((item) => item !== tag))}>
            {tag} ×
          </button>
        ))}
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              addTag(text);
            }
          }}
          onBlur={() => text && addTag(text)}
          placeholder={value.length ? 'Add another tag' : 'Tags, e.g. ramen'}
        />
      </div>
      {text && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((tag) => (
            <button type="button" key={tag.id} onMouseDown={() => addTag(tag.name)}>
              {tag.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function hasCoordinates(place: Place): place is Place & { lat: number; lng: number } {
  return typeof place.lat === 'number' && Number.isFinite(place.lat) && typeof place.lng === 'number' && Number.isFinite(place.lng);
}

function popupContent(place: Place): HTMLElement {
  const content = document.createElement('div');
  content.className = 'map-popup';
  const heading = document.createElement('strong');
  heading.textContent = place.name;
  content.appendChild(heading);
  for (const line of [place.address, place.tags.map((tag) => tag.name).join(', ')]) {
    if (!line) continue;
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    content.appendChild(paragraph);
  }
  return content;
}

function MapView({ places }: { places: Place[] }) {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const viewSignatureRef = useRef<string | null>(null);
  const mappedPlaces = useMemo(() => places.filter(hasCoordinates), [places]);

  useEffect(() => {
    if (!mapNode.current) return;

    const map = L.map(mapNode.current).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    const markers = L.layerGroup().addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    markersRef.current = markers;

    viewSignatureRef.current = null;

    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => {
      window.cancelAnimationFrame(frame);
      markers.clearLayers();
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
      viewSignatureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const markers = markersRef.current;
    if (!map || !markers) return;

    markers.clearLayers();
    mappedPlaces.forEach((place) => {
      L.marker([place.lat, place.lng]).bindPopup(popupContent(place)).addTo(markers);
    });

    map.invalidateSize();

    const signature = mappedPlaces.map((place) => `${place.id}:${place.lat}:${place.lng}`).join('|');
    if (signature === viewSignatureRef.current) return;
    viewSignatureRef.current = signature;

    if (mappedPlaces.length === 0) {
      map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    } else if (mappedPlaces.length === 1) {
      map.setView([mappedPlaces[0].lat, mappedPlaces[0].lng], 13);
    } else {
      map.fitBounds(L.latLngBounds(mappedPlaces.map((place): L.LatLngTuple => [place.lat, place.lng])), {
        padding: [32, 32],
        maxZoom: 15,
      });
    }
  }, [mappedPlaces]);

  return (
    <div className="map-wrap">
      <div className="map-canvas" ref={mapNode} />
      {mappedPlaces.length === 0 && (
        <div className="map-empty-overlay">
          No matching places have coordinates yet. Add a latitude and longitude to show pins here.
        </div>
      )}
    </div>
  );
}

function ListPage({ slug }: { slug: string }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [mode, setMode] = useState<'all' | 'any'>('all');
  const [form, setForm] = useState({
    name: '',
    address: '',
    lat: '',
    lng: '',
    notes: '',
    tags: [] as string[],
    source: 'manual' as 'manual' | 'google' | 'link',
    google_place_id: '',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', address: '', notes: '', tags: [] as string[] });
  const [error, setError] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [googleQuery, setGoogleQuery] = useState('');
  const [googleCandidates, setGoogleCandidates] = useState<GoogleCandidate[]>([]);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkCandidate, setLinkCandidate] = useState<GoogleCandidate | null>(null);
  const [googleSearching, setGoogleSearching] = useState(false);
  const [linkResolving, setLinkResolving] = useState(false);
  const refreshRun = useRef(0);
  const refreshSlug = useRef<string | null>(null);
  const googleSearchRun = useRef(0);
  const filter = useMemo(
    () => `?q=${encodeURIComponent(debouncedQuery)}&tags=${encodeURIComponent(selectedTags.join(','))}&mode=${mode}`,
    [debouncedQuery, mode, selectedTags],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const value = googleQuery.trim();
    const run = ++googleSearchRun.current;
    if (value.length < 2) {
      setGoogleCandidates([]);
      setGoogleSearching(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      setGoogleSearching(true);
      try {
        const candidates = await api<GoogleCandidate[]>(
          `/api/lists/${slug}/place-search?q=${encodeURIComponent(value)}`,
        );
        if (run === googleSearchRun.current) setGoogleCandidates(candidates);
      } catch (err) {
        if (run === googleSearchRun.current) {
          setGoogleCandidates([]);
          setError(err instanceof Error ? err.message : 'Could not search Google Places');
        }
      } finally {
        if (run === googleSearchRun.current) setGoogleSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [googleQuery, slug]);

  async function refresh(includeTags = true) {
    const run = ++refreshRun.current;
    try {
      const [nextPlaces, nextTags] = await Promise.all([
        api<Place[]>(`/api/lists/${slug}/places${filter}`),
        includeTags ? api<Tag[]>(`/api/lists/${slug}/tags`) : Promise.resolve(null),
      ]);
      if (run !== refreshRun.current) return;
      setPlaces(nextPlaces);
      if (nextTags) setTags(nextTags);
    } catch (err) {
      if (run === refreshRun.current) throw err;
    }
  }
  useEffect(() => {
    rememberSlug(slug);
    const includeTags = refreshSlug.current !== slug;
    refreshSlug.current = slug;
    refresh(includeTags).catch((err) => setError(err instanceof Error ? err.message : 'Could not load list'));
  }, [slug, filter]);

  async function addPlace(event: FormEvent) {
    event.preventDefault();
    setError('');
    const lat = form.lat.trim() ? Number(form.lat) : null;
    const lng = form.lng.trim() ? Number(form.lng) : null;
    if ((form.lat.trim() && !Number.isFinite(lat)) || (form.lng.trim() && !Number.isFinite(lng))) {
      setError('Coordinates must be valid numbers');
      return;
    }
    try {
      await api(`/api/lists/${slug}/places`, {
        method: 'POST',
        body: JSON.stringify({ ...form, lat, lng, google_place_id: form.google_place_id || null }),
      });
      setForm({
        name: '',
        address: '',
        lat: '',
        lng: '',
        notes: '',
        tags: [],
        source: 'manual',
        google_place_id: '',
      });
      setGoogleCandidates([]);
      setLinkCandidate(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save place');
    }
  }

  function useGoogleCandidate(candidate: GoogleCandidate, source: 'google' | 'link') {
    setForm((current) => ({
      ...current,
      name: candidate.name,
      address: candidate.address ?? '',
      lat: candidate.lat === null ? '' : String(candidate.lat),
      lng: candidate.lng === null ? '' : String(candidate.lng),
      source,
      google_place_id: candidate.google_place_id ?? '',
    }));
    setGoogleCandidates([]);
    if (source === 'link') setLinkCandidate(null);
  }

  async function resolveLink() {
    setError('');
    if (!linkUrl.trim()) {
      setError('Paste a Google Maps link first');
      return;
    }
    setLinkResolving(true);
    try {
      const candidate = await api<GoogleCandidate>(`/api/lists/${slug}/resolve-link`, {
        method: 'POST',
        body: JSON.stringify({ url: linkUrl.trim() }),
      });
      setLinkCandidate(candidate);
    } catch (err) {
      setLinkCandidate(null);
      setError(err instanceof Error ? err.message : 'Could not resolve Google Maps link');
    } finally {
      setLinkResolving(false);
    }
  }

  function beginEdit(place: Place) {
    setEditingId(place.id);
    setEditForm({
      name: place.name,
      address: place.address ?? '',
      notes: place.notes ?? '',
      tags: place.tags.map((tag) => tag.name),
    });
  }

  async function editPlace(event: FormEvent, id: string) {
    event.preventDefault();
    setError('');
    try {
      await api(`/api/lists/${slug}/places/${id}`, { method: 'PATCH', body: JSON.stringify(editForm) });
      setEditingId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update place');
    }
  }

  async function removePlace(id: string) {
    setError('');
    try {
      await api(`/api/lists/${slug}/places/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete place');
    }
  }

  async function rotate() {
    if (!window.confirm('Rotate this URL? The old URL will stop working immediately.')) return;
    setError('');
    try {
      const result = await api<{ slug: string }>(`/api/lists/${slug}/rotate`, { method: 'POST' });
      rememberSlug(result.slug, slug);
      window.location.href = `/l/${result.slug}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rotate URL');
    }
  }

  function toggleTag(name: string) {
    setSelectedTags((current) => (current.includes(name) ? current.filter((tag) => tag !== name) : [...current, name]));
  }

  return (
    <main className="shell list-shell">
      <header className="list-header">
        <div>
          <div className="eyebrow">COOKUP LIST</div>
          <h1>Saved places</h1>
        </div>
        <button type="button" className="danger-link" onClick={rotate}>
          Rotate URL
        </button>
      </header>
      {error && <div className="error notice">{error}</div>}
      <section className="toolbar card">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names, addresses, notes..." />
        <div className="filter-row">
          {tags.map((tag) => (
            <button type="button" className={`chip ${selectedTags.includes(tag.name) ? 'active' : ''}`} key={tag.id} onClick={() => toggleTag(tag.name)}>
              {tag.name} <small>{tag.usage_count}</small>
            </button>
          ))}
          {selectedTags.length > 1 && (
            <button type="button" className="mode-toggle" onClick={() => setMode(mode === 'all' ? 'any' : 'all')}>
              Match {mode === 'all' ? 'all' : 'any'}
            </button>
          )}
        </div>
        <div className="view-toggle" role="group" aria-label="Place view">
          <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>
            List
          </button>
          <button type="button" className={view === 'map' ? 'active' : ''} aria-pressed={view === 'map'} onClick={() => setView('map')}>
            Map
          </button>
        </div>
      </section>
      <div className="columns">
        <form className="card add-card" onSubmit={addPlace}>
          <h2>Add a place</h2>
          <div className="google-tools">
            <label htmlFor="google-place-search">Find a place on Google</label>
            <input
              id="google-place-search"
              value={googleQuery}
              onChange={(event) => {
                setGoogleQuery(event.target.value);
                setError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              placeholder="Search restaurants or places"
            />
            {googleSearching && <p className="muted">Searching Google Places…</p>}
            {googleCandidates.length > 0 && (
              <div className="candidate-results">
                {googleCandidates.map((candidate) => (
                  <button type="button" className="candidate" key={candidate.google_place_id} onClick={() => useGoogleCandidate(candidate, 'google')}>
                    <strong>{candidate.name}</strong>
                    {candidate.address && <span>{candidate.address}</span>}
                  </button>
                ))}
              </div>
            )}
            <label htmlFor="google-maps-link">Paste a Google Maps link</label>
            <div className="link-input">
              <input
                id="google-maps-link"
                value={linkUrl}
                onChange={(event) => {
                  setLinkUrl(event.target.value);
                  setError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
                placeholder="https://maps.app.goo.gl/..."
              />
              <button type="button" className="secondary-button" onClick={resolveLink} disabled={linkResolving}>
                {linkResolving ? 'Resolving…' : 'Resolve'}
              </button>
            </div>
            {linkCandidate && (
              <button type="button" className="candidate selected-candidate" onClick={() => useGoogleCandidate(linkCandidate, 'link')}>
                <strong>{linkCandidate.name}</strong>
                {linkCandidate.address && <span>{linkCandidate.address}</span>}
                <small>Use this place</small>
              </button>
            )}
          </div>
          <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Place name" />
          <input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="Address (optional)" />
          <div className="coordinate-row">
            <input type="number" step="any" min="-90" max="90" value={form.lat} onChange={(event) => setForm({ ...form, lat: event.target.value })} placeholder="Latitude (optional)" />
            <input type="number" step="any" min="-180" max="180" value={form.lng} onChange={(event) => setForm({ ...form, lng: event.target.value })} placeholder="Longitude (optional)" />
          </div>
          <textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Notes (optional)" maxLength={2000} />
          <TagInput tags={tags} value={form.tags} setValue={(next) => setForm({ ...form, tags: next })} />
          <button type="submit">Save place</button>
        </form>
        {view === 'map' ? (
          <section className="map-panel card">
            {places.length === 0 ? (
              <div className="empty map-empty">No places match the current filters, so there is nothing to map.</div>
            ) : (
              <>
                <p className="map-summary">
                  Showing {places.filter(hasCoordinates).length} of {places.length} matching {places.length === 1 ? 'place' : 'places'} on the map.
                  {places.filter((place) => !hasCoordinates(place)).length > 0 && (
                    <> {places.filter((place) => !hasCoordinates(place)).length} {places.filter((place) => !hasCoordinates(place)).length === 1 ? 'place has' : 'places have'} no coordinates.</>
                  )}
                </p>
                <MapView places={places} />
              </>
            )}
          </section>
        ) : (
          <section className="places">
            {places.length === 0 ? <div className="empty card">No places match yet. Add your first one.</div> : places.map((place) => (
              <article className="place card" key={place.id}>
                {editingId === place.id ? (
                  <form className="edit-form" onSubmit={(event) => editPlace(event, place.id)}>
                    <input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} placeholder="Place name" />
                    <input value={editForm.address} onChange={(event) => setEditForm({ ...editForm, address: event.target.value })} placeholder="Address (optional)" />
                    <textarea value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} placeholder="Notes (optional)" maxLength={2000} />
                    <TagInput tags={tags} value={editForm.tags} setValue={(next) => setEditForm({ ...editForm, tags: next })} />
                    <div className="edit-actions">
                      <button type="submit">Save changes</button>
                      <button type="button" className="delete-link" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="place-heading">
                      <div>
                        <h2>{place.name}</h2>
                        {place.address && <p className="muted">{place.address}</p>}
                      </div>
                      <div className="place-actions">
                        <button type="button" className="delete-link" onClick={() => beginEdit(place)}>Edit</button>
                        <button type="button" className="delete-link" onClick={() => removePlace(place.id)}>Delete</button>
                      </div>
                    </div>
                    {place.notes && <p>{place.notes}</p>}
                    <div className="chips">{place.tags.map((tag) => <span className="chip" key={tag.id}>{tag.name}</span>)}</div>
                  </>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function App() {
  const match = window.location.pathname.match(/^\/l\/([^/]+)$/);
  return match ? <ListPage slug={decodeURIComponent(match[1])} /> : <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
