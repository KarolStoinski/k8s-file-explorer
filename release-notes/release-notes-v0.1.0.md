# K8s File Explorer v0.1.0

Release date: 2026-05-24

## Highlights

- First desktop release for browsing files inside Kubernetes pods.
- Two-pane interface: Kubernetes on the left, local file system on the right.
- Support for multiple kubeconfigs discovered in `~/.kube`.
- Navigation through namespaces, pods, containers, and directories inside a container.
- File and directory transfers through the local `kubectl cp`.
- Transfer panel with cancellation, status, progress, size, and estimated time.
- `kubectl` console with command history, execution time, and copy actions.
- Interface internationalization: Polish and English selected from the system language.
- Light and dark themes with persisted preference.
- Persisted window size, window position, last local path, and console state.

## Details

### Kubernetes

- Lists kubeconfigs from `~/.kube`.
- Lists namespaces, pods, and containers through `kubectl`.
- Browses files inside a container through `kubectl exec -- ls -la`.
- Shows a warning when a container does not have `tar`, which is required by `kubectl cp`.
- Provides context menu actions for opening, downloading, and deleting remote items.

### Local File System

- Local file explorer with directory navigation.
- Opens local files in the system application.
- Deletes local files by moving them to the trash.
- Uploads selected local files or directories to the current directory in the container.

### Transfers

- Downloads from a pod to the current local directory.
- Uploads from the local file system to a container.
- Opens a remote file by downloading it to a temporary directory.
- Measures download progress from the size of the local path being created.
- Measures file upload progress from the remote file size reported by `ls`.
- Shows approximate progress when the full transfer size cannot be determined.
- Cancels active transfers.

## Requirements

- Local `kubectl` available in `PATH`.
- Working kubeconfigs in `~/.kube`.
- Containers should have `ls` for file browsing and `tar` for transfers through `kubectl cp`.

## Known Limitations

- The application uses the local `kubectl`; it does not call the Kubernetes API directly.
- Transfer progress is approximate because `kubectl cp` does not provide native progress reporting.
- Remote directory size is not calculated recursively through `ls`, so directory progress may be less accurate.