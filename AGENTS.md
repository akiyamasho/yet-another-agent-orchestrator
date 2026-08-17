# AGENTS.md

## Purpose

This repository builds **Constellation**, a local Electron operations UI for real OpenAI Codex and Claude Code projects, tasks, and subagents.

## Non-negotiable data rules

- Packaged Electron mode must use real provider data. Never fall back to fixtures silently.
- Browser-only development mode may use `lib/data/mockData.ts`, and must remain visibly marked as demo/sync data.
- Codex history comes through `codex app-server`; do not parse private Codex storage.
- Claude history discovery is read-only during normal operation. The only permitted provider-history mutation is the explicit, guarded `Delete permanently` flow: after typed confirmation, and only while all sessions Constellation can identify as running among the selected session and its descendants have stopped, it may unlink canonical provider-discovered `.jsonl` transcript files under `~/.claude/projects` for that session and its recursively mapped descendants. Other clients’ in-memory runtime state is not observable. Never touch project files, `CLAUDE.md`/memories, credentials, settings, or unrelated caches.
- Claude archive/remove/title behavior belongs in the explicit Electron `userData` overlay because Claude Code has no supported single-session destructive API. Archive is reversible presentation state; permanent deletion is not undoable.
- Codex permanent deletion must use the supported App Server `thread/delete` mutation for the selected thread and its recursively mapped descendants. Deleting a main agent always cascades to its subagents; never emulate deletion by editing private Codex storage.
- Never commit screenshots, logs, fixtures, or tests containing a contributor’s real project paths, prompts, transcripts, images, or task names.
- File preview/reveal IPC must accept only canonical paths under provider-discovered or user-registered project roots. Keep context isolation on and Node integration off.

## Architecture

- `app/`, `components/`: statically exported Next.js renderer.
- `lib/providers/`: provider-neutral namespaced task model (`codex:<id>`, `claude:<id>`).
- `lib/store/`: Zustand orchestration and provider dispatch.
- `electron/codex/`: Codex App Server JSONL bridge.
- `electron/claude/`: Claude Code history discovery and CLI streaming bridge.
- `electron/main.cjs`: process supervision, narrow IPC, project roots, preview/reveal.
- `docs/PRODUCT_SPEC.md`: interaction, research, and data-source contract.

Provider identity must be visible in text, not only color. Keep Codex projector blue (`#7aa7b8`) and Claude warm coral (`#d97757`).

## Commands

```bash
make dep       # install dependencies
make dev       # browser demo for renderer development
make build     # production static export
make run       # build and launch Electron
make test      # TypeScript + provider bridge tests
make release   # macOS DMG and ZIP
```

## Before committing

1. Run `make test`.
2. Run `make build`.
3. For Electron changes, launch `make run` and verify both provider health badges.
4. Keep repository screenshots synthetic; regenerate from browser demo mode only.
5. Check that no secrets, absolute personal paths, or provider transcripts are staged.

## Release invariants

- Every published version must regenerate and visually review every screenshot shown in `README.md` from the synthetic browser fixtures only.
- README screenshots must reflect the exact UI shipped in that release; never reuse stale screenshots from an earlier version.
- Never capture real provider projects, paths, prompts, transcripts, attachments, or task names for release documentation.

## Demo media policy

- Generate or refresh demo screencasts/videos only when the SemVer major component increments (for example, `1.x` to `2.0.0`), unless the user explicitly requests one.
- Minor and patch releases reuse the latest major-release screencast by default and must not spend work regenerating it.

Prefer small provider-neutral UI components, tolerant parsing at external boundaries, and explicit error states. Preserve the cinematic director-portfolio visual language and reduced-motion behavior.
