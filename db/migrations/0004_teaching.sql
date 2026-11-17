-- A person who left the house keeps their row and their history but is no longer a user.
ALTER TABLE people ADD COLUMN active boolean NOT NULL DEFAULT true;

-- A retired note is kept for the record and leaves every view.
ALTER TABLE notes ADD COLUMN retired_at timestamptz;

ALTER TABLE pending_questions ADD COLUMN answered_by uuid REFERENCES people (id);

-- A change Harmony may not make alone (anything touching health). It waits here for a
-- yes or a no from whoever runs the home.
CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE,
  requested_by uuid NOT NULL REFERENCES people (id),
  action jsonb NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  outcome text CHECK (outcome IN ('confirmed', 'rejected'))
);
