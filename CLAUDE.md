# Harmony

New, clean codebase for Harmony. Started 2026-11-12.

## Where the product is defined

The product definition lives in Abraham's vault, not in this repo. Read these before any work:

- `~/vault/Projects/Harmony/Harmony.md`: product North Star, the closed decisions, the scope of
  the home proof (12 points), the build order (three stages), autonomy levels, success signals.
- `~/vault/Projects/Harmony/Onboarding interview.md`: the seven-question interview.
- `~/vault/Projects/Harmony/Product ideas.md`: ideas for later. Not in scope.

If something here contradicts those notes, the notes win. Decisions are recorded there, with
source and date, in the same turn.

## Rules

- Build only what is in the scope of the home proof, in the approved stage order. Anything else
  goes to Product ideas and waits for Abraham's decision.
- The old repo `~/harmony-home-pilot` is a read-only reference. Four pieces are lifted from it:
  the WhatsApp channel, voice transcription, identity by phone number, reliable delivery of
  notices. Its own rules and its ontology do not apply here.
- Identity comes from the phone number, never from the text of a message.
- No secrets and no real household data in git: no `.env`, no WhatsApp session, no real phone
  numbers, no health data, not in commits, logs or tests.
- Ask Abraham before anything that sends a message to a person in the house, touches
  production, changes a key or a variable, or deletes data.

## Before saying a step is done

Abraham asked for these to run without him having to remember (2026-11-17).

- After each step, before reporting it as done: run the tests, then `/code-review` on what
  changed, then `/simplify`. Fix what they find, or say plainly what you left and why.
- Before connecting WhatsApp, before any real household data enters the system, and before
  anything goes to production: also run `/security-review`.
- In the report for the step, say in one line which of these ran and what they found. If one
  did not run, say so.
- Once there is code to test, set the repository up so a commit is refused when the tests fail.
