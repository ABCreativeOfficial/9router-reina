# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** ~938 pass, ~64 fail. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red:
> - 26 catalogued in `tests/__baseline__/known-fails.txt` (rtk, oauth-cursor-auto-import, translator-request-normalization, …).
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).

## Custom Fork / Reina Development Notes

Everything below is settled convention for this fork. Treat it as agreed — don't re-derive it, re-audit the remotes, or re-explain it back to the user.

### Git layout

This is a custom fork of `https://github.com/decolua/9router.git`.

| | |
|---|---|
| `upstream` | official `decolua/9router` (fetch only) |
| `upstream/master` | official branch |
| `master` | clean official baseline — **never** put custom work here |
| `origin` | the user's own fork |
| `custom` | development/production branch for all custom work |

`git rerere` is enabled to replay repeated conflict resolutions across rebases.

Pulling upstream in:
```bash
git fetch upstream
git checkout master
git merge --ff-only upstream/master

git checkout custom
git rebase master
```
Then verify statically (see below) and, if the rebase rewrote history, `git push --force-with-lease origin custom`.

Never `reset --hard`, delete a branch, or `push --force` without first proving the worktree is safe. Use `--force-with-lease`, never bare `--force`.

### Custom feature: Per-Account Model Access

Lets each provider connection declare which models it may serve, so a request only enters the account pool of connections allowed to serve that model.

**Canonical persistence** — `connection.providerSpecificData.enabledModels`, a string array. There is deliberately no second field:
- missing → unrestricted (legacy behavior)
- empty → unrestricted (legacy behavior)
- non-empty → the account is eligible **only** for those models

Semantics:
- Per **model**, not per thinking level. An entry grants its model at every level, because `m(level)` is a request-time suffix on the model `m`. A stored `m(level)` is normalized to `m` on read and write.
- No Free/Plus/Pro mapping anywhere. The user's per-account selection is the only authority.
- Provider-agnostic — nothing is specific to ChatGPT/Codex.

**Routing enforcement** — `src/sse/services/auth.js`, inside `getProviderCredentials()`, filters the connection list *before* lock/exclude filtering and before any selection strategy. An ineligible account therefore never reaches round-robin, fill-first, priority, sticky/pin, or retry/fallback selection. Zero eligible accounts returns `null` (the pre-existing "no credentials" contract), which `src/sse/handlers/chat.js` refines into a `no_eligible_account_for_model` message for a direct model request.

Where the code lives:
- `src/sse/services/accountModelPolicy.js` — all policy logic (sanitize, eligibility, `/v1/models` union, no-eligible-account reason). Keep new policy logic here.
- `src/shared/components/ModelAccessModal.js` — the UI, a standalone modal opened from a **Models** action beside Edit on each connection row (`src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js`). It is deliberately **not** part of Edit Connection.
- `src/shared/utils/providerModelCatalog.js` — one catalog builder shared by the provider page's Available Models grid and the modal, so the two lists cannot drift.

Two things to keep straight:
- The official **global disabled-model** feature (`src/lib/disabledModelsDb.js`, `/api/models/disabled`) is a separate concept. Don't merge them or repurpose one as the other. The modal shows globally-disabled models labelled rather than hidden.
- `/v1/models` exposes the **union** across a provider's active accounts: a model stays listed while at least one account can serve it, and any unrestricted account keeps the full catalog visible. Never let one account's restriction hide a model globally.

### Keep the upstream conflict surface minimal

The point of this fork's structure is that a future `git rebase master` mostly applies cleanly.

Prefer: a new module/helper; a small integration hook in an existing function; reuse of the existing repo/db/provider abstractions.

Avoid: rewriting official routing; large refactors; a duplicate subsystem alongside an official one; hardcoded provider/model/plan tables; edits under `open-sse/` unless genuinely required (and read `open-sse/AGENTS.md` first if so).

### Verification policy — static only by default

For normal development tasks, verify **statically**. Do not start a server to check your work. Do not run `npm run dev`, `npm start`, `next dev`, any HTTP server, or a browser/manual smoke test unless the user explicitly asks for a runtime or integration test.

Default verification:
1. targeted unit tests for the area you changed
2. any other relevant Vitest tests
3. `npm run build`
4. ESLint on the changed files, where relevant
5. static inspection / code-path reading

For the model-access feature that means:
```bash
cd tests && npx vitest run unit/account-model-policy unit/provider-model-catalog
npm run build          # from repo root
```
plus lint scoped to the files you touched.

### Do not baseline-compare against clean master

Do **not** stash your changes, run the suite on a clean `master`/upstream baseline, restore, and diff the pass/fail counts. That workflow is only for an explicit request for upstream regression comparison.

The upstream suite has known failures (see the Tests section above). When one shows up, just report the targeted test result, the build result, and the lint result. If you ran a broader suite and something unrelated failed, say so in a sentence and move on — don't launch a baseline comparison to prove it was already red.

### Startup behavior

Run `git status` before making changes and read the code relevant to the task. Skip the full repository audit, and skip re-explaining the remote layout, the branch split, the fork relationship, the verification policy, or whether to baseline-compare — all of that is settled above.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
