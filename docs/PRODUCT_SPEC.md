# Constellation — Codex + Claude Code Agent Orchestration UI

Status: implementation-ready Electron product spec
Date: 2026-08-16
Reference study: `company.mp4` (48.9 s, 720×1280, 30 fps)

## 1. Product statement

Constellation is a local-first command center for people running Codex and Claude Code across many repository folders. It turns folders, main tasks, and their subagents into a spatial map, while retaining the precise controls of an operations console.

The core promise is: **see every project, understand every delegation tree, and act on the agent that needs you in two clicks or less.**

The shipped desktop app is an Electron client for the local Codex App Server and Claude Code CLI/history. The normal data source is the user’s real provider-owned task history and live notifications; representative data is permitted only in the browser development preview as an explicit demo fallback.

Provider identity is never inferred from color alone. Every task id is namespaced as `codex:<thread-id>` or `claude:<session-id>`, and every map node, list row, inspector, command result, and folder aggregate carries a text provider label. Codex uses projector blue; Claude Code uses warm coral.

## 2. Reference-video findings

The video presents an “AI company map” with these interaction and visual ideas:

- A dark, full-bleed spatial canvas with a subtle particle field and a quiet central “brain.”
- Large labeled domains arranged as colored constellations around the center.
- Each domain has a strong colored hub and a branching tree of white circular nodes.
- The camera glides horizontally between domains and smoothly zooms from overview to one selected domain.
- At domain level, large faint typography provides place/context while agent nodes become labeled and actionable.
- Selecting a node opens a dense inspector overlay without permanently leaving the map.
- The inspector describes what an agent does, its inputs/dependencies, degree of autonomy, human role, and current status.
- Motion is slow, interpolated, and spatially coherent: selection changes scale and framing instead of hard-cutting screens.

What to preserve:

- Constellation metaphor, dark indigo atmosphere, colored context hubs, thin luminous connections, camera-led drill-down, and a high-information inspector.

What to improve for an agent operations product:

- Persistent project/folder navigation, text search, accessible non-spatial views, explicit agent state, approvals/errors that cannot be hidden in the graph, and obvious create/edit/delete controls.

## 3. Research synthesis and design principles

### 3.1 Real Codex concepts

Official OpenAI documentation defines a subagent workflow as a main thread delegating bounded work to specialized agent threads. The product should expose each child thread, its status, returned summary, and parent relationship. Subagents inherit the parent permission mode; approval requests may originate in an inactive thread, so approvals need a global surface with source context. Custom agents have names, descriptions, instructions, optional model/reasoning settings, and project- or personal-level scope.

