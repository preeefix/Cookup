CREATE TABLE lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE places (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  source TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX places_list_id_idx ON places(list_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT,
  UNIQUE(list_id, name)
);

CREATE INDEX tags_list_id_idx ON tags(list_id);

CREATE TABLE place_tags (
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(place_id, tag_id)
);

CREATE VIRTUAL TABLE places_fts USING fts5(
  place_id UNINDEXED,
  list_id UNINDEXED,
  name,
  address,
  notes,
  tags
);

CREATE TRIGGER places_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(place_id, list_id, name, address, notes, tags)
  VALUES (
    new.id, new.list_id, new.name, new.address, new.notes,
    COALESCE((SELECT group_concat(t.name, ' ') FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = new.id), '')
  );
END;

CREATE TRIGGER places_au AFTER UPDATE OF name, address, notes ON places BEGIN
  DELETE FROM places_fts WHERE place_id = new.id;
  INSERT INTO places_fts(place_id, list_id, name, address, notes, tags)
  SELECT p.id, p.list_id, p.name, p.address, p.notes, COALESCE(
    (SELECT group_concat(t.name, ' ') FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = p.id), ''
  )
  FROM places p WHERE p.id = new.id;
END;

CREATE TRIGGER places_ad AFTER DELETE ON places BEGIN
  DELETE FROM places_fts WHERE place_id = old.id;
END;

CREATE TRIGGER place_tags_ai AFTER INSERT ON place_tags BEGIN
  DELETE FROM places_fts WHERE place_id = new.place_id;
  INSERT INTO places_fts(place_id, list_id, name, address, notes, tags)
  SELECT p.id, p.list_id, p.name, p.address, p.notes, COALESCE(
    (SELECT group_concat(t.name, ' ') FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = p.id), ''
  )
  FROM places p WHERE p.id = new.place_id;
END;

CREATE TRIGGER place_tags_ad AFTER DELETE ON place_tags BEGIN
  DELETE FROM places_fts WHERE place_id = old.place_id;
  INSERT INTO places_fts(place_id, list_id, name, address, notes, tags)
  SELECT p.id, p.list_id, p.name, p.address, p.notes, COALESCE(
    (SELECT group_concat(t.name, ' ') FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = p.id), ''
  )
  FROM places p WHERE p.id = old.place_id;
END;

CREATE TRIGGER tags_au AFTER UPDATE OF name ON tags BEGIN
  DELETE FROM places_fts WHERE place_id IN (SELECT place_id FROM place_tags WHERE tag_id = new.id);
  INSERT INTO places_fts(place_id, list_id, name, address, notes, tags)
  SELECT p.id, p.list_id, p.name, p.address, p.notes, COALESCE(
    (SELECT group_concat(t.name, ' ') FROM place_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.place_id = p.id), ''
  )
  FROM places p
  WHERE p.id IN (SELECT place_id FROM place_tags WHERE tag_id = new.id);
END;
