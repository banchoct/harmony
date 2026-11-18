-- Supabase serves every table of the public schema over its web API to anyone holding the
-- project's public key. Row security with no policy shuts those roles out; the owner, which
-- is the connection Harmony uses, is not affected. Every new table must do the same
-- (a test checks it).
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
