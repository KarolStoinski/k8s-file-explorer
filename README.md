# K8s File Explorer

A desktop file explorer for Kubernetes pods, built with Tauri.

## Requirements

- Node.js
- Rust stable
- `kubectl` available in `PATH`
- kubeconfig files in `~/.kube`

## Development

Windows PowerShell may block `npm.ps1`, so use `npm.cmd` on Windows.

```powershell
npm.cmd install
npm.cmd run tauri:dev
```

macOS:

```bash
npm install
npm run tauri:dev
```

## Build

Windows:

```powershell
npm.cmd run tauri:build
```

macOS:

```bash
npm run tauri:build
```

Tauri builds the binary for the current operating system. Build Windows artifacts on Windows and macOS artifacts on macOS.

For a macOS DMG that will run on other computers, build a Developer ID signed
and notarized release. See [docs/macos-release.md](docs/macos-release.md).

## MVP Features

- Kubernetes panel on the left: kubeconfigs, namespaces, pods, containers, and files inside a pod
- local file explorer panel on the right, starting in the user's home directory
- resource listing through the local `kubectl`
- pod filesystem browsing through `kubectl exec -- ls -la`
- file and directory transfers through `kubectl cp`
- double-clicking a remote file downloads it to a temporary directory and opens it locally
