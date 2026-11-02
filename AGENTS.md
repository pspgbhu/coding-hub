# Coding Hub contributor instructions

- Use pnpm and Conventional Commits.
- Keep filesystem, process execution, Git, and credentials out of the renderer. Extend the typed preload API instead of exposing generic IPC.
- Agent adapters drive the user's installed CLI. Preserve native session IDs, per-turn item identity, cancellation, and permission requests.
- Preserve unsaved editor content and running terminals when panels are hidden or sessions change.
- Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` for changes affecting the desktop flow. Native-module tests run through Electron's Node runtime via the test script.
- Live account tests are opt-in (`CODING_HUB_LIVE_SMOKE=1`); normal tests use isolated temporary projects and protocol fixtures.
- Never log or store authentication tokens. Keep diagnostics actionable and redact credentials.
- Only macOS and native Windows are supported. Do not introduce WSL integration.
