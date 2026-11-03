# Coding Hub 1.0 delivery ledger

This ledger tracks the accepted product plan. A passing legacy test suite does not
prove these additions complete. Each unchecked requirement in the active sections
remains part of the goal; optional future distribution work is listed separately.

The owner clarified that the current product is for personal use. Use the existing
`internal` build and manual updates. A Developer ID / production signing certificate,
Apple notarization identity and production update feed are not required for this
delivery mode. This changes distribution requirements, not the verification status
of accessibility, physical hardware or performance.

Updated 2026-11-03. Checked implementation items below have local macOS x64
unit/service or UI evidence. They do not imply that every supported platform,
production signing, real accounts or manual accessibility have been accepted.
See [verification](verification.md) for commands, measurements and boundaries.

## A — Reliability and data protection

- [x] Persist composer drafts, contexts, editor buffers and workspace state; restore after switching/restarting.
- [x] Atomic, fingerprint-protected file saves preserve permissions, encoding and symlink boundaries.
- [x] A message must persist before CLI execution; storage failures stop scheduling and have a recovery UI.
- [x] Confirm native cancellation; supervise owned processes across runtime failure.
- [x] Coordinate canonical workspace/repository identities and prevent invisible staged commits.
- [x] Ordered DB migrations, future-schema rejection, consistent backups, integrity checks and recovery UI.

## B — Isolated workspaces

- [x] Repository/Workspace identities own files, native sessions, drafts, terminals and Git.
- [x] New Git sessions default to owned worktrees from committed HEAD; legacy native cwd is immutable.
- [x] Shared/non-Git workspaces allow one active Agent turn; independent worktrees can run concurrently.
- [x] List/compare/apply/clean worktrees with explicit conflicts and protections for edits, tasks and terminals.
- [x] No implicit credential copying, dependency installation or project-script execution.

## C — Input, execution, review, validation, delivery

- [x] Agent readiness and real capabilities distinguish installed, compatible, authenticated and discovered models. Unknown authentication remains unknown; discovery is not proof of model access.
- [x] Structured multi-file/selection/terminal/diff/image context with previews and limits.
- [x] Readable, auditable permissions; failure/retry/external resolution accurately reflected.
- [x] Turn outcomes, duration, tools, real usage, changes and verification results. Usage is shown only when the native provider reports it.
- [x] Per-turn baseline review, separate staged/unstaged diffs and fingerprint-safe undo.
- [x] Explicit cancellable verification tasks persist exit code/output and associate with turns.
- [x] Branch creation, stage selection, full commit preview, history, remote/upstream state, fetch/ff-only pull/push.

## D — Daily workflows

- [x] Create/clone/relocate/trust/remove/restore projects without silently destroying history.
- [x] Pin/filter/archive/trash/restore/export/search sessions with snippets and message navigation.
- [x] Global task inbox and privacy-preserving actionable notifications.
- [x] Quick-open, content search, file create/rename/delete, save-all, external editor and file-limit states.
- [x] Multiple terminals with attach/replay/search/context and clear create/restart/terminate controls. Live PTYs survive panel/session changes and renderer reload; process exit is not terminal persistence.
- [x] Resizable persistent layout, fonts/indent/send-key settings and command palette.
- [x] Core workflows expose keyboard navigation, named controls, focus and status announcements, with automated coverage.
- [ ] Manual screen-reader acceptance on supported platforms, including VoiceOver and NVDA.

## E — Maintenance and release

- [x] Bounded local redacted diagnostics, actionable health/error recovery and opt-in exports.
- [x] Data/space UI, seven daily backups, migration snapshots and tested restore.
- [x] Paged history, virtual rendering, Chinese search, bounded streaming and long-output loading.
- [x] Restricted untrusted folders: no project Agent/PTY/script execution before trust.
- [x] Implement update state/progress/retry, release notes, explicit download/install and safe deferred restart; provide separate internal/stable build profiles and guarded signing scripts.
- [x] Personal-use internal builds and manual replacement upgrades preserve data without requiring production signing, notarization or an update feed.
- [x] macOS x64/arm64 and Windows x64 packaged-app, install, upgrade and retained-data uninstall verification on native-architecture CI at product commit `2f01652`.
- [x] Local macOS x64 internal DMG copy/replace upgrade and removal preserve isolated user data. This excludes Gatekeeper, quarantine and production signing.
- [x] Install/upgrade/troubleshooting/privacy/compatibility/changelog/support documentation.

## Verification gates

- [x] Typecheck, meaningful unit/service tests, build, independent three-provider UI E2E and formatting on local macOS x64 and all three native CI targets; exact results are recorded separately.
- [x] Fault injection: storage, save, migration, runtime/renderer crash, cancellation and permission failures on local macOS x64.
- [x] Isolation, legacy cwd, partial/out-of-scope staging, external edits and undo protection.
- [x] Local keyboard, themes, Monaco paint/layout, terminal reload/backpressure and 150%/200% Electron zoom checks.
- [x] Local native 2× HiDPI rendering evidence: display scale factor 2, Electron zoom 1, renderer DPR 2 and matching backing pixels. This does not cover physical PPI, other hardware, display migration or manual acceptance.
- [ ] Native hardware DPI, operating-system scaling and multi-display acceptance on supported platforms.
- [ ] Benchmark: 1,000 sessions, 10,000-event conversation, 50,000 files; startup ≤5s, first page ≤1s, search p95 ≤500ms on fixed CI hardware.
- [x] Native packaged dependencies, upgrade preservation and backup recovery on all three native CI targets.

Product commit `2f01652` passed the complete native CI matrix, including actual
old-version installation, upgrade and retained-data uninstall. The remaining
quality gates require hardware DPI and multi-display checks, manual assistive-
technology use and fixed dedicated CI measurements. Native-architecture hosted
runners do not close these gates. Evidence and runnable commands are retained in
the verification record.

## Optional future public distribution

These items are deferred and unverified, rather than requirements for current
personal use:

- Production signing/notarization and Gatekeeper / SmartScreen distribution acceptance.
- A lasting HTTPS update feed and a verified real signed upgrade with safe deferred restart.
- Production signed update-failure checks, including an invalid signature and interrupted download.

The guarded stable build profile and update-signature checks remain available for
this future mode; personal use does not require weakening them.

Live account tests remain opt-in. Cloud sync, team accounts, remote execution,
Linux/WSL, extension marketplace, a full LSP, automatic cross-Agent handoffs and
external CLI history import are outside 1.0. Personal-use builds keep the internal
channel; the stable profile is reserved for a configured signed distribution.
