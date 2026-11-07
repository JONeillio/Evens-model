---
name: github-pages-data-pipeline
description: Build an app with no server — a scheduled GitHub Actions job fetches data, writes JSON into the repo, and a static site on GitHub Pages reads it. Use when starting any app that needs fresh external data but should cost nothing to run.
---

# Static site + scheduled GitHub Action = a free backend

Proven in Evens. Python engine runs on a cron, commits JSON to `docs/data/`, GitHub Pages serves `docs/`. The phone does all per-user work client-side from those files, so there is no server, no database and no hosting bill.

## Shape
- `engine/` Python, one orchestrator (`run.py`) plus small single-purpose modules.
- `docs/` the static site. `docs/data/*.json` is the engine's output; the app only reads it.
- `data/` engine state (snapshots, run logs, reference caches). Not served.
- `.github/workflows/*.yml` one workflow per cadence (e.g. daily refresh, 10-minute live poll).
- Per-user state lives in the phone's `localStorage`, never in the repo.

## Workflow rules that mattered
- **Shared `concurrency` group** (`group: data-writes`, `cancel-in-progress: false`) on every workflow that commits, so two jobs never push at once.
- **Commit-back step**: `git add data docs/data`, exit quietly if `git diff --cached --quiet`, commit as a bot, `git pull --rebase`, `git push`. Run it with `if: always()` on the main job so partial results and logs are saved even when a step fails.
- **Run tests first** in the workflow (`pytest -q tests`) so a broken engine change can't overwrite good data.
- **`workflow_dispatch` with a `task` choice input** (refresh, probe, rebuild, backtest…) gives you manual maintenance actions from the phone without new workflows. Include a `rebuild` task that re-runs the engine on the last saved snapshot and makes **zero API calls**.
- **Polling jobs must be no-ops by default.** The 10-minute scores job checks state first and calls no API unless a tracked item is live or awaiting a result; it commits nothing when nothing changed. Add a `--force` flag for manual runs.
- GitHub cron is UTC and can start minutes late. Write schedules in UTC and say so in a comment.
- In some environments `gh workflow run` fails (no GraphQL). Use `gh api -X POST repos/OWNER/REPO/actions/workflows/FILE.yml/dispatches -f ref=main -f 'inputs[task]=rebuild'`.

## Safety (the repo is public)
- API keys go in GitHub secrets and are read from env vars. The client refuses to start without them.
- **Never write raw account/status payloads to disk** — they can contain the API key and email. Store only derived fields (plan, limit, used).
- Record call logs (endpoint, params, status, billable) but never the key.

## Make it testable offline
- Give every network module a `--mock DIR` / `--root OUT` path so the whole engine can run against fixture files and write to `/tmp`.
- Keep a `tests/make_mock.py` that generates realistic mock payloads. Cheap, and it stops live runs burning quota while debugging.
- Save a compact snapshot of the raw fetch (`data/snapshot.json`) so any later logic change can be rebuilt without re-fetching.

## Degrade, don't die
- If a feed refuses (plan limit, season not available), stop calling it for the rest of the day and record `{ok:false, note, at}` in the output JSON so the UI can say so.
- If a run gets no fresh data, reuse the last snapshot and add a note saying so.
- Keep a `docs/sw.js` fallback so the app opens from cache when offline (see `phone-first-pwa`).

## Start-of-project checklist
1. Create repo, enable Pages from `/docs`.
2. Add secrets. Write the thin API client first (see `free-api-budgeting`).
3. Orchestrator writes `docs/data/latest.json`; commit a mock version so the UI can be built before any live call.
4. Workflow with `workflow_dispatch` + `rebuild` task; add cron only once a manual run works.
5. Write `CLAUDE.md` listing layout, request costs, secrets, and the exact commands to test and trigger runs.
