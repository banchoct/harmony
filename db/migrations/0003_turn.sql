-- Every message with a person, in and out. An outbound row is written before it is sent
-- and stays unsent (sent_at NULL) until the channel accepts it, so it can be retried.
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE,
  person_id uuid NOT NULL REFERENCES people (id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  body text NOT NULL CHECK (char_length(body) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

-- What Harmony did not know and passed up to whoever runs the home.
CREATE TABLE pending_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE,
  asked_by uuid NOT NULL REFERENCES people (id),
  question text NOT NULL CHECK (char_length(question) >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

-- The log. Rows are only ever added. The code writes them from what happened,
-- never from what the model says about itself.
CREATE TABLE events (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  person_id uuid REFERENCES people (id),
  data jsonb NOT NULL DEFAULT '{}'
);
