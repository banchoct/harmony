-- The memory of the house: free-text notes, no catalogue.
-- audience 'all': every user of the house may see it.
-- audience 'restricted': whoever runs the home, plus the people linked as 'viewer'.
-- A health note is always restricted.
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  health boolean NOT NULL DEFAULT false,
  audience text NOT NULL CHECK (audience IN ('all', 'restricted')),
  taught_by uuid NOT NULL REFERENCES people (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT health OR audience = 'restricted')
);

-- 'about': the note speaks of this person. 'viewer': this person may see it.
CREATE TABLE note_people (
  note_id uuid NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people (id),
  role text NOT NULL CHECK (role IN ('about', 'viewer')),
  PRIMARY KEY (note_id, person_id, role)
);
