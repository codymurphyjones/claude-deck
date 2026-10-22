# Claude Deck

A desktop command center for **Claude Code** sessions: real terminals in tabs and split panes, sign-in handling, drag-and-drop to start sessions, Codex-style review, worktree, automation and notification tooling, and a **collaboration mesh** that lets sessions working in the same folder coordinate with each other.

## Run it

```bash
npm install          # also fetches Electron and the prebuilt node-pty binary
npm run dev          # development (hot reload for the UI)
npm run build && npx electron .   # run the production build
npm run dist         # Windows installer (dist/)
npm test             # unit tests
npm run typecheck
```

You need Claude Code (`claude`) on PATH or in `~/.local/bin`; you can also set its path in Settings → General. Install `git` for the review and worktree features and `gh` for pull requests.

## Using it

- **Drop a folder anywhere** on the window to open a Claude session there. **Drop a file** and it opens in that file's folder.
  - **Shift**-drop opens the session in a new git worktree.
  - **Alt**-drop lets you pick a template first.
  - Dropping onto the *Insert* card pastes the path into the current session's prompt. Images become attachments.
- **Ctrl+K** opens the command palette. It covers sessions, chats, commands, Claude slash commands and prompt templates.
- **Ctrl+T** starts a new session. **Ctrl+\`** opens the integrated terminal. **Ctrl+Shift+G** opens the review pane. **Ctrl+Shift+Y** opens the team panel. Every shortcut can be changed in Settings → Keyboard shortcuts.
- **Sign-in:** if Claude isn't signed in, a banner offers Claude, Anthropic Console or SSO login. Sessions you open while signed out start automatically once login succeeds.

## Features

**Native chat (no terminal).** Claude sessions run Claude Code in structured streaming mode (`-p --input-format/--output-format stream-json --permission-prompt-tool stdio`), and the app renders the stream as a chat:
- **Streaming text:** replies stream in token by token. Claude's thinking shows as a collapsible section.
- **Tool calls:** consecutive tool calls fold into a one-line activity summary ("Read 3 files · Edited 2 files · Ran 1 command"). Expanded, edits show as inline syntax-highlighted diffs, commands show with their output, and subagents nest under their task.
- **Interactive cards:** permission requests are inline cards with Allow, "Always allow", Deny and "Deny with feedback". AskUserQuestion becomes an option picker. Plans come with "Approve & auto-accept edits" or "Keep planning".
- **Markdown rendering:**
  - GitHub-flavored markdown, with code blocks that are highlighted and carry file labels and copy buttons.
  - Diffs, **mermaid diagrams**, **charts** (`chart` JSON blocks), KaTeX math, and GitHub callouts.
  - `<details>` sections, and clickable `file:line` references that open in your editor.
- **UI awareness:** Claude is told how its output is rendered, so it formats for this UI. You can turn this off or add your own guidance in Settings → Chat.
- **Composer:** @file mentions, a `/` command menu fed by the CLI's real command list, pasted or dropped images, live switching of permission mode (Shift+Tab) and model, interrupt (Esc), queued follow-ups, and a context meter.
- **History:** resuming a session reloads its conversation from Claude's transcript.

**Terminals** (the integrated shell drawer, sign-in and cloud tasks):
- Rendering: real ConPTY terminals drawn with WebGL xterm.js. Output is batched to keep rendering smooth.
- Tabs: every tab stays alive, so switching is instant. Tabs can be dragged to reorder, split into up to 4 panes, or popped out into their own window.
- Clipboard and keys: copy-on-select, image paste, and Shift+Enter for a newline.
- Search: find in the terminal's scrollback.
- Recovery: if the window reloads, the terminal view is rebuilt from the session's scrollback, so sessions survive window reloads.

**Codex-style features.**
- **Organizing work:** projects and chats with pinning, renaming, archiving and full-text search over every Claude Code transcript. Multi-folder projects with per-project instructions. Quick chats.
- **Chat operations:** fork, fork into a worktree, side chats, and resume or restore tabs on launch.
- **Review pane:** Unstaged, Staged, Last-turn, Branch and Commit diffs. Stage, unstage or revert per hunk or per file. Inline comments are sent to Claude as one prompt. Commit, with an AI-drafted message, then push and create a PR.
- **Worktrees:** managed or permanent, with a choice of base branch and an option to carry uncommitted changes. `.worktreeinclude` copies ignored files into new worktrees. Old worktrees are cleaned up automatically, with a snapshot kept so they can be restored. A session can be handed off between the local checkout and a worktree.
- **Local environments:** setup scripts and header action buttons, stored in `.claude-deck/environment.json`.
- **Scheduled tasks:**
  - Kinds: standalone tasks (calendar RRULE or interval schedule), follow-ups inside an existing chat, and GitHub pull-request triggers.
  - Options: each task can run in a background worktree with its own model and permission mode.
  - Inbox: results land in an inbox that tracks unread runs and lets you pin and archive them.
- **Goals:** Claude keeps working turn after turn until the completion criteria are met, with pause, resume, edit and clear.
- **Pull request inbox:** PRs for you, assigned to you, or authored by you. Summary, changes (with "mark viewed"), checks with a "Fix" action, approve, request changes, and Review with Claude.
- **Attention and notifications:**
  - Notifications fire for finished turns, permission requests and questions.
  - An activity view lists sessions that need you.
  - A floating status buddy shows every session's state while you're in other apps.
  - The app prevents sleep while Claude is working.
- **Files and preview:**
  - Files panel: markdown, HTML, image, PDF, CSV and code previews. Select text and ask Claude to revise it.
  - Browser preview: comment on a page element, and Claude receives its selector plus a screenshot.
- **Composer:** a rich editor with @file mentions, image attachments and templates. Follow-ups can steer the current turn or queue until it ends.
- **Settings:** themes with presets and import/export, accent and background colors, contrast, Mica, fonts, a CLAUDE.md editor, usage insights, Remote Control (continue on phone or web), cloud tasks, and an Explorer context-menu entry.

**Beyond Codex: the collaboration mesh.** Sessions in the same folder, or in worktrees of the same repository, form a team automatically:
- **Awareness:** each session is told who else is active, what they are working on, which files they claimed, and which files they changed since its last turn. This arrives through injected hook context.
- **Tools:** the `deck-mesh` MCP server gives each session `mesh_peers`, `mesh_send`/`mesh_reply`/`mesh_ask`, `mesh_claim`, a shared task board (`board_*`), shared notes (`notes_*`), `mesh_wait` and `read_terminal`.
- **Edit guard:** editing a file a peer has claimed asks you first (or is blocked, depending on settings). Editing a file a peer changed since you last read it is refused until the session re-reads it.
- **Messages:** direct messages wake idle peers immediately. The wake is skipped if you typed in that session recently, and wake-ups are rate-limited.
- **Roles and presets:** lead, worker, driver and reviewer roles. A *Launch a team* dialog starts a lead plus workers (optionally each in its own worktree) and an optional reviewer that reviews every finished turn.
- **Team panel:** roster, message timeline, kanban board, claims and notes. A cross-session timeline is also available.

Not reproduced, because they are ChatGPT-platform products: Sites, dots, ChatGPT Space, Team Tasks, Gmail/Slack triggers, voice conversation mode, image generation and Appshots. Dictation uses Windows voice typing (Win+H).

## Architecture

`src/main` (Electron main):
- `pty/` holds the terminals.
- `sessions/` builds Claude's arguments, per-session hook settings and the MCP config.
- `control/server.ts` is a named-pipe RPC server that hooks and the MCP server call into.
- `mesh/` coordinates teams.
- Other modules: `git/`, `worktrees/`, `automations/`, `transcripts/`, `github/`, `auth/` and `notify/`.

`resources/` contains the Node scripts Claude runs:
- `hookRelay.cjs` forwards hook events to the app.
- `meshMcp.cjs` is the MCP server.

`src/renderer` is a React + Zustand UI. The xterm instances are managed outside React.

Hooks are injected per session with `--settings`, so your own settings and hooks still apply. App data lives in `%APPDATA%\Claude Deck`.

## Releasing & updates

- **Every merge to `master`** → the *Master build* workflow tests and builds the installer, then publishes it as a GitHub **pre-release** versioned `X.Y.(Z+1)-dev.<run>`. Installed apps on the **Latest (master)** channel download it in the background and offer a restart. Only the 15 most recent master builds are kept.
- **Tag a release** → `git tag v0.2.0 && git push origin v0.2.0` runs the *Release* workflow. It builds the installer and attaches it to a GitHub release for that tag. Apps on the **Stable** channel (the default) update to it. Bump `version` in `package.json` when you tag, so master builds keep sorting above the latest release.
- **Rolling back** → Settings → *Updates & versions* lists every published version, including recent master builds, with release notes. Installing an older one downloads it from GitHub and installs it over the current version. Auto-update then pauses until you click *Resume updates*. You can also roll back to the version you had before with one click.
- **Local build:** `npm run dist` builds the installer into `dist/` without publishing it.

Installers are unsigned, so Windows SmartScreen shows "Unknown publisher" on first run.
