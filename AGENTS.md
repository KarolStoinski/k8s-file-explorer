# AGENTS.md

## Repository Guidelines

- Keep the app as a lightweight Kubernetes file explorer built around the local `kubectl`.
- Do not replace `kubectl` with a Kubernetes API client unless that is an explicit project decision.
- Pass process arguments as separate arguments. Do not build shell command strings.
- Every long-running `kubectl` call must have a timeout, a console log entry, and must not block the UI.
- When listing resources, fetch only the fields needed by the current view.
- Run file transfers in the background, show them in the transfer panel, and allow cancellation.
- Do not revert local user changes or generated files outside the task scope.

## Verification

After changes, run the relevant checks:

```bash
npm run build
cargo fmt --check
cargo check
```
