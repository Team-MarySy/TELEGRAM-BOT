-- Adds explicit per-post destination selection so the visual composer can
-- let the owner choose which destinations a given draft goes to, instead
-- of always broadcasting to every enabled destination.

CREATE TABLE IF NOT EXISTS post_destinations (
  post_id INTEGER NOT NULL,
  destination_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, destination_id),
  FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY(destination_id) REFERENCES destinations(id) ON DELETE CASCADE
);

-- 'composing' lets a draft exist while the owner is still building it in
-- the visual composer, before it becomes 'draft' -> 'scheduled'/'published'.
-- SQLite has no enum constraint to alter, so this is documentation only.

CREATE INDEX IF NOT EXISTS idx_post_destinations_post
  ON post_destinations(post_id);
