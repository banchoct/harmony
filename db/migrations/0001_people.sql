-- People of the house: everyone Harmony knows about, user or not.
-- A user is a person with a phone. kind: who runs the home, staff, or a member
-- who is known about but does not talk to Harmony.
CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('coordinator', 'staff', 'member')),
  phone text UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
