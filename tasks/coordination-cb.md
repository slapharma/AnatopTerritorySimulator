# Coordination note — session cb (b8e017), 2026-09-04

Session title: "Knowledgebase document list". Scope: built an admin-editable
knowledgebase of curated Drive documents (Anatop clinical/regulatory/PV
sources) and wired it into the three debate agents' system prompt.

## Files touched
- `src/db.js` — added `listKnowledgeItems`, `createKnowledgeItem`,
  `updateKnowledgeItem`, `deleteKnowledgeItem` (new functions, appended before
  `module.exports`; did not touch `addMessage`/`withSessionLock`).
- `src/app.js` — added `GET/POST /api/knowledge` and `PATCH/DELETE
  /api/knowledge/:id` routes (new block, inserted between the `/api/agents`
  and `/api/defaults` routes; did not touch `assembleText`, the disagreement
  regex, or the turn/SSE handler).
- `src/prompts.js` — added `knowledgeBlock()` and one line in `systemPrompt()`
  that appends it for the regulatory/clinical/commercial agents (not the
  moderator). Composed cleanly with the disagreement-log addition already
  present when I re-read the file.
- `public/admin.html` — new "Knowledgebase" section below Users: view-only
  table for everyone, add/edit/delete for admins.
- `agent knowledgebase/drive-document-index.md` — new file, added into the
  `agent knowledgebase/` folder. Correction (per session `local_851f4e70`):
  that folder + its README.md were created by that session, earlier today,
  as the first thing it did — it just predates this session's first
  `git status`, so it looked pre-existing from here. Not a conflict.

## New DB objects (Supabase project `unqexnqlxdmlglyuzyfs`)
- Table `public.knowledge_items` (id, category, title, url, note, sensitive,
  created_at, updated_at) + index on (category, id). Seeded with 121 rows.
  Migrations: `create_knowledge_items`, `seed_knowledge_items`.

## Status
Done. Not verified live in-browser — `npm install` collided with a
concurrent install from another session on this shared working tree
(EBADF/EPERM errors, `node_modules` not fully installed as of this note).
Verified instead with `node --check` on the three edited `src/*.js` files
and by querying the seeded rows back from Supabase directly.

If your work also touches `src/app.js`, `src/db.js`, or `src/prompts.js`,
the above should tell you exactly which lines are mine so we don't need to
re-diff from scratch. Reply here or via session message if anything above
looks like it'll collide with what you're doing.
