# Backlog — webhook-listener

Open items: not-started features, deferred polish, and known limitations.
For what's already live, see `STATUS.md`. For standing dev/deploy practice,
see `CLAUDE.md`.

## Not started — list view actions on the home page

**No spec, no plan, never built** — ideated in the 2026-09-19 brainstorming
session (recorded in the now-deleted `HANDOFF.md`) alongside the slug/label/
ordering feature and the email access gate (both shipped — see `STATUS.md`).
This third item was never picked up:

- Delete-with-confirm, share-with-confirm, copy share link, and copy hook
  target URL, as affordances directly on the home page listener list.
- Today these actions (where they exist at all) live only on the individual
  listener page (`/listener/:id`) — the home list is view/navigate-only.
- Likely shares a single confirm-dialog pattern across delete/share, per the
  original framing.

## Documentation catch-up — undocumented shipped feature

A full **collapsible JSON tree view** (render/wrap toggles, row striping
with an intensity control, line numbers, indent width) shipped across 8
commits (`6b4e520`..`9994d3b`) built directly, skipping the full
spec/plan cycle — a deliberate choice for this piece of work, not a process
break (the brainstorm → spec → plan cycle in `CLAUDE.md` is for
non-trivial work, not a hard requirement for everything). The one loose end:

- `STATUS.md`'s "Features shipped and live" list doesn't mention it yet —
  worth a line next time that file is touched, so the shipped-feature index
  stays accurate.

## Deferred polish / accepted-as-non-blocking

- `Home.tsx`'s list-fetch failure is fully silent (no error banner). Spec
  asked for a note; implementation chose silence; reviewed and accepted.
  Revisit only if it actually confuses a user.
- The listener list has no heading/`aria-label` — a11y polish, not
  addressed.
- Cheap test-hardening not yet built: asserting `ownerSession`/`shareToken`
  are *absent* from list responses; a repo-level test that actually
  exercises the `id DESC` tie-break path instead of avoiding it.
- No index on `listeners(owner_session)` — irrelevant at current scale,
  would be the first lever if this table ever grows large.
- `npm audit` shows pre-existing vulnerabilities in the
  `vitest`/`vite`/`esbuild` devDependency chain — dev-only, not shipped in
  either Worker, not investigated further.

## Housekeeping

- `.DS_Store` and `frontend/.DS_Store` are currently untracked in the
  working tree — add `.DS_Store` to `.gitignore` rather than letting them
  get committed by accident.
- `backend/migrations/0009_magic_links.sql` is now in use (email access
  gate, shipped 2026-09-22) — the next migration number to use is `0010`.

## Outstanding manual check

Nobody has visually confirmed this app in an actual browser — every
verification pass on every feature so far used `curl`/Worker test
harnesses, not a browser. If you have browser access:

- Create a listener, confirm it appears on the home page, confirm an
  incognito window can't see it, generate a share link and open it in
  another browser/incognito.
- Confirm the owner page's Share section reads clearly (hook URL box vs.
  share URL box).
- Open Settings on all three routes (`/`, `/listener/:id`, `/shared/:token`)
  and confirm Theme/Width/Formatter controls actually change the rendered
  view.
- Hard-refresh in Dark theme a few times on `/listener/:id` and confirm no
  flash of light background before dark paints.
- Set Compact + Indent 4, confirm exported JSON/HAR files are still
  2-space pretty-printed (untouched by display settings).
- With Line numbers on, toggle Diff only on a listener with 4+ requests and
  confirm line numbering is continuous within each row's diff (restarting
  per row is correct — continuity is required within one diff, not across
  rows).
