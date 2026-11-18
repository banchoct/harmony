-- An outbound message that could not be sent for a day is given up rather than delivered late.
ALTER TABLE messages ADD COLUMN abandoned_at timestamptz;
