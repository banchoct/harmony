-- A proposal nobody answered within a day is closed as expired, so a later yes cannot
-- confirm something old.
ALTER TABLE proposals DROP CONSTRAINT proposals_outcome_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_outcome_check CHECK (outcome IN ('confirmed', 'rejected', 'expired'));
