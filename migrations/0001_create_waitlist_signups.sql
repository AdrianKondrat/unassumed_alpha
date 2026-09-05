-- Waitlist signups.
--
-- The row is written before any email is attempted, so a Resend outage costs
-- a notification, never a signup.
--
-- Apply:  npx wrangler d1 migrations apply unassumed-alpha --remote
-- Local:  npx wrangler d1 migrations apply unassumed-alpha --local

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id               TEXT PRIMARY KEY,
  -- As typed, with the domain lower-cased. Local parts are case-sensitive per
  -- RFC 5321, so this is what you send to.
  email            TEXT NOT NULL,
  -- Fully lower-cased, for deduplication only. Nobody means a different mailbox
  -- when they capitalise their own name.
  email_normalised TEXT NOT NULL,
  -- Which form: 'hero' or 'close'. Tells you which half of the page converts.
  source           TEXT NOT NULL,
  country          TEXT,
  user_agent       TEXT,
  created_at       TEXT NOT NULL,
  -- Null means the team was never told. Query for these after any outage.
  notified_at      TEXT,
  confirmed_at     TEXT,
  unsubscribed_at  TEXT
);

-- Deduplication. The insert relies on this constraint rather than a prior
-- SELECT, so two simultaneous submissions cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_normalised
  ON waitlist_signups (email_normalised);

CREATE INDEX IF NOT EXISTS idx_waitlist_created_at
  ON waitlist_signups (created_at);

-- Partial index over the recovery query: "who did we fail to tell?"
CREATE INDEX IF NOT EXISTS idx_waitlist_unnotified
  ON waitlist_signups (created_at) WHERE notified_at IS NULL;
