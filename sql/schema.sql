-- Anatop Territory Evaluation — full database schema
--
-- Generated from the live Supabase project (unqexnqlxdmlglyuzyfs) on 2026-09-07
-- by introspecting information_schema and pg_catalog, then verified by applying
-- this file to an empty schema and diffing every column, constraint, index and
-- policy against the live one.
--
-- Until now the schema existed only as a series of migrations applied by
-- whichever session needed them, several of which have since ended. There was
-- no way to stand this project up from the repository.
--
-- Apply with:
--     psql "$DATABASE_URL" -f sql/schema.sql
--
-- Object names are deliberately unqualified so the file can also be applied
-- into a scratch schema via search_path, which is how it is tested. Everything
-- is IF NOT EXISTS, so it is safe to re-run against an existing database.

-- ---------------------------------------------------------------- users
-- Application logins for HTTP Basic auth. password_hash is scrypt (src/auth.js).
CREATE TABLE IF NOT EXISTS users (
  id            bigserial   PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  is_admin      boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- sessions
-- One evaluation. inputs_json holds the Section 0 form; decision_text is the
-- moderator's final output. owner_id gates deletion only — sessions are
-- otherwise shared by design.
CREATE TABLE IF NOT EXISTS sessions (
  id            bigserial   PRIMARY KEY,
  title         text        NOT NULL,
  product       text,
  country       text,
  inputs_json   text        NOT NULL,
  decision_text text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  model         text,
  owner_id      bigint      REFERENCES users(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------- messages
-- Every turn in the transcript. A row with text IS NULL and no error is a turn
-- in flight: that row is itself the cross-instance lock (see db.beginAgentTurn),
-- which is why text is nullable.
CREATE TABLE IF NOT EXISTS messages (
  id                 bigserial   PRIMARY KEY,
  session_id         bigint      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                integer     NOT NULL,
  role               text        NOT NULL,
  speaker            text        NOT NULL,
  mode               text,
  addressed_to       text,
  text               text,
  content_json       text,
  input_tokens       integer     DEFAULT 0,
  output_tokens      integer     DEFAULT 0,
  cache_read_tokens  integer     DEFAULT 0,
  cache_write_tokens integer     DEFAULT 0,
  searches           integer     DEFAULT 0,
  cost_usd           double precision DEFAULT 0,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  favourite          boolean     NOT NULL DEFAULT false,
  duration_ms        integer
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, seq);

-- -------------------------------------------------------------- sources
-- Every URL an agent searched or cited. kind is 'searched' or 'cited'; the
-- Sources tab and the exports default to cited only.
CREATE TABLE IF NOT EXISTS sources (
  id               bigserial   PRIMARY KEY,
  session_id       bigint      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  n                integer     NOT NULL,
  url              text        NOT NULL,
  title            text,
  kind             text        NOT NULL DEFAULT 'searched',
  first_cited_at   timestamptz NOT NULL DEFAULT now(),
  first_message_id bigint,
  cited_by_json    text        NOT NULL DEFAULT '[]',
  UNIQUE (session_id, url)
);

-- --------------------------------------------------------- disagreements
-- Logged dissent, deduplicated by normalised topic. status is 'resolved' or
-- 'unresolved' and is toggled by the human moderator.
CREATE TABLE IF NOT EXISTS disagreements (
  id         bigserial   PRIMARY KEY,
  session_id bigint      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id bigint      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  n          integer     NOT NULL,
  topic      text,
  body       text,
  status     text        NOT NULL DEFAULT 'unresolved',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- agents
-- Overlay only. Persona text lives in prompts/agents/<key>/ and is read from
-- disk; this table carries the moderator-set challenge level, the free-text
-- knowledge addition and the tool flags. A missing row means "no overlay", not
-- an error, so an agent added to the manifest works before this table knows it.
--
-- description and role are legacy columns: NOT NULL, no longer read by the
-- prompt builder. Kept so an existing database is not broken by this file.
CREATE TABLE IF NOT EXISTS agents (
  key            text        PRIMARY KEY,
  label          text        NOT NULL,
  description    text        NOT NULL DEFAULT '',
  role           text        NOT NULL,  -- legacy, and unlike description it has no default live
  knowledge      text        NOT NULL DEFAULT '',
  can_web_search boolean     NOT NULL DEFAULT true,
  can_open_url   boolean     NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  stance_default integer     NOT NULL DEFAULT 3 CHECK (stance_default >= 1 AND stance_default <= 5)
);

-- --------------------------------------------------------- app_defaults
-- Single-row table: the CHECK on a boolean primary key defaulting to true is
-- what keeps it to one row.
CREATE TABLE IF NOT EXISTS app_defaults (
  id          boolean     PRIMARY KEY DEFAULT true CHECK (id),
  values_json text        NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------ knowledge_items
-- The curated Drive knowledgebase surfaced to the agents as titles and notes.
CREATE TABLE IF NOT EXISTS knowledge_items (
  id         bigserial   PRIMARY KEY,
  category   text        NOT NULL,
  title      text        NOT NULL,
  url        text        NOT NULL,
  note       text        NOT NULL DEFAULT '',
  sensitive  boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_items_category_idx ON knowledge_items (category, id);

-- ------------------------------------------------------ meeting_minutes
-- Auto-written minutes per round. approve_token is the unguessable value in the
-- "approve the next round" email link, so it is unique.
--
-- NOTE: id and session_id are integer here, not bigint, unlike every other
-- table. That is how the live database was created and it is reproduced
-- faithfully; Postgres accepts the integer -> bigint foreign key. Worth
-- widening if these tables are ever rebuilt.
CREATE TABLE IF NOT EXISTS meeting_minutes (
  id                serial      PRIMARY KEY,
  session_id        integer     NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round             text        NOT NULL,
  label             text        NOT NULL,
  text              text        NOT NULL,
  anchor_message_id integer,
  approved          boolean     NOT NULL DEFAULT false,
  approve_token     text        NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meeting_minutes_session_id_idx ON meeting_minutes (session_id);

-- ------------------------------------------------------- autopilot_runs
-- One row per Autopilot run: multi-cycle cross-talk under moderator-set limits.
CREATE TABLE IF NOT EXISTS autopilot_runs (
  id             bigserial   PRIMARY KEY,
  session_id     bigint      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  scope          text        NOT NULL,
  disagreement_n integer,
  settings_json  text        NOT NULL DEFAULT '{}',
  cycles_run     integer     NOT NULL DEFAULT 0,
  outcome        text,
  cost_usd       double precision NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz
);
CREATE INDEX IF NOT EXISTS autopilot_runs_session_id_idx ON autopilot_runs (session_id);

-- --------------------------------------------------------------- reports
-- Generated Interim and Final reports. kind is 'interim' or 'final'; depth is
-- 'brief', 'standard' or 'full'.
CREATE TABLE IF NOT EXISTS reports (
  id         bigserial   PRIMARY KEY,
  session_id bigint      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  depth      text        NOT NULL,
  text       text,
  model      text,
  cost_usd   double precision NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_session_id_idx ON reports (session_id);

-- --------------------------------------------------------- report_emails
-- Send log for report emails (Resend).
CREATE TABLE IF NOT EXISTS report_emails (
  id          bigserial   PRIMARY KEY,
  report_id   bigint      NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  to_json     text        NOT NULL DEFAULT '[]',
  format      text        NOT NULL,
  sent_by     text,
  provider_id text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_emails_report_id_idx ON report_emails (report_id);

-- ============================================================ ACCESS ======
--
-- The application connects as a dedicated login role, NOT as the table owner
-- and NOT as a superuser, and it has no BYPASSRLS. That is deliberate, and it
-- has a consequence worth stating plainly: row-level security applies to the
-- application in full, so a policy that denies everyone denies the app too.
--
-- Create the role once, outside this file, so no password is committed:
--
--     CREATE ROLE app_user LOGIN PASSWORD '<generated>';
--     GRANT USAGE ON SCHEMA public TO app_user;
--
-- Then point DATABASE_URL at it. The grants and policies below are idempotent
-- and skip themselves when the role does not exist, so this file still applies
-- cleanly to a database where the role has not been created yet.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO app_user', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO app_user', current_schema());
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO app_user', current_schema());
  END IF;
END $$;

-- Row-level security. Every role is denied by omission: with RLS enabled and no
-- policy naming it, a role sees no rows even where it holds a GRANT. app_user
-- is the single exception because it is what the application connects as.
--
-- This is defence in depth rather than the only thing standing between the
-- outside world and the data — anon and authenticated hold no grants on these
-- tables at all, so PostgREST refuses on privileges before RLS is consulted.
-- What it buys is that a future accidental GRANT to anon is not an exposure by
-- itself.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agents', 'app_defaults', 'autopilot_runs', 'disagreements', 'knowledge_items',
    'meeting_minutes', 'messages', 'report_emails', 'reports', 'sessions',
    'sources', 'users'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user')
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies
         WHERE schemaname = current_schema() AND tablename = t AND policyname = 'app_user_all'
       ) THEN
      EXECUTE format('CREATE POLICY app_user_all ON %I FOR ALL TO app_user USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================== SEED ======
-- The app needs one agents row per agent in prompts/agents/index.json only if
-- you want a non-default challenge level or knowledge overlay; personaFor()
-- treats a missing row as "no overlay". These rows match the shipped roster.
-- agents.label here is legacy and is not what the app displays: every label the
-- UI and the exports show comes from prompts/agents/index.json, so renaming an
-- agent needs no migration of these rows.
INSERT INTO agents (key, label, role) VALUES
  ('regulatory', 'Ruth (Regulatory)',   'regulatory'),
  ('clinical',   'Luca (Clinical)',     'clinical'),
  ('commercial', 'Charlie (Commercial)','commercial')
ON CONFLICT (key) DO NOTHING;

INSERT INTO app_defaults (id, values_json) VALUES (true, '{}')
ON CONFLICT (id) DO NOTHING;