Source: [OpenAI — Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### 3.1.1 Live Codex source of truth

Constellation must not invent a second task database. Electron launches `codex app-server` as a long-lived child process and communicates over its bidirectional JSONL/JSON-RPC-lite stdio protocol. The App Server is the supported interface for rich Codex clients and exposes authentication, conversation history, approvals, and streamed agent events. See [OpenAI — Codex App Server](https://developers.openai.com/codex/app-server).

The App Server protocol does not expose a separate first-class “project” entity for local Codex work. Constellation therefore derives its project contexts from thread working directories:

```text
project context = normalized Thread.cwd
chat/task       = Thread
subagent        = Thread.parentThreadId, or Thread.source.subAgent
```

The project label is the final path component, while the absolute `cwd` remains visible in the rail and inspector. Every chat shown under a project must come from `thread/list`/`thread/read` for that `cwd`; an empty project is allowed only when the user explicitly adds a folder context. This matches Codex’s documented behavior: the CLI treats the launch directory as the project for a chat and each chat retains its recorded working directory. See [OpenAI — Projects and chats](https://learn.chatgpt.com/codex/projects).

Thread hierarchy uses `parentThreadId` as the authoritative direct edge. When present, the structured `source.subAgent.thread_spawn` payload supplies additional provenance such as parent id, depth, role, nickname, and agent path. `source` values such as `cli`, `vscode`, `exec`, `appServer`, and subagent kinds are displayed as origin metadata, not treated as invented agent profiles.

The initial snapshot requests non-archived threads, paginating `thread/list` and grouping by exact `cwd`. Selecting a chat loads its messages/events with `thread/read` (or the corresponding turns/items pagination), rather than reading Codex’s private on-disk JSONL files directly. The Electron bridge owns the process and forwards notifications such as `thread/started`, `thread/archived`, `thread/unarchived`, `thread/name/updated`, turn/item progress, approval requests, and completion/status changes to the renderer. Reconnect must rehydrate from `thread/list` after a server restart; renderer local storage may retain view preferences only, never a competing copy of thread state.

### 3.1.2 Live Claude Code source of truth

Claude Code does not expose a Codex App Server-equivalent history API. Constellation therefore uses the official CLI for mutations and streaming (`claude -p --output-format stream-json --verbose`, `--name`, and `--resume`) and reads the user-owned, local Claude Code JSONL session history read-only to enumerate existing project chats and transcripts. It recursively discovers session sidechains/subagent records and maps their parent session where metadata or the standard `subagents` path provides it. See [Anthropic — Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage).

Starting a Claude task launches a real named CLI session in the selected folder. Adding a Claude subagent resumes the real parent session with a bounded delegation request; Constellation waits for the resulting provider history instead of inventing a renderer-only child. Models, effort, and permission mode are passed to the Claude CLI when supported.

Claude Code has no supported single-session rename/archive/destructive-delete API. Constellation therefore stores only explicit presentation overlays in Electron `userData`: a display-title override, an archived flag, or a hidden-from-Constellation flag. “Remove” never claims to erase Claude history; the confirmation states that the original transcript remains untouched and resumable. This is intentionally distinct from Codex `thread/delete`.

### 3.2 Operational UX patterns

- Keep the surrounding thread visible when inspecting an individual run. LangSmith uses thread context as the primary navigation unit and exposes inputs, outputs, timing, errors, metadata, and child runs in a details layer.
- Let users run, cancel, inspect, fork/retry, and edit configuration without reconstructing context. Visual graph and lightweight thread/chat modes serve different levels of detail.
- Model activity as a parent/child trace tree. A main task is the root operation; subagents and tool calls are child operations with their own timing, events, and status.
- Make AI easy to invoke, dismiss, correct, and globally control. Show why it acted, what context it used, and the consequences of destructive or permission-changing actions.

Sources:

- [LangSmith Studio](https://docs.langchain.com/langsmith/studio)
- [LangSmith — View traces](https://docs.langchain.com/langsmith/view-traces)
- [OpenTelemetry trace model](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [Microsoft — Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/?p=564561)

### 3.3 Graph implementation and accessibility

Use `@xyflow/react` rather than Three.js for the prototype. The source composition is 2D, while React Flow directly supports custom semantic nodes, nested groups, camera fitting, pan/zoom, selection, and hierarchical expansion. Memoize node components, render only the selected folder’s deep descendants, and reduce expensive shadows/animations at high node counts. Respect `prefers-reduced-motion` by replacing travel/scale animation with short fades and immediate camera fitting.

Sources:

- [React Flow — Performance](https://reactflow.dev/learn/advanced-use/performance)
- [React Flow — Layouting](https://reactflow.dev/learn/layouting/layouting)
- [React Flow — Prezi-style camera navigation](https://reactflow.dev/learn/tutorials/slide-shows-with-react-flow)
- [W3C — `prefers-reduced-motion`](https://www.w3.org/WAI/WCAG21/Techniques/css/C39.html)

Scale path: if a future live source requires more than ~1,000 simultaneously visible nodes, replace the overview renderer with Sigma.js/WebGL and retain the same inspector/data model. The normal interaction should avoid showing this many nodes by progressive disclosure.

## 4. Information architecture

```text
Workspace (“All folders”)
├── Folder / project context
│   ├── Main task / root agent thread
│   │   ├── Subagent thread
│   │   │   └── Nested subagent thread
│   │   └── Subagent thread
│   └── Main task / root agent thread
└── Folder / project context
```

Separate but cross-linked entities:

- `Folder`: local project path and color identity.
- `AgentThread`: a running or historical task. A thread can have a parent thread.
- `AgentProfile`: reusable agent configuration (name, role, model, effort, instructions, skills).
- `Event`: status transition, tool call, checkpoint, message, approval, error, or completion.
- `AttentionItem`: approval, user input request, conflict, or error requiring action.

## 5. Primary screen

### 5.1 App frame

- Full viewport, near-black indigo canvas.
- Slim left rail (72 px collapsed, 248 px expanded) for folder contexts.
- Top command bar centered above the canvas.
- Bottom-left map controls and keyboard hints.
- Right inspector sheet (420–480 px) overlays the canvas on selection.
- Global attention button at top right with badge count.

### 5.2 Left folder rail

- Product mark + “Constellation.”
- “All folders” overview.
- One folder item per context: colored sigil, folder name, abbreviated path, active/attention counts.
- Add folder button.
- Bottom: Settings and collapsed/expanded control.
- Current context uses both a filled background and its folder color; color is never the only selection indicator.

### 5.3 Top command bar

- Breadcrumb: `All folders / agent-orchestration / Landing redesign`.
- Segmented view control: `Map`, `List`, `Activity`.
- Search / command trigger (`⌘K`).
- “New agent” primary action.
- Attention bell with aggregate approval/error badge.

### 5.4 Map overview

- A quiet animated core in the center represents all local agent projects.
- Folders are arranged radially around it, each with a labeled colored hub.
- Main agents occupy a circular ring around the selected folder hub. Only the selected root expands its subagent descendants into an outward angular branch, preventing labels from colliding with the project name.
- Connectors are thin radial rays. Solid rays connect projects to main agents; lighter dashed rays connect subagents. There are no org-chart arrowheads or rectangular routing elbows.
- Far zoom: folder hub, name, aggregate counts, status mixture.
- Mid zoom: main agents, short task labels, state rings, immediate subagent count.
- Near zoom: subagent labels, handoff edges, runtime, and tiny activity markers.
- Empty space supports drag-to-pan; wheel/pinch zooms; double-click background fits overview.
- Clicking a folder performs a 500–650 ms ease-out `fitView` transition and expands its tree.
- Clicking a thread focuses it, highlights its ancestry/descendants, dims unrelated nodes, and opens the inspector.
- `Esc` closes the inspector, then moves up one spatial level. `Shift+1` fits overview; `F` fits selection.

### 5.5 Visual encoding

Folder identity:

- Each folder gets a stable accent: cyan, violet, coral, amber, mint, or rose.
- The color is repeated on the rail sigil, hub, breadcrumb dot, edge near the root, and inspector eyebrow.

Thread status:

- `running`: rotating segmented ring and subtle pulse.
- `waiting`: amber pause glyph and slow breathing ring.
- `needs_attention`: coral double ring plus badge; never pulse-only.
- `completed`: mint check and quiet solid ring.
- `failed`: red broken ring and error glyph.
- `idle`: gray outline.

Hierarchy:

- Folder hub: 64–76 px.
- Main thread: 42–50 px with icon/avatar and visible label.
- Subagent: 20–30 px with shorter label; nested children decrease once, then remain legible.
- Solid line = delegation. Dotted line = dependency/handoff. Animated edge particle = currently exchanging work.

## 6. Inspector behavior

The inspector is the operational anchor and must not move with the canvas.

Header:

- Folder accent + folder name/path.
- Thread title and readable task key (`AO-17`).
- Status, elapsed time, model, reasoning effort.
- Overflow menu: duplicate, move context, archive, delete.

Tabs:

1. `Overview`
   - Current objective and latest one-line progress summary.
   - Parent thread link, child count, branch/worktree, permission mode.
   - Compact “What it is doing now” card.
   - Primary actions based on state: `Open thread`, `Steer`, `Pause/Resume`, `Stop`.
2. `Subagents`
   - Child threads in a nested list with status, model, elapsed time, and latest summary.
   - Select a child to refocus the map without closing the inspector.
   - `Add subagent` with a bounded-task composer.
3. `Activity`
   - Chronological event stream with filters: messages, tools, files, approvals, errors.
   - Parent/child indentation and timestamps.
4. `Output`
   - Provider transcript messages, task/plan state, command output, changed files, summaries, test results, and final response.
   - Local image artifacts render as in-app thumbnails and an enlarged preview.
   - Every verified local artifact has a `Reveal in Finder` action. Relative paths resolve against the task’s recorded project `cwd`.

File access is mediated by narrow Electron IPC. The renderer cannot read arbitrary files: preview/reveal accepts only canonical paths under a project root already discovered from a provider task or explicitly registered by the user. Preview is limited to supported image formats and 25 MB; the main process returns a decoded data URL instead of exposing `file://` access.

### 6.1 Continue the selected chat

- A persistent composer remains at the bottom of the inspector for every non-archived main agent and subagent.
- `Enter` sends; `Shift+Enter` inserts a newline. The composer accepts up to 10 explicitly selected local files, each capped at 25 MB, and shows removable attachment chips before sending.
- Codex resumes the exact provider thread. If the latest turn is active, Constellation uses `turn/steer` with its expected turn id; otherwise it starts a new turn. Images are sent as App Server `localImage` input items, while other files are supplied as canonical project paths in the text input.
- Claude Code resumes the exact session with `claude -p --resume <session-id>`. Attachments use explicit `@path` references and `--add-dir` grants when a selected file is outside the task cwd.
- Sending never creates a renderer-only continuation. The transcript refreshes from the provider source of truth and continues updating from live notifications.

Attention state:

- When approval or input is required, pin an “Action required” card above tabs.
- Show exact originating subagent, requested action, scope/consequence, and `Approve once`, `Always allow…`, `Reject` actions.

## 7. CRUD flows

### Add folder

- `Add folder` opens a dialog with folder name, path, color, and optional default permission mode.
- Validate that the selected path is absolute and readable. The path becomes a local project context and is immediately queried via `thread/list`; its chats are never seeded by the UI. Persist only the context’s display color/name and preferences locally.
- New folder animates from the center into an open radial slot.

### Create main agent

- Available from the selected folder or global `New agent` button.
- Fields: context folder, task title, objective, agent profile, model, reasoning effort, permission mode, optional branch/worktree.
- Provider is explicit: `Codex` or `Claude Code`. Preview shows the resulting provider/node identity before creation.

### Add subagent

- Available from a selected main/subagent thread.
- Parent is explicit and cannot be ambiguous.
- Fields: bounded task, expected deliverable, profile/model/effort, read-only toggle.
- When supported by the installed App Server, the new child is created through the real Codex child-thread/fork flow and receives a temporary `starting` state. Otherwise the action is disabled with an explanation; renderer-only placeholder children are not allowed.

### Update

- `Edit` uses the same form with immutable identifiers and parent context shown.
- Changes update the inspector and node label immediately; a toast includes Undo.

### Delete/archive

- Default action is Archive and calls App Server `thread/archive`; restore calls `thread/unarchive`. Threads with children explain the consequence and offer: archive tree, reparent children, or cancel. The UI must not claim that a local “delete” removed Codex history when the server only archived it.
- Pinning is Constellation presentation metadata (stored locally by thread id), because the current App Server protocol exposes archive/unarchive but no portable thread-pin mutation. It must be clearly labeled as a local view preference.
- Renaming calls `thread/setName` and changes the user-facing thread name only. It does not change the immutable thread id, `cwd`, source, parent relationship, or historical messages; if a server version does not support the method, the UI falls back to read-only title display.
- Threads with children explain the consequence and offer: archive tree, reparent children, or cancel. Destructive actions require confirmation and provide a 6-second Undo toast where the underlying operation can be reversed.
- Claude Code uses `Archive in Constellation` and `Remove from Constellation`; both are app-local overlays and never modify the underlying Claude JSONL transcript. Codex continues to use the supported App Server mutations.

## 8. Alternative views

### List

- Dense, searchable table grouped by folder.
- Columns: task, provider, status, parent, model, elapsed/finished, attention, changed files.
- Same filters and selection state as the map.
- Keyboard accessible and suitable for 100+ threads.

### Activity

- Cross-folder chronological feed.
- “Needs you” section pinned first; running updates below.
- Filter chips for folders, statuses, agents, approvals, and time.
- Selecting an event opens the same inspector and offers “Locate on map.”

## 9. Command palette

`⌘K` opens a search-first command palette:

- Search folders, task titles, task keys, agent profiles, paths, branches, and output summaries.
- Actions: new agent, add folder, fit overview, switch view, show attention, open recent thread.
- Results show folder color, status glyph, hierarchy breadcrumb, and matched field.

## 10. Prototype data model

```ts
type ThreadStatus =
  | "running"
  | "waiting"
  | "needs_attention"
  | "completed"
  | "failed"
  | "idle";

interface FolderContext {
  id: string;
  name: string;
  path: string;
  accent: string;
  defaultPermission: "read-only" | "workspace-write" | "full-access";
}

interface AgentThread {
  id: string;
  key: string;
  folderId: string;
  parentId?: string;
  title: string;
  objective: string;
  summary: string;
  profile: string;
  status: ThreadStatus;
  model: string;
  reasoningEffort: string;
  permission: string;
  branch?: string;
  startedAt?: string;
  finishedAt?: string;
  attention?: { kind: "approval" | "input" | "error"; message: string };
  source?: "cli" | "vscode" | "exec" | "appServer" | "unknown" | { custom: string } | { subAgent: unknown };
  parentThreadId?: string;
  cwd: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

interface AgentEvent {
  id: string;
  threadId: string;
  parentEventId?: string;
  type: "message" | "tool" | "file" | "approval" | "error" | "status";
  title: string;
  detail?: string;
  timestamp: string;
}
```

## 11. Technical architecture

- Electron desktop shell + Next.js App Router static export + TypeScript + React. The renderer is loaded from `out/index.html`; users launch the packaged `.app`/`.dmg`, not a manually started web server.
- Electron main process launches and supervises the user-installed `codex app-server` binary. `contextIsolation: true`, `nodeIntegration: false`, and a narrow preload IPC bridge are required. The renderer never receives arbitrary Node access or a raw child-process handle.
- The live adapter initializes the App Server, pages `thread/list`, groups threads by exact `cwd`, calls `thread/read` for selected detail, and forwards the bidirectional notification stream. It must surface authentication, missing-binary, protocol-version, and disconnected states as actionable UI, never silently substitute fake tasks.
- `@xyflow/react` for map canvas, semantic nodes, edges, pan/zoom, and `fitView` transitions.
- `motion` for inspector/dialog/toast transitions and small non-canvas choreography.
- Zustand (or a small context store) for normalized folder/thread/event state, selection, filters, and view mode.
- The repository interface is backed by a `CodexAppServerRepository` in Electron. Local storage is limited to presentation preferences (rail state, accent assignments, selected view, search, and local pin metadata):

```ts
interface AgentRepository {
  listFolders(): Promise<FolderContext[]>;
  createFolder(input: CreateFolderInput): Promise<FolderContext>;
  listThreads(folderId?: string): Promise<AgentThread[]>;
  createThread(input: CreateThreadInput): Promise<AgentThread>;
  updateThread(id: string, patch: Partial<AgentThread>): Promise<AgentThread>;
  archiveThread(id: string, strategy?: "tree" | "reparent"): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

- `createThread` maps to App Server `thread/start` followed by the initial turn, with the selected folder’s `cwd`. `updateThread` may only expose server-supported mutations (`thread/setName` and supported settings); identifiers, source, parent, and cwd are immutable in the inspector. `archiveThread` maps to `thread/archive`; restore maps to `thread/unarchive`. “New subagent” resumes the real parent and starts a turn explicitly requesting bounded delegation; the child appears only after Codex reports a spawned descendant with a parent link—never as a renderer-only placeholder.
- Keep the adapter replaceable, but keep the live adapter as the default. The browser-only Next dev preview may use the existing representative dataset behind an explicit `DEMO_DATA`/development flag and must show a `DEMO / NOT CONNECTED TO CODEX` indicator. Packaged Electron builds fail visibly into an empty disconnected state rather than loading demo data.
- No Three.js in v1. Introduce Sigma.js/WebGL only after real profiling shows SVG/DOM is the bottleneck.

### 11.1 GitHub Releases updater

- Settings exposes a manual `Check for updates` flow against this repository's latest GitHub Release. The app never performs a background download without user action.
- A compatible release contains `Constellation-<version>-<arch>.zip` and `SHA256SUMS.txt`. The app downloads both over HTTPS, matches the checksum to the exact filename, verifies SHA-256, expands to a staging directory, and validates the bundle identifier and version before offering installation.
- Installation is a transparent community-build replacement: after the user confirms, a detached helper waits for Constellation to exit, keeps a same-directory backup, moves the verified app into place, relaunches it, and deletes the backup only after a later successful launch.
- This is intentionally not presented as Apple notarization. [Electron's standard macOS auto-update path requires a code-signed application](https://www.electronjs.org/docs/latest/api/auto-updater/); unsigned releases retain the security disclaimer and manual GitHub fallback. Version 0.2.0 is the one-time manual upgrade that introduces in-app updates for subsequent releases.

Suggested source layout:

```text
app/
  page.tsx
  globals.css
components/
  shell/
  map/
  inspector/
  dialogs/
  views/
  command/
lib/
  data/
  graph/
  store/
  types.ts
```

## 12. Motion specification

- Folder focus: 550 ms cubic-bezier(.22,.8,.24,1), fit selected folder plus 12% padding.
- Thread focus: 420 ms same curve, zoom capped so labels never exceed 1.1× design size.
- Inspector: 260 ms spring-like slide/fade; canvas viewport padding updates simultaneously so the selected node remains visible.
- Node creation: 320 ms scale 0.72→1 and opacity 0→1, edge draws parent→child.
- Ambient hub pulse: 3.6 s, opacity only; no large continuous scaling.
- Active edge dash: 1.8 s linear, disabled when zoomed far out.
- Reduced motion: camera fits immediately, panels fade in 120 ms, ambient and edge animation disabled.

## 13. Responsive behavior

- Desktop ≥1180 px: rail + canvas + overlay inspector. Operational copy uses a comfortable minimum size, with a larger wide-display scale at ≥1800 px.
- Tablet 768–1179 px: collapsed rail; inspector width 400 px.
- Mobile <768 px: map remains pannable; inspector becomes a 92%-height bottom sheet; view switcher moves to bottom navigation; default to List because detailed spatial manipulation is secondary.
- Settings offers 100%, 110%, and 120% interface scaling independently of the map's pan/zoom controls.

## 14. Accessibility requirements

- Every graph node is a focusable button with accessible name: task title, status, folder, and child count.
- Visible focus rings and keyboard traversal; map controls have text tooltips.
- Status always combines color, icon, and text.
- Minimum 4.5:1 contrast for operational text; decorative constellation lines may be lower.
- Dialog focus trap, Escape behavior, and focus restoration to the invoking control.
- `aria-live="polite"` for agent state changes; approval requests use a persistent attention surface, not repeated assertive announcements.
- Honor `prefers-reduced-motion` and expose an in-app motion toggle.

## 15. Acceptance criteria

The delivered app must:

1. In Electron, open to the user’s actual non-archived Codex threads grouped by their exact `cwd`; never require four seeded folders or dummy tasks. If none are available, show a useful empty state with the connection reason and a folder picker.
2. Smoothly focus a folder, select a main agent, and refocus a subagent while preserving spatial context.
3. Provide functional Map, List, and Activity views sharing selection and filters.
4. Provide working search/command palette.
5. Create a folder context and create/edit/archive/restore a real Codex thread through the App Server; title edits use the supported name mutation and pinning is visibly local metadata. Add-subagent is enabled only when the live protocol can create a real child; otherwise it explains the limitation.
6. Display an actionable approval/attention example with correct originating hierarchy.
7. Provide responsive desktop/mobile layouts and reduced-motion behavior.
8. Pass TypeScript/build checks and have no obvious console errors. Packaged Electron launch must work without `pnpm start` or a separate web server.
9. Maintain useful controls if ambient particles or advanced motion fail.
10. Avoid placeholder-style generic dashboard visuals: no white card grid, no neon gradient headline, and no fake 3D perspective that harms readability.
11. Resume any selected Codex or Claude Code main agent/subagent from the inspector, including explicitly selected file attachments, without changing provider identity or task context.
12. Check, download, SHA-256 verify, stage, and install a compatible newer GitHub Release from Settings, while keeping unsigned-build warnings explicit.

## 16. Integration hardening plan

1. Validate protocol compatibility against the target installation with `codex app-server generate-json-schema --experimental`; gate unsupported methods rather than guessing.
2. Add steer/stop/close actions with explicit permission and confirmation behavior, mapping each to a documented App Server request.
3. Add agent-profile file editing for project `.codex/agents/*.toml` and personal agents, with schema validation and diffs; profiles remain distinct from historical chat threads.
4. Expand event normalization for terminal/diff viewers, notifications, approvals, user-input requests, and reconnect/catch-up.
5. Add migrations only for Constellation presentation metadata; Codex thread history remains server-owned.
6. Profile with real maximum folder/thread counts before selecting a WebGL overview renderer.
