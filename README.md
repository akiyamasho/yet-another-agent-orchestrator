# Yet Another Agent Orchestrator

**Constellation** is a local-first Electron command center for real Codex and Claude Code projects, tasks, chats, and subagents. It combines a cinematic spatial map with practical list, activity, search, task, transcript, changed-file, image-preview, and Reveal-in-Finder workflows.

No local web server is needed after installation.

![Synthetic demo of the spatial project map](docs/screenshots/constellation-demo-map.png)

<details>
<summary>More screenshots — synthetic demo data only</summary>

![Provider-aware task list using synthetic data](docs/screenshots/constellation-demo-list.png)

![Task inspector using synthetic data](docs/screenshots/constellation-demo-inspector.png)

</details>

> All repository screenshots use the synthetic fixtures in `lib/data/mockData.ts`. They contain no real project paths, tasks, transcripts, or artifacts.

## What works

- Spatial folder → main task → nested subagent map with smooth focus and progressive disclosure.
- Dense list, cross-project activity feed, and `⌘K` command search.
- Provider identity everywhere: Codex is projector blue; Claude Code is warm coral.
- Real Codex task discovery, transcript reads, live notifications, start, rename, settings, archive, restore, and delete through `codex app-server`.
- Real Claude Code project/session discovery, transcript reads, start, resume, and bounded subagent delegation through the local `claude` CLI.
- Provider-neutral task/plan state, messages, commands, changed files, and image artifacts.
- Secure in-app image thumbnails/enlarged previews and **Reveal in Finder** links.
- A packaged macOS app that loads its static Next.js renderer directly—no `pnpm start`.

## Data-source honesty

Codex uses the supported App Server protocol and never parses private Codex storage. Claude Code currently has no equivalent history server, so Constellation reads the user-owned local Claude JSONL history **read-only** and uses the official CLI for real new/resumed sessions.

Claude Code also has no supported single-session destructive-delete API. Its title, archive, and “Remove from Constellation” actions are explicit app-local overlays; the underlying Claude transcript remains untouched and resumable. Browser development mode uses clearly marked synthetic fixtures. Packaged Electron mode never silently swaps real provider data for dummy data.

## Install the macOS app

Download the latest `.dmg` or `.zip` from [GitHub Releases](../../releases/latest), then drag `Constellation.app` into `/Applications`.

The current community build is unsigned/not notarized. First try **Control-click → Open → Open** in Finder. If macOS still blocks a release you downloaded from this repository, you can remove only its quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/Constellation.app
```

Security disclaimer: `xattr -dr com.apple.quarantine` bypasses macOS’s first-launch quarantine check for that app bundle. It does **not** verify the author or make the app signed. Use it only after confirming the download came from this repository’s Releases page; never apply it broadly to `/Applications` or another directory.

Requirements at runtime: a working local `codex` installation, a working local `claude` installation, or both. A provider can be offline while the other remains usable.

## Develop

Requirements: macOS and Node.js.

```bash
make dep       # npm install
make dev       # browser renderer with synthetic demo data
make build     # production static export
make run       # build and launch Electron
make test      # typecheck + provider tests
make release   # build macOS DMG + ZIP
```

The direct npm scripts remain available in `package.json`.

## Privacy and security

- Electron uses context isolation, sandboxing, no renderer Node integration, and a narrow preload API.
- Preview/reveal canonicalizes paths and only allows files beneath a provider-discovered or explicitly registered project root.
- Image preview accepts supported local image formats up to 25 MB and returns a decoded data URL; the renderer receives no arbitrary filesystem API.
- Registered folders and Claude presentation overlays live in Electron `userData`. Provider-owned histories remain the source of truth.

## Documentation

- [Product and interaction spec](docs/PRODUCT_SPEC.md)
- [Contributor/agent rules](AGENTS.md)

The UX research and implementation choices are grounded in the [OpenAI Codex App Server](https://developers.openai.com/codex/app-server), [OpenAI Codex projects/chats](https://learn.chatgpt.com/codex/projects), and [Anthropic Claude Code CLI](https://code.claude.com/docs/en/cli-usage) documentation.

## License

MIT
