# Backlog — webhook-listener

Open items: not-started features, deferred polish, and known limitations.
For what's already live, see `STATUS.md`. For standing dev/deploy practice,
see `CLAUDE.md`.

## Top priority — security gap from going public

**The app has no authentication and is publicly deployed.** The current
access model (anonymous `wl_session_id` cookie) was designed for a
single-user local tool (`CLAUDE.md` → Access model). That assumption broke
the moment this shipped to `webhook.fde.nice-agentic.com` on the open
internet, and it has not been revisited since. Right now, anyone who
discovers the URL can create listeners and see/manage whatever they create,
indistinguishable from the intended owner.

- **Spec exists, not implemented, no plan written yet:**
  `docs/superpowers/specs/2026-09-20-email-access-gate-design.md`.
- Adds a magic-link email gate (allow-listed to `nice.com`/`cognigy.com`)
  in front of the entire UI, and upgrades listener ownership from
  "browser session" to "verified email" so the same person can reach their
  listeners from any device.
- Supersedes the identity portion of the session-scoped-ownership spec;
  keeps that spec's cookie-plumbing *pattern* as a template.
- Next step if picked up: brainstorm → confirm scope → write the
  implementation plan → build. Don't skip straight to code — this touches
  every route.

## Not started — projects & create-and-send hook

**Spec exists, not implemented, no plan written yet:**
`docs/superpowers/specs/2026-09-20-projects-create-and-send-design.md`.

- Backend-only this round (frontend deferred to a follow-up spec).
- Adds a `projects` table (session-owned grouping) so a UAT test script can
  `POST` straight to a URL built from a runtime-known identifier and have
  the listener created + payload recorded in one call, instead of the
  current two-step `POST /api/listeners` → `PUT /api/listeners/:id/slug`.
- Requires new migration `backend/migrations/0005_projects.sql` (schema is
  fully specified in the design doc, not yet created) and splits the
  existing global slug-uniqueness index into project-scoped and
  global-scoped partial indexes.

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
- No `backend/migrations/0005*` yet — the next migration number to use is
  `0005`, reserved in the projects-feature spec above; don't let an
  unrelated change grab that number first without checking.

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
