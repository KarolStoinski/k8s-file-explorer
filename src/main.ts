import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition, type Monitor } from "@tauri-apps/api/window";
import { createIcons, icons } from "lucide";
import { language, locale, t, type TranslationKey } from "./i18n";
import "./styles.css";

type EntryKind = "file" | "directory" | "symlink" | "unknown";
type RemoteLevel = "kubeconfigs" | "namespaces" | "pods" | "containers" | "remote";
type TransferStatus = "running" | "success" | "failed";
type TransferDirection = "download" | "upload" | "temp";
type TransferCopyField = "source" | "destination" | "info";
type TransferProgressMode = "measured" | "estimated" | "unknown";
type ThemeMode = "light" | "dark";

interface ToolStatus {
  available: boolean;
  version: string | null;
  error: string | null;
}

interface KubeconfigEntry {
  id: string;
  name: string;
  path: string;
  isValid: boolean;
  error: string | null;
}

interface NamespaceEntry {
  name: string;
  status: string | null;
}

interface PodEntry {
  name: string;
  namespace: string;
  phase: string | null;
  ready: string;
  restartCount: number;
  containers: string[];
}

interface ContainerEntry {
  name: string;
  image: string | null;
  ready: boolean | null;
}

interface RemoteFileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number | null;
  permissions: string | null;
  owner: string | null;
  group: string | null;
  modifiedAt: string | null;
  symlinkTarget: string | null;
  canRead: boolean;
  error: string | null;
}

interface LocalFileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: number | null;
  readonly: boolean;
}

interface LocalDirectory {
  path: string;
  parent: string | null;
  entries: LocalFileEntry[];
}

interface RemoteTarget {
  kubeconfig: string;
  namespace: string;
  pod: string;
  container: string | null;
}

interface TempDownloadResult {
  localPath: string;
}

interface TransferEntry {
  id: number;
  direction: TransferDirection;
  source: string;
  destination: string;
  status: TransferStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  totalBytes: number | null;
  transferredBytes: number | null;
  progressMode: TransferProgressMode;
  progressUpdatedAt: number | null;
}

interface KubectlLogEntry {
  id: number;
  command: string;
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  startedAt: number;
  durationMs: number;
  finished: boolean;
}

interface StoredWindowSize {
  width: number;
  height: number;
}

interface StoredWindowPosition {
  x: number;
  y: number;
}

interface RemoteState {
  level: RemoteLevel;
  kubeconfigs: KubeconfigEntry[];
  namespaces: NamespaceEntry[];
  pods: PodEntry[];
  containers: ContainerEntry[];
  entries: RemoteFileEntry[];
  kubeconfig: KubeconfigEntry | null;
  namespace: NamespaceEntry | null;
  pod: PodEntry | null;
  container: ContainerEntry | null;
  tarAvailable: boolean | null;
  path: string;
  selectedIndex: number | null;
  selectedIndices: number[];
  loading: boolean;
  error: string | null;
}

interface LocalState {
  path: string;
  parent: string | null;
  entries: LocalFileEntry[];
  selectedIndex: number | null;
  selectedIndices: number[];
  loading: boolean;
  error: string | null;
}

interface ContextMenuState {
  panel: "remote" | "local";
  index: number;
  x: number;
  y: number;
}

type PrefetchTarget =
  | { kind: "namespaces"; kubeconfig: KubeconfigEntry }
  | { kind: "pods"; kubeconfig: KubeconfigEntry; namespace: NamespaceEntry }
  | { kind: "containers"; kubeconfig: KubeconfigEntry; namespace: NamespaceEntry; pod: PodEntry }
  | { kind: "remote-dir"; target: RemoteTarget; path: string }
  | { kind: "local-dir"; path: string };

interface AppState {
  kubectl: ToolStatus | null;
  remote: RemoteState;
  local: LocalState;
  transfers: TransferEntry[];
  kubectlLogs: KubectlLogEntry[];
  activeKubectlActions: number;
  contextMenu: ContextMenuState | null;
  transferColumns: number[];
  consoleExpanded: boolean;
  theme: ThemeMode;
  nextTransferId: number;
  bootError: string | null;
}

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Missing #app root");
}

const app: HTMLDivElement = appRoot;
document.documentElement.lang = language;
const THEME_STORAGE_KEY = "k8s-file-explorer-theme";
const CONSOLE_STORAGE_KEY = "k8s-file-explorer-console";
const LOCAL_PATH_STORAGE_KEY = "k8s-file-explorer-local-path";
const WINDOW_SIZE_STORAGE_KEY = "k8s-file-explorer-window-size";
const WINDOW_POSITION_STORAGE_KEY = "k8s-file-explorer-window-position";
const WINDOW_MAXIMIZED_STORAGE_KEY = "k8s-file-explorer-window-maximized";
const MIN_WINDOW_WIDTH = 1000;
const MIN_WINDOW_HEIGHT = 680;
const TRANSFER_PROGRESS_POLL_MS = 800;
const DEFAULT_ESTIMATED_TRANSFER_BYTES_PER_MS = (4 * 1024 * 1024) / 1000;

const state: AppState = {
  kubectl: null,
  remote: {
    level: "kubeconfigs",
    kubeconfigs: [],
    namespaces: [],
    pods: [],
    containers: [],
    entries: [],
    kubeconfig: null,
    namespace: null,
    pod: null,
    container: null,
    tarAvailable: null,
    path: "/",
    selectedIndex: null,
    selectedIndices: [],
    loading: false,
    error: null,
  },
  local: {
    path: "",
    parent: null,
    entries: [],
    selectedIndex: null,
    selectedIndices: [],
    loading: false,
    error: null,
  },
  transfers: [],
  kubectlLogs: [],
  activeKubectlActions: 0,
  contextMenu: null,
  transferColumns: [120, 36, 360, 360, 260],
  consoleExpanded: initialConsoleExpanded(),
  theme: initialTheme(),
  nextTransferId: 1,
  bootError: null,
};

let activeTransferResize: { index: number; startX: number; startWidth: number } | null = null;
let hoverPrefetchTimer: number | null = null;
let hoverPrefetchKey: string | null = null;
let windowPlacementSaveTimer: number | null = null;
let copiedKubectlLogId: number | null = null;
let copiedKubectlLogTimer: number | null = null;
let copiedTransferCell: { id: number; field: TransferCopyField } | null = null;
let copiedTransferTimer: number | null = null;
let estimatedTransferBytesPerMs: number | null = null;

const PREFETCH_DELAY_MS = 200;
const namespaceCache = new Map<string, NamespaceEntry[]>();
const podCache = new Map<string, PodEntry[]>();
const containerCache = new Map<string, ContainerEntry[]>();
const remoteDirCache = new Map<string, RemoteFileEntry[]>();
const localDirCache = new Map<string, LocalDirectory>();
const inflightPrefetches = new Map<string, Promise<void>>();

app.addEventListener("click", (event) => {
  void handleClick(event);
});

app.addEventListener("contextmenu", (event) => {
  handleContextMenu(event);
});

app.addEventListener("mouseover", (event) => {
  scheduleHoverPrefetch(event);
});

app.addEventListener("mouseleave", () => {
  cancelHoverPrefetch();
});

app.addEventListener("dblclick", (event) => {
  void handleDoubleClick(event);
});

document.addEventListener("mousemove", (event) => {
  resizeTransferColumn(event);
});

document.addEventListener("mouseup", () => {
  activeTransferResize = null;
});

app.addEventListener("keydown", (event) => {
  void handleKeydown(event);
});

void init();

window.setInterval(() => {
  void loadKubectlLogs();
}, 1000);

window.setInterval(() => {
  refreshRunningTransferEstimates();
}, 1000);

async function init(): Promise<void> {
  await configureBackendLanguage();
  await restoreWindowPlacement();
  registerWindowPlacementPersistence();
  render();

  try {
    const [kubectl] = await Promise.all([
      invoke<ToolStatus>("check_kubectl"),
      loadKubeconfigs(false),
      loadInitialLocalDir(),
      loadKubectlLogs(false),
    ]);
    state.kubectl = kubectl;
  } catch (error) {
    state.bootError = formatError(error);
  } finally {
    render();
  }
}

async function configureBackendLanguage(): Promise<void> {
  try {
    await invoke("set_app_language", { language });
  } catch {
    // The frontend language still drives the UI if the backend is unavailable.
  }
}

async function loadKubectlLogs(shouldRender = true): Promise<void> {
  try {
    const logs = await invoke<KubectlLogEntry[]>("get_kubectl_logs");
    if (kubectlLogsUnchanged(state.kubectlLogs, logs)) {
      return;
    }
    state.kubectlLogs = logs;
  } catch {
    return;
  }
  if (shouldRender) {
    updateKubectlRuntimeViews();
  }
}

function kubectlLogsUnchanged(current: KubectlLogEntry[], next: KubectlLogEntry[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  return current.every((entry, index) => {
    const nextEntry = next[index];
    return (
      nextEntry &&
      entry.id === nextEntry.id &&
      entry.finished === nextEntry.finished &&
      entry.success === nextEntry.success &&
      entry.durationMs === nextEntry.durationMs &&
      entry.stdout === nextEntry.stdout &&
      entry.stderr === nextEntry.stderr &&
      entry.error === nextEntry.error
    );
  });
}

function updateKubectlRuntimeViews(): void {
  const consolePanel = app.querySelector<HTMLElement>(".console-panel");
  if (consolePanel) {
    consolePanel.outerHTML = renderKubectlConsole();
  }

  createIcons({ icons });
}

async function invokeKubectl<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  state.activeKubectlActions += 1;
  render();
  try {
    await nextPaint();
    return await invoke<T>(command, args);
  } finally {
    state.activeKubectlActions = Math.max(0, state.activeKubectlActions - 1);
    render();
  }
}

async function nativeConfirm(title: string, message: string): Promise<boolean> {
  try {
    return await invoke<boolean>("confirm_dialog", { title, message });
  } catch {
    return window.confirm(message);
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement;
  const resizeHandle = target.closest<HTMLElement>("[data-transfer-resize]");
  if (resizeHandle) {
    const index = Number(resizeHandle.dataset.transferResize);
    if (Number.isFinite(index)) {
      activeTransferResize = {
        index,
        startX: event.clientX,
        startWidth: state.transferColumns[index],
      };
    }
    return;
  }

  closeContextMenu();

  const breadcrumb = target.closest<HTMLButtonElement>("[data-breadcrumb]");
  if (breadcrumb) {
    if (breadcrumb.disabled || state.remote.loading || state.activeKubectlActions > 0) {
      return;
    }
    await openRemoteBreadcrumb(breadcrumb.dataset.breadcrumb ?? "", breadcrumb.dataset.path ?? "");
    return;
  }

  const action = target.closest<HTMLButtonElement>("[data-action]");
  if (action) {
    if (action.disabled) {
      return;
    }
    if (action.dataset.action === "cancel-transfer") {
      await cancelTransfer(Number(action.dataset.transferId));
      return;
    }
    if (action.dataset.action === "copy-transfer-field") {
      await copyTransferField(Number(action.dataset.transferId), action.dataset.transferField);
      return;
    }
    if (action.dataset.action === "copy-kubectl-message") {
      await copyKubectlMessage(Number(action.dataset.logId));
      return;
    }
    await runAction(action.dataset.action ?? "");
    return;
  }

  const row = target.closest<HTMLElement>("[data-panel][data-index]");
  if (!row) {
    return;
  }

  const panel = row.dataset.panel;
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) {
    return;
  }

  if (panel === "remote") {
    state.remote.selectedIndex = index;
    state.remote.selectedIndices = updateSelectedIndices(state.remote.selectedIndices, index, event);
  } else if (panel === "local") {
    state.local.selectedIndex = index;
    state.local.selectedIndices = updateSelectedIndices(state.local.selectedIndices, index, event);
  }
  updateSelection(panel ?? "");
  updateActionButtons();
}

function closeContextMenu(): void {
  state.contextMenu = null;
  app.querySelector<HTMLElement>(".context-menu")?.remove();
}

function handleContextMenu(event: MouseEvent): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-panel][data-index]");
  if (!row) {
    return;
  }
  event.preventDefault();
  const index = Number(row.dataset.index);
  const panel = row.dataset.panel === "remote" ? "remote" : "local";
  if (!Number.isFinite(index)) {
    return;
  }
  if (panel === "remote") {
    state.remote.selectedIndex = index;
    if (!state.remote.selectedIndices.includes(index)) {
      state.remote.selectedIndices = [index];
    }
  } else {
    state.local.selectedIndex = index;
    if (!state.local.selectedIndices.includes(index)) {
      state.local.selectedIndices = [index];
    }
  }
  state.contextMenu = { panel, index, x: event.clientX, y: event.clientY };
  updateSelection(panel);
  updateActionButtons();
  renderContextMenuInPlace();
}

function updateSelectedIndices(current: number[], index: number, event: MouseEvent): number[] {
  if (event.metaKey || event.ctrlKey) {
    return current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b);
  }
  if (event.shiftKey && current.length > 0) {
    const anchor = current[current.length - 1];
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
  }
  return [index];
}

function resizeTransferColumn(event: MouseEvent): void {
  if (!activeTransferResize) {
    return;
  }
  const nextColumns = [...state.transferColumns];
  nextColumns[activeTransferResize.index] = Math.max(32, activeTransferResize.startWidth + event.clientX - activeTransferResize.startX);
  state.transferColumns = nextColumns;
  updateTransferColumnStyles();
}

function updateTransferColumnStyles(): void {
  const value = transferColumnTemplate();
  app.querySelectorAll<HTMLElement>(".transfer-header, .transfer-row").forEach((element) => {
    element.style.setProperty("--transfer-columns", value);
  });
}

function transferColumnTemplate(): string {
  const [status, direction, source, destination, infoMin] = state.transferColumns;
  return `${status}px ${direction}px ${source}px ${destination}px minmax(${infoMin}px, 1fr)`;
}

function scheduleHoverPrefetch(event: MouseEvent): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-panel][data-index]");
  if (!row) {
    cancelHoverPrefetch();
    return;
  }
  const target = prefetchTargetForRow(row);
  if (!target) {
    cancelHoverPrefetch();
    return;
  }
  const key = prefetchKey(target);
  if (hoverPrefetchKey === key || prefetchCacheHas(target) || inflightPrefetches.has(key)) {
    return;
  }

  cancelHoverPrefetch();
  hoverPrefetchKey = key;
  hoverPrefetchTimer = window.setTimeout(() => {
    hoverPrefetchTimer = null;
    void runPrefetch(target);
  }, PREFETCH_DELAY_MS);
}

function cancelHoverPrefetch(): void {
  if (hoverPrefetchTimer !== null) {
    window.clearTimeout(hoverPrefetchTimer);
  }
  hoverPrefetchTimer = null;
  hoverPrefetchKey = null;
}

function prefetchTargetForRow(row: HTMLElement): PrefetchTarget | null {
  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) {
    return null;
  }
  if (row.dataset.panel === "local") {
    const entry = state.local.entries[index];
    return entry?.kind === "directory" ? { kind: "local-dir", path: entry.path } : null;
  }
  if (row.dataset.panel !== "remote") {
    return null;
  }

  switch (state.remote.level) {
    case "kubeconfigs": {
      const kubeconfig = state.remote.kubeconfigs[index];
      return kubeconfig?.isValid ? { kind: "namespaces", kubeconfig } : null;
    }
    case "namespaces": {
      const kubeconfig = state.remote.kubeconfig;
      const namespace = state.remote.namespaces[index];
      return kubeconfig && namespace ? { kind: "pods", kubeconfig, namespace } : null;
    }
    case "pods": {
      const kubeconfig = state.remote.kubeconfig;
      const namespace = state.remote.namespace;
      const pod = state.remote.pods[index];
      return kubeconfig && namespace && pod ? { kind: "containers", kubeconfig, namespace, pod } : null;
    }
    case "containers": {
      const container = state.remote.containers[index];
      const target = remoteTargetForContainer(container);
      return target ? { kind: "remote-dir", target, path: "/" } : null;
    }
    case "remote": {
      const entry = state.remote.entries[index];
      const target = remoteTarget();
      return entry?.kind === "directory" && target ? { kind: "remote-dir", target, path: entry.path } : null;
    }
  }
}

function remoteTargetForContainer(container: ContainerEntry | undefined): RemoteTarget | null {
  const kubeconfig = state.remote.kubeconfig;
  const namespace = state.remote.namespace;
  const pod = state.remote.pod;
  if (!kubeconfig || !namespace || !pod || !container) {
    return null;
  }
  return {
    kubeconfig: kubeconfig.path,
    namespace: namespace.name,
    pod: pod.name,
    container: container.name,
  };
}

async function runPrefetch(target: PrefetchTarget): Promise<void> {
  const key = prefetchKey(target);
  if (prefetchCacheHas(target) || inflightPrefetches.has(key)) {
    return;
  }
  const promise = runPrefetchRequest(target, key);
  inflightPrefetches.set(key, promise);
  await promise;
}

async function runPrefetchRequest(target: PrefetchTarget, key: string): Promise<void> {
  try {
    switch (target.kind) {
      case "namespaces":
        namespaceCache.set(key, await invoke<NamespaceEntry[]>("list_namespaces", { kubeconfig: target.kubeconfig.path }));
        break;
      case "pods":
        podCache.set(key, await invoke<PodEntry[]>("list_pods", {
          kubeconfig: target.kubeconfig.path,
          namespace: target.namespace.name,
        }));
        break;
      case "containers":
        const containers = await invoke<ContainerEntry[]>("list_containers", {
          kubeconfig: target.kubeconfig.path,
          namespace: target.namespace.name,
          pod: target.pod.name,
        });
        containerCache.set(key, containers);
        if (containers.length === 1) {
          const remoteTarget = {
            kubeconfig: target.kubeconfig.path,
            namespace: target.namespace.name,
            pod: target.pod.name,
            container: containers[0].name,
          };
          const rootTarget: PrefetchTarget = { kind: "remote-dir", target: remoteTarget, path: "/" };
          if (!prefetchCacheHas(rootTarget)) {
            await runPrefetch(rootTarget);
          }
        }
        break;
      case "remote-dir":
        remoteDirCache.set(key, await invoke<RemoteFileEntry[]>("list_remote_dir", {
          target: target.target,
          path: target.path,
        }));
        break;
      case "local-dir":
        localDirCache.set(key, await invoke<LocalDirectory>("list_local_dir", { path: target.path }));
        break;
    }
  } catch {
    // Prefetch is opportunistic. Navigation will surface errors if the user opens the item.
  } finally {
    inflightPrefetches.delete(key);
  }
}

async function waitForPrefetch(key: string): Promise<void> {
  const prefetch = inflightPrefetches.get(key);
  if (prefetch) {
    await prefetch;
  }
}

function prefetchCacheHas(target: PrefetchTarget): boolean {
  const key = prefetchKey(target);
  switch (target.kind) {
    case "namespaces":
      return namespaceCache.has(key);
    case "pods":
      return podCache.has(key);
    case "containers":
      return containerCache.has(key);
    case "remote-dir":
      return remoteDirCache.has(key);
    case "local-dir":
      return localDirCache.has(key);
  }
}

function prefetchKey(target: PrefetchTarget): string {
  switch (target.kind) {
    case "namespaces":
      return `namespaces:${target.kubeconfig.path}`;
    case "pods":
      return `pods:${target.kubeconfig.path}:${target.namespace.name}`;
    case "containers":
      return `containers:${target.kubeconfig.path}:${target.namespace.name}:${target.pod.name}`;
    case "remote-dir":
      return `remote-dir:${target.target.kubeconfig}:${target.target.namespace}:${target.target.pod}:${target.target.container ?? ""}:${target.path}`;
    case "local-dir":
      return `local-dir:${target.path}`;
  }
}

function renderContextMenuInPlace(): void {
  app.querySelector<HTMLElement>(".context-menu")?.remove();
  const menu = renderContextMenu();
  if (menu) {
    app.querySelector<HTMLElement>(".app-shell")?.insertAdjacentHTML("beforeend", menu);
    createIcons({ icons });
  }
}

async function handleDoubleClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>("[data-panel][data-index]");
  if (!row) {
    return;
  }

  const panel = row.dataset.panel;
  if (panel === "remote" && (state.remote.loading || state.activeKubectlActions > 0)) {
    return;
  }
  if (panel === "local" && state.local.loading) {
    return;
  }

  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) {
    return;
  }

  if (panel === "remote") {
    await openRemoteIndex(index);
  } else if (panel === "local") {
    await openLocalIndex(index);
  }
}

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLElement>("[data-panel][data-index]");
  if (event.key === "Enter" && action) {
    if (action.dataset.panel === "remote" && (state.remote.loading || state.activeKubectlActions > 0)) {
      return;
    }
    const index = Number(action.dataset.index);
    if (action.dataset.panel === "remote") {
      await openRemoteIndex(index);
    } else if (action.dataset.panel === "local") {
      await openLocalIndex(index);
    }
  }

  const pathInput = target.closest<HTMLInputElement>("[data-local-path]");
  if (event.key === "Enter" && pathInput) {
    await loadLocalDir(pathInput.value, true);
  }
}

async function runAction(action: string): Promise<void> {
  if (
    (state.remote.loading || state.activeKubectlActions > 0) &&
    ["refresh-remote", "remote-up", "remote-root", "open-remote", "download", "upload", "delete-remote"].includes(action)
  ) {
    return;
  }

  if (
    state.local.loading &&
    ["refresh-local", "local-up", "local-home", "open-local", "upload", "delete-local"].includes(action)
  ) {
    return;
  }

  switch (action) {
    case "refresh-remote":
      await refreshRemote();
      break;
    case "refresh-local":
      await loadLocalDir(state.local.path || null, true, false);
      break;
    case "remote-up":
      await remoteUp();
      break;
    case "remote-root":
      resetRemoteToRoot();
      render();
      break;
    case "local-up":
      if (state.local.parent) {
        await loadLocalDir(state.local.parent, true);
      }
      break;
    case "local-home":
      await openLocalHome();
      break;
    case "open-remote":
      await openSelectedRemote();
      break;
    case "open-local":
      await openSelectedLocal();
      break;
    case "download":
      await downloadSelectedRemote();
      break;
    case "upload":
      await uploadSelectedLocal();
      break;
    case "delete-remote":
      await deleteSelectedRemote();
      break;
    case "delete-local":
      await deleteSelectedLocal();
      break;
    case "clear-transfers":
      clearFinishedTransfers();
      break;
    case "toggle-console":
      state.consoleExpanded = !state.consoleExpanded;
      saveConsoleExpanded(state.consoleExpanded);
      render();
      break;
    case "toggle-theme":
      state.theme = state.theme === "dark" ? "light" : "dark";
      saveTheme(state.theme);
      render();
      break;
  }
}

function initialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "dark" || stored === "light") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function saveTheme(theme: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function initialConsoleExpanded(): boolean {
  const stored = window.localStorage.getItem(CONSOLE_STORAGE_KEY);
  if (stored === "expanded") {
    return true;
  }
  if (stored === "collapsed") {
    return false;
  }
  return false;
}

function saveConsoleExpanded(expanded: boolean): void {
  window.localStorage.setItem(CONSOLE_STORAGE_KEY, expanded ? "expanded" : "collapsed");
}

function initialLocalPath(): string | null {
  const stored = window.localStorage.getItem(LOCAL_PATH_STORAGE_KEY)?.trim();
  return stored ? stored : null;
}

function saveLocalPath(path: string): void {
  window.localStorage.setItem(LOCAL_PATH_STORAGE_KEY, path);
}

async function restoreWindowPlacement(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  const shouldMaximize = storedWindowMaximized();
  await restoreWindowSize();
  await restoreWindowPosition();
  if (shouldMaximize) {
    await restoreWindowMaximized();
  }
}

async function restoreWindowSize(): Promise<void> {
  const size = storedWindowSize();
  if (!size) {
    return;
  }

  try {
    await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
  } catch {
    // Window size persistence is a convenience feature; startup should continue if it fails.
  }
}

async function restoreWindowPosition(): Promise<void> {
  const position = storedWindowPosition();
  if (!position) {
    return;
  }

  try {
    const appWindow = getCurrentWindow();
    const [outerSize, monitors] = await Promise.all([appWindow.outerSize(), availableMonitors()]);
    if (windowFitsInAnyWorkArea(position, outerSize, monitors)) {
      await appWindow.setPosition(new PhysicalPosition(position.x, position.y));
    } else if (windowAlmostFillsAnyWorkArea(outerSize, monitors)) {
      await appWindow.maximize();
    }
  } catch {
    // If monitor data or positioning is unavailable, keep the platform default position.
  }
}

async function restoreWindowMaximized(): Promise<void> {
  try {
    await getCurrentWindow().maximize();
  } catch {
    // Maximized state persistence is a convenience feature; startup should continue if it fails.
  }
}

function registerWindowPlacementPersistence(): void {
  if (!isTauriRuntime()) {
    return;
  }

  const appWindow = getCurrentWindow();
  appWindow
    .onResized(() => {
      scheduleWindowPlacementSave();
    })
    .catch(() => undefined);
  appWindow
    .onMoved(({ payload: position }) => {
      void saveMovedWindowPosition(position);
      scheduleWindowPlacementSave();
    })
    .catch(() => undefined);
  window.addEventListener("resize", scheduleWindowPlacementSave);
  window.addEventListener("beforeunload", saveCurrentWindowPlacement);
}

function scheduleWindowPlacementSave(): void {
  if (windowPlacementSaveTimer !== null) {
    window.clearTimeout(windowPlacementSaveTimer);
  }
  windowPlacementSaveTimer = window.setTimeout(() => {
    windowPlacementSaveTimer = null;
    saveCurrentWindowPlacement();
  }, 250);
}

function saveWindowSize(width: number, height: number): void {
  const size = normalizedWindowSize(width, height);
  window.localStorage.setItem(WINDOW_SIZE_STORAGE_KEY, JSON.stringify(size));
}

function saveCurrentWindowPlacement(): void {
  void saveCurrentTauriWindowPlacement();
}

async function saveCurrentTauriWindowPlacement(): Promise<void> {
  if (!isTauriRuntime()) {
    saveWindowSize(window.innerWidth, window.innerHeight);
    return;
  }

  try {
    const appWindow = getCurrentWindow();
    const maximized = await appWindow.isMaximized();
    saveWindowMaximized(maximized);
    if (maximized) {
      return;
    }

    saveWindowSize(window.innerWidth, window.innerHeight);
    const position = await appWindow.outerPosition();
    saveWindowPosition(position.x, position.y);
  } catch {
    saveWindowSize(window.innerWidth, window.innerHeight);
  }
}

async function saveMovedWindowPosition(position: StoredWindowPosition): Promise<void> {
  try {
    const maximized = await getCurrentWindow().isMaximized();
    saveWindowMaximized(maximized);
    if (maximized) {
      return;
    }
    saveWindowPosition(position.x, position.y);
  } catch {
    saveWindowPosition(position.x, position.y);
  }
}

function saveWindowPosition(x: number, y: number): void {
  const position = normalizedWindowPosition(x, y);
  window.localStorage.setItem(WINDOW_POSITION_STORAGE_KEY, JSON.stringify(position));
}

function saveWindowMaximized(maximized: boolean): void {
  window.localStorage.setItem(WINDOW_MAXIMIZED_STORAGE_KEY, maximized ? "true" : "false");
}

function storedWindowSize(): StoredWindowSize | null {
  const stored = window.localStorage.getItem(WINDOW_SIZE_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<StoredWindowSize>;
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) {
      return null;
    }
    return normalizedWindowSize(Number(parsed.width), Number(parsed.height));
  } catch {
    return null;
  }
}

function storedWindowPosition(): StoredWindowPosition | null {
  const stored = window.localStorage.getItem(WINDOW_POSITION_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<StoredWindowPosition>;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) {
      return null;
    }
    return normalizedWindowPosition(Number(parsed.x), Number(parsed.y));
  } catch {
    return null;
  }
}

function storedWindowMaximized(): boolean {
  return window.localStorage.getItem(WINDOW_MAXIMIZED_STORAGE_KEY) === "true";
}

function normalizedWindowSize(width: number, height: number): StoredWindowSize {
  return {
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(height)),
  };
}

function normalizedWindowPosition(x: number, y: number): StoredWindowPosition {
  return {
    x: Math.round(x),
    y: Math.round(y),
  };
}

function windowFitsInAnyWorkArea(
  position: StoredWindowPosition,
  size: StoredWindowSize,
  monitors: Monitor[],
): boolean {
  const windowRight = position.x + size.width;
  const windowBottom = position.y + size.height;

  return monitors.some((monitor) => {
    const areaLeft = monitor.workArea.position.x;
    const areaTop = monitor.workArea.position.y;
    const areaRight = areaLeft + monitor.workArea.size.width;
    const areaBottom = areaTop + monitor.workArea.size.height;

    return (
      position.x >= areaLeft &&
      position.y >= areaTop &&
      windowRight <= areaRight &&
      windowBottom <= areaBottom
    );
  });
}

function windowAlmostFillsAnyWorkArea(size: StoredWindowSize, monitors: Monitor[]): boolean {
  const tolerance = 32;
  return monitors.some((monitor) => {
    const area = monitor.workArea.size;
    return size.width >= area.width - tolerance && size.height >= area.height - tolerance;
  });
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function loadKubeconfigs(showLoading: boolean): Promise<void> {
  if (showLoading) {
    state.remote.loading = true;
    state.remote.error = null;
    render();
  }

  try {
    state.remote.kubeconfigs = await invoke<KubeconfigEntry[]>("scan_kubeconfigs");
    if (state.remote.level === "kubeconfigs") {
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
    }
  } catch (error) {
    state.remote.error = formatError(error);
  } finally {
    state.remote.loading = false;
    if (showLoading) {
      render();
    }
  }
}

async function openRemoteIndex(index: number): Promise<void> {
  if (state.remote.loading || state.activeKubectlActions > 0) {
    return;
  }

  switch (state.remote.level) {
    case "kubeconfigs":
      await openKubeconfig(index);
      break;
    case "namespaces":
      await openNamespace(index);
      break;
    case "pods":
      await openPod(index);
      break;
    case "containers":
      await openContainer(index);
      break;
    case "remote":
      await openRemoteEntry(index);
      break;
  }
}

async function openSelectedRemote(): Promise<void> {
  const index = selectedRemoteOpenIndex();
  if (index === null) {
    return;
  }
  await openRemoteIndex(index);
}

async function openKubeconfig(index: number): Promise<void> {
  const kubeconfig = state.remote.kubeconfigs[index];
  if (!kubeconfig) {
    return;
  }
  if (
    !kubeconfig.isValid &&
    !(await nativeConfirm(
      t("confirm.openKubeconfig.title"),
      t("confirm.openKubeconfig.message", { name: kubeconfig.name }),
    ))
  ) {
    return;
  }
  const cacheKey = prefetchKey({ kind: "namespaces", kubeconfig });
  const cachedNamespaces = namespaceCache.get(cacheKey);

  state.remote = {
    ...state.remote,
    level: "namespaces",
    kubeconfig,
    namespace: null,
    pod: null,
    container: null,
    tarAvailable: null,
    namespaces: cachedNamespaces ?? [],
    pods: [],
    containers: [],
    entries: [],
    path: "/",
    selectedIndex: null,
    selectedIndices: [],
    loading: !cachedNamespaces,
    error: null,
  };
  render();
  if (cachedNamespaces) {
    return;
  }

  try {
    await waitForPrefetch(cacheKey);
    state.remote.namespaces =
      namespaceCache.get(cacheKey) ??
      (await invokeKubectl<NamespaceEntry[]>("list_namespaces", {
        kubeconfig: kubeconfig.path,
      }));
    namespaceCache.set(cacheKey, state.remote.namespaces);
  } catch (error) {
    state.remote.error = formatError(error);
  } finally {
    state.remote.loading = false;
    render();
  }
}

async function openNamespace(index: number): Promise<void> {
  const namespace = state.remote.namespaces[index];
  const kubeconfig = state.remote.kubeconfig;
  if (!namespace || !kubeconfig) {
    return;
  }
  const cacheKey = prefetchKey({ kind: "pods", kubeconfig, namespace });
  const cachedPods = podCache.get(cacheKey);

  state.remote = {
    ...state.remote,
    level: "pods",
    namespace,
    pod: null,
    container: null,
    tarAvailable: null,
    pods: cachedPods ?? [],
    containers: [],
    entries: [],
    selectedIndex: null,
    selectedIndices: [],
    loading: !cachedPods,
    error: null,
  };
  render();
  if (cachedPods) {
    return;
  }

  try {
    await waitForPrefetch(cacheKey);
    state.remote.pods =
      podCache.get(cacheKey) ??
      (await invokeKubectl<PodEntry[]>("list_pods", {
        kubeconfig: kubeconfig.path,
        namespace: namespace.name,
      }));
    podCache.set(cacheKey, state.remote.pods);
  } catch (error) {
    state.remote.error = formatError(error);
  } finally {
    state.remote.loading = false;
    render();
  }
}

async function openPod(index: number): Promise<void> {
  const pod = state.remote.pods[index];
  const kubeconfig = state.remote.kubeconfig;
  const namespace = state.remote.namespace;
  if (!pod || !kubeconfig || !namespace) {
    return;
  }
  const cacheKey = prefetchKey({ kind: "containers", kubeconfig, namespace, pod });
  const cachedContainers = containerCache.get(cacheKey);

  state.remote = {
    ...state.remote,
    pod,
    container: null,
    containers: cachedContainers ?? [],
    entries: [],
    selectedIndex: null,
    selectedIndices: [],
    loading: !cachedContainers,
    error: null,
  };
  render();

  try {
    await waitForPrefetch(cacheKey);
    const containers =
      containerCache.get(cacheKey) ??
      (await invokeKubectl<ContainerEntry[]>("list_containers", {
        kubeconfig: kubeconfig.path,
        namespace: namespace.name,
        pod: pod.name,
      }));
    containerCache.set(cacheKey, containers);

    state.remote.containers = containers;
    if (containers.length > 1) {
      state.remote.level = "containers";
      state.remote.loading = false;
      render();
      return;
    }

    state.remote.container = containers[0] ?? null;
    state.remote.tarAvailable = null;
    state.remote.level = "remote";
    await enterRemoteContainerRoot();
  } catch (error) {
    state.remote.level = "pods";
    state.remote.error = formatError(error);
    state.remote.loading = false;
    render();
  }
}

async function openContainer(index: number): Promise<void> {
  const container = state.remote.containers[index];
  if (!container) {
    return;
  }
  state.remote.container = container;
  state.remote.tarAvailable = null;
  state.remote.level = "remote";
  await enterRemoteContainerRoot();
}

async function enterRemoteContainerRoot(): Promise<void> {
  const target = remoteTarget();
  if (!target) {
    await loadRemotePath("/");
    return;
  }
  state.remote = {
    ...state.remote,
    level: "remote",
    path: "/",
    entries: [],
    selectedIndex: null,
    selectedIndices: [],
    loading: true,
    error: null,
  };
  render();
  await loadRemotePath("/");

  try {
    state.remote.tarAvailable = await invokeKubectl<boolean>("check_container_tar", { target });
  } catch {
    state.remote.tarAvailable = false;
  }
  render();
}

async function openRemoteEntry(index: number): Promise<void> {
  const entry = state.remote.entries[index];
  if (!entry) {
    return;
  }

  if (entry.kind === "directory") {
    await loadRemotePath(entry.path);
    return;
  }

  if (
    !(await nativeConfirm(
      t("confirm.openRemoteFile.title"),
      t("confirm.openRemoteFile.message", { name: entry.name }),
    ))
  ) {
    return;
  }

  const target = remoteTarget();
  if (!target) {
    return;
  }

  const transferId = addTransfer("temp", entry.path, "temp", entry.size, entry.size === null ? "unknown" : "estimated");
  try {
    const result = await invoke<TempDownloadResult>("download_remote_to_temp", {
      target,
      remotePath: entry.path,
      operationId: transferId,
    });
    updateTransfer(transferId, "success", result.localPath, null);
    await invoke("open_local_file", { path: result.localPath });
  } catch (error) {
    updateTransfer(transferId, "failed", "temp", formatError(error));
  }
}

async function loadRemotePath(path: string, useCache = true): Promise<void> {
  const target = remoteTarget();
  if (!target) {
    return;
  }
  const cacheKey = prefetchKey({ kind: "remote-dir", target, path });
  const cachedEntries = useCache ? remoteDirCache.get(cacheKey) : undefined;
  if (cachedEntries) {
    state.remote = {
      ...state.remote,
      level: "remote",
      path,
      entries: cachedEntries,
      selectedIndex: null,
      selectedIndices: [],
      loading: false,
      error: null,
    };
    render();
    return;
  }

  state.remote = {
    ...state.remote,
    level: "remote",
    path,
    entries: [],
    selectedIndex: null,
    selectedIndices: [],
    loading: true,
    error: null,
  };
  render();

  try {
    if (useCache) {
      await waitForPrefetch(cacheKey);
    }
    state.remote.entries =
      (useCache ? remoteDirCache.get(cacheKey) : undefined) ??
      (await invokeKubectl<RemoteFileEntry[]>("list_remote_dir", {
        target,
        path,
      }));
    remoteDirCache.set(cacheKey, state.remote.entries);
  } catch (error) {
    state.remote.error = formatError(error);
  } finally {
    state.remote.loading = false;
    render();
  }
}

async function loadInitialLocalDir(): Promise<void> {
  const path = initialLocalPath();
  if (path && (await loadLocalDir(path, false))) {
    return;
  }
  await loadLocalDir(null, false, false);
}

async function loadLocalDir(path: string | null, showLoading: boolean, useCache = true): Promise<boolean> {
  const cacheKey = path ? prefetchKey({ kind: "local-dir", path }) : null;
  const cachedDirectory = cacheKey && useCache ? localDirCache.get(cacheKey) : undefined;
  if (cachedDirectory) {
    state.local.path = cachedDirectory.path;
    state.local.parent = cachedDirectory.parent;
    state.local.entries = cachedDirectory.entries;
    state.local.selectedIndex = null;
    state.local.selectedIndices = [];
    state.local.error = null;
    state.local.loading = false;
    saveLocalPath(cachedDirectory.path);
    render();
    return true;
  }

  if (showLoading) {
    state.local.loading = true;
    state.local.error = null;
    render();
  }

  let success = false;
  try {
    if (cacheKey && useCache) {
      await waitForPrefetch(cacheKey);
    }
    const directory =
      (cacheKey && useCache ? localDirCache.get(cacheKey) : undefined) ??
      (await invoke<LocalDirectory>("list_local_dir", { path }));
    if (cacheKey) {
      localDirCache.set(cacheKey, directory);
    }
    state.local.path = directory.path;
    state.local.parent = directory.parent;
    state.local.entries = directory.entries;
    state.local.selectedIndex = null;
    state.local.selectedIndices = [];
    state.local.error = null;
    saveLocalPath(directory.path);
    success = true;
  } catch (error) {
    state.local.error = formatError(error);
  } finally {
    state.local.loading = false;
    if (showLoading) {
      render();
    }
  }
  return success;
}

async function openLocalIndex(index: number): Promise<void> {
  const entry = state.local.entries[index];
  if (!entry) {
    return;
  }

  if (entry.kind === "directory") {
    await loadLocalDir(entry.path, true);
    return;
  }

  try {
    await invoke("open_local_file", { path: entry.path });
  } catch (error) {
    state.local.error = formatError(error);
    render();
  }
}

async function openSelectedLocal(): Promise<void> {
  const index = selectedLocalOpenIndex();
  if (index === null) {
    return;
  }
  await openLocalIndex(index);
}

async function openLocalHome(): Promise<void> {
  try {
    const home = await invoke<string>("get_home_dir");
    await loadLocalDir(home, true);
  } catch (error) {
    state.local.error = formatError(error);
    render();
  }
}

async function refreshRemote(): Promise<void> {
  switch (state.remote.level) {
    case "kubeconfigs":
      await loadKubeconfigs(true);
      break;
    case "namespaces":
      if (state.remote.kubeconfig) {
        namespaceCache.delete(prefetchKey({ kind: "namespaces", kubeconfig: state.remote.kubeconfig }));
        await openKubeconfig(state.remote.kubeconfigs.indexOf(state.remote.kubeconfig));
      }
      break;
    case "pods":
      if (state.remote.kubeconfig && state.remote.namespace) {
        podCache.delete(prefetchKey({
          kind: "pods",
          kubeconfig: state.remote.kubeconfig,
          namespace: state.remote.namespace,
        }));
        await openNamespace(state.remote.namespaces.indexOf(state.remote.namespace));
      }
      break;
    case "containers":
      if (state.remote.kubeconfig && state.remote.namespace && state.remote.pod) {
        containerCache.delete(prefetchKey({
          kind: "containers",
          kubeconfig: state.remote.kubeconfig,
          namespace: state.remote.namespace,
          pod: state.remote.pod,
        }));
        await openPod(state.remote.pods.indexOf(state.remote.pod));
      }
      break;
    case "remote":
      await loadRemotePath(state.remote.path, false);
      break;
  }
}

async function remoteUp(): Promise<void> {
  state.remote.error = null;

  switch (state.remote.level) {
    case "kubeconfigs":
      return;
    case "namespaces":
      resetRemoteToRoot();
      render();
      return;
    case "pods":
      state.remote.level = "namespaces";
      state.remote.namespace = null;
      state.remote.pod = null;
      state.remote.container = null;
      state.remote.tarAvailable = null;
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
      render();
      return;
    case "containers":
      state.remote.level = "pods";
      state.remote.pod = null;
      state.remote.container = null;
      state.remote.tarAvailable = null;
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
      render();
      return;
    case "remote":
      if (state.remote.path !== "/") {
        await loadRemotePath(parentRemotePath(state.remote.path));
        return;
      }
      if (state.remote.containers.length > 1) {
        state.remote.level = "containers";
        state.remote.container = null;
        state.remote.tarAvailable = null;
      } else {
        state.remote.level = "pods";
        state.remote.pod = null;
        state.remote.container = null;
        state.remote.tarAvailable = null;
      }
      state.remote.entries = [];
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
      render();
      return;
  }
}

async function openRemoteBreadcrumb(level: string, path: string): Promise<void> {
  state.remote.error = null;

  switch (level) {
    case "root":
      resetRemoteToRoot();
      render();
      return;
    case "kubeconfig":
      state.remote.level = "namespaces";
      state.remote.namespace = null;
      state.remote.pod = null;
      state.remote.container = null;
      state.remote.tarAvailable = null;
      state.remote.pods = [];
      state.remote.containers = [];
      state.remote.entries = [];
      state.remote.path = "/";
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
      render();
      return;
    case "namespace":
      state.remote.level = "pods";
      state.remote.pod = null;
      state.remote.container = null;
      state.remote.tarAvailable = null;
      state.remote.containers = [];
      state.remote.entries = [];
      state.remote.path = "/";
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
      render();
      return;
    case "pod":
      if (state.remote.containers.length > 1) {
        state.remote.level = "containers";
        state.remote.container = null;
        state.remote.tarAvailable = null;
      } else {
        state.remote.level = "remote";
      }
      state.remote.entries = [];
      state.remote.path = "/";
      state.remote.selectedIndex = null;
      state.remote.selectedIndices = [];
      render();
      if (state.remote.level === "remote") {
        await loadRemotePath("/");
      }
      return;
    case "container":
      await enterRemoteContainerRoot();
      return;
    case "remote-path":
      await loadRemotePath(path || "/");
      return;
  }
}

async function downloadSelectedRemote(): Promise<void> {
  const entries = selectedRemoteEntries();
  const target = remoteTarget();
  if (entries.length === 0 || !target || !state.local.path) {
    return;
  }

  for (const entry of entries) {
    const destination = await invoke<string>("join_local_path", {
      base: state.local.path,
      child: entry.name,
    });

    if (
      localNameExists(entry.name) &&
      !(await nativeConfirm(
        t("confirm.overwriteLocal.title"),
        t("confirm.overwriteLocal.message", { name: entry.name }),
      ))
    ) {
      continue;
    }

    const transferId = addTransfer("download", entry.path, destination, entry.size, entry.size === null ? "unknown" : "measured");
    void monitorLocalTransferProgress(transferId, destination);
    void runDownloadTransfer(transferId, target, entry, destination);
  }
}

async function runDownloadTransfer(
  transferId: number,
  target: RemoteTarget,
  entry: RemoteFileEntry,
  destination: string,
): Promise<void> {
  try {
    await invoke("copy_remote_to_local", {
      target,
      remotePath: entry.path,
      localPath: destination,
      operationId: transferId,
    });
    updateTransfer(transferId, "success", destination, null);
    localDirCache.delete(prefetchKey({ kind: "local-dir", path: state.local.path }));
    await loadLocalDir(state.local.path, true, false);
  } catch (error) {
    updateTransfer(transferId, "failed", destination, formatError(error));
  }
}

async function uploadSelectedLocal(): Promise<void> {
  const entries = selectedLocalEntries();
  const target = remoteTarget();
  if (entries.length === 0 || !target || state.remote.level !== "remote") {
    return;
  }

  for (const entry of entries) {
    const destination = joinRemotePath(state.remote.path, entry.name);
    if (
      remoteNameExists(entry.name) &&
      !(await nativeConfirm(
        t("confirm.overwriteRemote.title"),
        t("confirm.overwriteRemote.message", { name: entry.name }),
      ))
    ) {
      continue;
    }

    const isFileUpload = entry.kind === "file";
    const transferId = addTransfer(
      "upload",
      entry.path,
      destination,
      entry.size,
      isFileUpload ? "measured" : entry.size === null ? "unknown" : "estimated",
    );
    if (entry.size === null) {
      void loadTransferTotalBytes(transferId, entry.path, isFileUpload ? "measured" : "estimated");
    }
    void monitorRemoteTransferProgress(transferId, target, destination);
    void runUploadTransfer(transferId, target, entry, destination);
  }
}

async function deleteSelectedRemote(): Promise<void> {
  const entries = selectedRemoteEntries();
  const target = remoteTarget();
  if (entries.length === 0 || !target) {
    return;
  }

  const confirmed = await nativeConfirm(
    t("confirm.deleteRemote.title"),
    t("confirm.deleteRemote.message", { selection: describeSelection(entries) }),
  );
  if (!confirmed) {
    return;
  }

  const currentPath = state.remote.path;
  try {
    await invokeKubectl("delete_remote_entries", {
      target,
      paths: entries.map((entry) => entry.path),
    });
    remoteDirCache.delete(prefetchKey({ kind: "remote-dir", target, path: currentPath }));
    await loadRemotePath(currentPath, false);
  } catch (error) {
    state.remote.error = formatError(error);
    render();
  }
}

async function deleteSelectedLocal(): Promise<void> {
  const entries = selectedLocalEntries();
  if (entries.length === 0) {
    return;
  }

  const confirmed = await nativeConfirm(
    t("confirm.deleteLocal.title"),
    t("confirm.deleteLocal.message", { selection: describeSelection(entries) }),
  );
  if (!confirmed) {
    return;
  }

  const currentPath = state.local.path || null;
  state.local.loading = true;
  state.local.error = null;
  render();

  try {
    await invoke("delete_local_entries", {
      paths: entries.map((entry) => entry.path),
    });
    if (currentPath) {
      localDirCache.delete(prefetchKey({ kind: "local-dir", path: currentPath }));
    }
    await loadLocalDir(currentPath, false, false);
  } catch (error) {
    state.local.error = formatError(error);
  } finally {
    state.local.loading = false;
    render();
  }
}

async function runUploadTransfer(
  transferId: number,
  target: RemoteTarget,
  entry: LocalFileEntry,
  destination: string,
): Promise<void> {
  try {
    await invoke("copy_local_to_remote", {
      target,
      localPath: entry.path,
      remotePath: destination,
      operationId: transferId,
    });
    updateTransfer(transferId, "success", destination, null);
    remoteDirCache.delete(prefetchKey({ kind: "remote-dir", target, path: state.remote.path }));
    await loadRemotePath(state.remote.path, false);
  } catch (error) {
    updateTransfer(transferId, "failed", destination, formatError(error));
  }
}

async function cancelTransfer(id: number): Promise<void> {
  if (!Number.isFinite(id)) {
    return;
  }
  const transfer = state.transfers.find((item) => item.id === id);
  if (!transfer || transfer.status !== "running") {
    return;
  }

  try {
    await invoke("cancel_kubectl_operation", { operationId: id });
    updateTransfer(id, "failed", transfer.destination, t("transfer.cancelled"));
  } catch (error) {
    transfer.error = formatError(error);
    render();
  }
}

function clearFinishedTransfers(): void {
  const nextTransfers = state.transfers.filter((entry) => entry.status === "running");
  if (nextTransfers.length === state.transfers.length) {
    return;
  }
  state.transfers = nextTransfers;
  render();
}

async function copyTransferField(id: number, field: string | undefined): Promise<void> {
  if (!Number.isFinite(id) || !isTransferCopyField(field)) {
    return;
  }

  const transfer = state.transfers.find((item) => item.id === id);
  if (!transfer) {
    return;
  }

  try {
    await writeClipboardText(transferCopyValue(transfer, field));
    copiedTransferCell = { id, field };
    render();
    if (copiedTransferTimer !== null) {
      window.clearTimeout(copiedTransferTimer);
    }
    copiedTransferTimer = window.setTimeout(() => {
      copiedTransferCell = null;
      copiedTransferTimer = null;
      render();
    }, 1500);
  } catch (error) {
    state.bootError = formatError(error);
    render();
  }
}

async function copyKubectlMessage(id: number): Promise<void> {
  if (!Number.isFinite(id)) {
    return;
  }

  const entry = state.kubectlLogs.find((item) => item.id === id);
  if (!entry) {
    return;
  }

  try {
    await writeClipboardText(kubectlLogClipboardText(entry));
    copiedKubectlLogId = id;
    updateKubectlRuntimeViews();
    if (copiedKubectlLogTimer !== null) {
      window.clearTimeout(copiedKubectlLogTimer);
    }
    copiedKubectlLogTimer = window.setTimeout(() => {
      copiedKubectlLogId = null;
      copiedKubectlLogTimer = null;
      updateKubectlRuntimeViews();
    }, 1500);
  } catch (error) {
    state.bootError = formatError(error);
    render();
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy selection path below.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error(t("error.copyClipboard"));
    }
  } finally {
    textarea.remove();
  }
}

function resetRemoteToRoot(): void {
  state.remote.level = "kubeconfigs";
  state.remote.namespace = null;
  state.remote.pod = null;
  state.remote.container = null;
  state.remote.tarAvailable = null;
  state.remote.namespaces = [];
  state.remote.pods = [];
  state.remote.containers = [];
  state.remote.entries = [];
  state.remote.path = "/";
  state.remote.selectedIndex = null;
  state.remote.selectedIndices = [];
  state.remote.error = null;
}

function remoteTarget(): RemoteTarget | null {
  const kubeconfig = state.remote.kubeconfig;
  const namespace = state.remote.namespace;
  const pod = state.remote.pod;
  if (!kubeconfig || !namespace || !pod) {
    return null;
  }

  return {
    kubeconfig: kubeconfig.path,
    namespace: namespace.name,
    pod: pod.name,
    container: state.remote.container?.name ?? null,
  };
}

function selectedRemoteEntry(): RemoteFileEntry | null {
  return selectedRemoteEntries()[0] ?? null;
}

function selectedLocalEntry(): LocalFileEntry | null {
  return selectedLocalEntries()[0] ?? null;
}

function selectedRemoteEntries(): RemoteFileEntry[] {
  if (state.remote.level !== "remote") {
    return [];
  }
  return selectedRemoteIndices().map((index) => state.remote.entries[index]).filter(Boolean);
}

function selectedLocalEntries(): LocalFileEntry[] {
  return selectedLocalIndices().map((index) => state.local.entries[index]).filter(Boolean);
}

function selectedRemoteIndices(): number[] {
  return state.remote.selectedIndices.length > 0
    ? state.remote.selectedIndices
    : state.remote.selectedIndex === null
      ? []
      : [state.remote.selectedIndex];
}

function selectedLocalIndices(): number[] {
  return state.local.selectedIndices.length > 0
    ? state.local.selectedIndices
    : state.local.selectedIndex === null
      ? []
      : [state.local.selectedIndex];
}

function selectedRemoteOpenIndex(): number | null {
  const indices = selectedRemoteIndices();
  if (indices.length !== 1) {
    return null;
  }

  const index = indices[0];
  return index >= 0 && index < remoteLevelEntryCount() ? index : null;
}

function selectedLocalOpenIndex(): number | null {
  const indices = selectedLocalIndices();
  if (indices.length !== 1) {
    return null;
  }

  const index = indices[0];
  return state.local.entries[index] ? index : null;
}

function remoteLevelEntryCount(): number {
  switch (state.remote.level) {
    case "kubeconfigs":
      return state.remote.kubeconfigs.length;
    case "namespaces":
      return state.remote.namespaces.length;
    case "pods":
      return state.remote.pods.length;
    case "containers":
      return state.remote.containers.length;
    case "remote":
      return state.remote.entries.length;
  }
}

function localNameExists(name: string): boolean {
  return state.local.entries.some((entry) => entry.name === name);
}

function remoteNameExists(name: string): boolean {
  return state.remote.entries.some((entry) => entry.name === name);
}

function describeSelection(entries: Array<{ name: string }>): string {
  if (entries.length === 1) {
    return t("selection.single", { name: entries[0].name });
  }

  const preview = entries
    .slice(0, 3)
    .map((entry) => `"${entry.name}"`)
    .join(", ");
  const suffix = entries.length > 3 ? t("selection.moreSuffix", { count: entries.length - 3 }) : "";
  return t("selection.multiple", { count: entries.length, preview, suffix });
}

function addTransfer(
  direction: TransferDirection,
  source: string,
  destination: string,
  totalBytes: number | null = null,
  progressMode: TransferProgressMode = "unknown",
): number {
  const id = state.nextTransferId++;
  state.transfers.unshift({
    id,
    direction,
    source,
    destination,
    status: "running",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    totalBytes,
    transferredBytes: totalBytes === null ? null : 0,
    progressMode,
    progressUpdatedAt: null,
  });
  state.transfers = state.transfers.slice(0, 50);
  render();
  return id;
}

function updateTransfer(
  id: number,
  status: TransferStatus,
  destination: string,
  error: string | null,
): void {
  const transfer = state.transfers.find((item) => item.id === id);
  if (!transfer) {
    return;
  }
  transfer.status = status;
  transfer.destination = destination;
  transfer.error = error;
  transfer.finishedAt = Date.now();
  if (status === "success" && transfer.totalBytes !== null) {
    transfer.transferredBytes = transfer.totalBytes;
    transfer.progressMode = "measured";
    transfer.progressUpdatedAt = Date.now();
  }
  if (status === "success") {
    recordCompletedTransferSpeed(transfer);
  }
  render();
}

async function monitorLocalTransferProgress(id: number, path: string): Promise<void> {
  while (isTransferRunning(id)) {
    await delay(TRANSFER_PROGRESS_POLL_MS);
    if (!isTransferRunning(id)) {
      return;
    }

    try {
      const bytes = await invoke<number | null>("local_path_size", { path });
      if (bytes !== null) {
        updateTransferProgress(id, bytes, null, "measured");
      }
    } catch {
      return;
    }
  }
}

async function monitorRemoteTransferProgress(id: number, target: RemoteTarget, path: string): Promise<void> {
  while (isTransferRunning(id)) {
    await delay(TRANSFER_PROGRESS_POLL_MS);
    if (!isTransferRunning(id)) {
      return;
    }

    try {
      const bytes = await invoke<number | null>("remote_path_size", { target, path });
      if (bytes !== null) {
        updateTransferProgress(id, bytes, null, "measured");
      }
    } catch {
      return;
    }
  }
}

async function loadTransferTotalBytes(id: number, path: string, mode: TransferProgressMode): Promise<void> {
  try {
    const totalBytes = await invoke<number | null>("local_path_size", { path });
    if (totalBytes !== null) {
      updateTransferProgress(id, null, totalBytes, mode);
    }
  } catch {
    return;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isTransferRunning(id: number): boolean {
  return state.transfers.some((entry) => entry.id === id && entry.status === "running");
}

function updateTransferProgress(
  id: number,
  transferredBytes: number | null,
  totalBytes: number | null,
  mode: TransferProgressMode,
): void {
  const transfer = state.transfers.find((item) => item.id === id);
  if (!transfer || transfer.status !== "running") {
    return;
  }
  if (totalBytes !== null) {
    transfer.totalBytes = totalBytes;
  }
  if (transferredBytes !== null) {
    const current = transfer.transferredBytes ?? 0;
    transfer.transferredBytes = Math.max(current, transferredBytes);
  }
  transfer.progressMode = mode;
  transfer.progressUpdatedAt = Date.now();
  updateTransferRuntimeViews();
}

function refreshRunningTransferEstimates(): void {
  let hasRunningTransfers = false;
  for (const transfer of state.transfers) {
    if (transfer.status !== "running") {
      continue;
    }

    hasRunningTransfers = true;
    if (transfer.progressMode !== "estimated" || transfer.totalBytes === null) {
      continue;
    }

    const estimatedBytes = estimatedTransferredBytes(transfer);
    if (estimatedBytes !== null) {
      transfer.transferredBytes = Math.max(transfer.transferredBytes ?? 0, estimatedBytes);
      transfer.progressUpdatedAt = Date.now();
    }
  }

  if (hasRunningTransfers) {
    updateTransferRuntimeViews();
  }
}

function estimatedTransferredBytes(transfer: TransferEntry): number | null {
  if (transfer.totalBytes === null) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - transfer.startedAt);
  const bytesPerMs = estimatedTransferBytesPerMs ?? DEFAULT_ESTIMATED_TRANSFER_BYTES_PER_MS;
  return Math.min(transfer.totalBytes * 0.95, elapsedMs * bytesPerMs);
}

function recordCompletedTransferSpeed(transfer: TransferEntry): void {
  const elapsedMs = Math.max(1, (transfer.finishedAt ?? Date.now()) - transfer.startedAt);
  const bytes = transfer.totalBytes ?? transfer.transferredBytes;
  if (!bytes || elapsedMs < 500) {
    return;
  }

  const bytesPerMs = bytes / elapsedMs;
  estimatedTransferBytesPerMs =
    estimatedTransferBytesPerMs === null ? bytesPerMs : estimatedTransferBytesPerMs * 0.7 + bytesPerMs * 0.3;
}

function updateTransferRuntimeViews(): void {
  const transferPanel = app.querySelector<HTMLElement>(".transfer-panel");
  if (!transferPanel) {
    render();
    return;
  }

  const transferList = transferPanel.querySelector<HTMLElement>("[data-scroll-key='transfers']");
  const scrollTop = transferList?.scrollTop ?? 0;
  transferPanel.outerHTML = renderTransfers();
  const nextTransferList = app.querySelector<HTMLElement>("[data-scroll-key='transfers']");
  if (nextTransferList) {
    nextTransferList.scrollTop = scrollTop;
  }
  createIcons({ icons });
  updateTransferColumnStyles();
}

function render(): void {
  const scrollPositions = captureScrollPositions();
  const themeIcon = state.theme === "dark" ? "sun" : "moon";
  const themeTitle = state.theme === "dark" ? t("theme.toLight") : t("theme.toDark");
  app.innerHTML = `
    <div class="app-shell ${state.consoleExpanded ? "console-expanded" : "console-collapsed"}" data-theme="${state.theme}">
      ${state.bootError ? `<div class="banner error">${escapeHtml(state.bootError)}</div>` : `<div class="banner-placeholder" aria-hidden="true"></div>`}
      <main class="workspace">
        ${renderRemotePanel(themeIcon, themeTitle)}
        ${renderLocalPanel()}
      </main>
      ${renderTransfers()}
      ${renderKubectlConsole()}
      ${renderContextMenu()}
    </div>
  `;

  createIcons({ icons });
  updateActionButtons();
  restoreScrollPositions(scrollPositions);
}

function captureScrollPositions(): Record<string, number> {
  const positions: Record<string, number> = {};
  app.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((element) => {
    const key = element.dataset.scrollKey;
    if (key) {
      positions[key] = element.scrollTop;
    }
  });
  return positions;
}

function restoreScrollPositions(positions: Record<string, number>): void {
  app.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((element) => {
    const key = element.dataset.scrollKey;
    if (key && positions[key] !== undefined) {
      element.scrollTop = positions[key];
    }
  });
}

function renderRemotePanel(themeIcon: string, themeTitle: string): string {
  return `
    <section class="panel remote-panel" aria-label="Kubernetes">
      <div class="panel-header">
        <div>
          <h2>Kubernetes</h2>
          <div class="breadcrumbs">${renderRemoteBreadcrumbs()}</div>
        </div>
        <div class="panel-actions">
          <button class="icon-button" type="button" data-action="toggle-theme" title="${escapeAttr(themeTitle)}" aria-label="${escapeAttr(themeTitle)}">
            <i data-lucide="${themeIcon}"></i>
          </button>
          <button class="icon-button" type="button" data-action="remote-root" title="${escapeAttr(t("toolbar.remoteRoot"))}" ${state.remote.loading || state.activeKubectlActions > 0 ? "disabled" : ""}>
            <i data-lucide="network"></i>
          </button>
          <button class="icon-button" type="button" data-action="remote-up" title="${escapeAttr(t("toolbar.remoteUp"))}" ${state.remote.level === "kubeconfigs" || state.remote.loading || state.activeKubectlActions > 0 ? "disabled" : ""}>
            <i data-lucide="arrow-up"></i>
          </button>
          <button class="icon-button" type="button" data-action="refresh-remote" title="${escapeAttr(t("toolbar.refresh"))}" ${state.remote.loading || state.activeKubectlActions > 0 ? "disabled" : ""}>
            <i data-lucide="${state.remote.loading || state.activeKubectlActions > 0 ? "loader" : "refresh-cw"}"></i>
          </button>
        </div>
      </div>
      <div class="table-header remote-grid">
        <span>${escapeHtml(t("table.name"))}</span>
        <span>${escapeHtml(t("table.status"))}</span>
        <span>${escapeHtml(t("table.size"))}</span>
        <span>${escapeHtml(t("table.info"))}</span>
      </div>
      <div class="file-list" role="listbox" aria-busy="${state.remote.loading}" data-scroll-key="remote-files">
        ${renderRemoteRows()}
      </div>
      <div class="panel-footer">
        ${renderTarWarning()}
        <button class="tool-button" type="button" data-action="open-remote" title="${escapeAttr(t("toolbar.openSelected"))}" ${canOpenRemote() ? "" : "disabled"}>
          <i data-lucide="folder-open"></i><span>${escapeHtml(t("action.open"))}</span>
        </button>
        <button class="tool-button" type="button" data-action="download" title="${escapeAttr(t("toolbar.downloadFromPod"))}" ${canDownload() ? "" : "disabled"}>
          <i data-lucide="download"></i><span>${escapeHtml(t("action.download"))}</span>
        </button>
        <button class="tool-button danger-button" type="button" data-action="delete-remote" title="${escapeAttr(t("toolbar.deleteFromPod"))}" ${canDeleteRemote() ? "" : "disabled"}>
          <i data-lucide="trash-2"></i><span>${escapeHtml(t("action.delete"))}</span>
        </button>
      </div>
    </section>
  `;
}

function renderTarWarning(): string {
  if (state.remote.level !== "remote" || state.remote.tarAvailable !== false) {
    return "";
  }
  return `
    <div class="tar-warning" role="alert">
      ${escapeHtml(t("warning.tar"))}
    </div>
  `;
}

function renderLocalPanel(): string {
  return `
    <section class="panel local-panel" aria-label="${escapeAttr(t("local.aria"))}">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(t("local.title"))}</h2>
          <input class="path-input" data-local-path value="${escapeAttr(state.local.path)}" aria-label="${escapeAttr(t("local.path"))}" />
        </div>
        <div class="panel-actions">
          <button class="icon-button" type="button" data-action="local-home" title="${escapeAttr(t("toolbar.home"))}">
            <i data-lucide="home"></i>
          </button>
          <button class="icon-button" type="button" data-action="local-up" title="${escapeAttr(t("toolbar.localUp"))}" ${state.local.parent ? "" : "disabled"}>
            <i data-lucide="arrow-up"></i>
          </button>
          <button class="icon-button" type="button" data-action="refresh-local" title="${escapeAttr(t("toolbar.refresh"))}">
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
      </div>
      <div class="table-header local-grid">
        <span>${escapeHtml(t("table.name"))}</span>
        <span>${escapeHtml(t("table.type"))}</span>
        <span>${escapeHtml(t("table.size"))}</span>
        <span>${escapeHtml(t("table.modified"))}</span>
      </div>
      <div class="file-list" role="listbox" aria-busy="${state.local.loading}" data-scroll-key="local-files">
        ${renderLocalRows()}
      </div>
      <div class="panel-footer">
        <button class="tool-button" type="button" data-action="open-local" title="${escapeAttr(t("toolbar.openSelected"))}" ${canOpenLocal() ? "" : "disabled"}>
          <i data-lucide="folder-open"></i><span>${escapeHtml(t("action.open"))}</span>
        </button>
        <button class="tool-button" type="button" data-action="upload" title="${escapeAttr(t("toolbar.uploadToPod"))}" ${canUpload() ? "" : "disabled"}>
          <i data-lucide="upload"></i><span>${escapeHtml(t("action.upload"))}</span>
        </button>
        <button class="tool-button danger-button" type="button" data-action="delete-local" title="${escapeAttr(t("toolbar.moveToTrash"))}" ${canDeleteLocal() ? "" : "disabled"}>
          <i data-lucide="trash-2"></i><span>${escapeHtml(t("action.delete"))}</span>
        </button>
      </div>
    </section>
  `;
}

function renderRemoteRows(): string {
  if (state.remote.loading) {
    return renderEmptyState("loader", t("empty.loading"));
  }
  if (state.remote.error) {
    return renderEmptyState("triangle-alert", state.remote.error, "error");
  }

  switch (state.remote.level) {
    case "kubeconfigs":
      if (state.remote.kubeconfigs.length === 0) {
        return renderEmptyState("folder-search", t("empty.kubeconfigs"));
      }
      return state.remote.kubeconfigs
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: remoteRowSelected(index),
            icon: entry.isValid ? "server" : "triangle-alert",
            name: entry.name,
            status: entry.isValid ? "kubeconfig" : t("kubectl.invalid"),
            size: "",
            info: entry.path,
            muted: !entry.isValid,
          }),
        )
        .join("");
    case "namespaces":
      if (state.remote.namespaces.length === 0) {
        return renderEmptyState("folder-open", t("empty.namespaces"));
      }
      return state.remote.namespaces
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: remoteRowSelected(index),
            icon: "folder",
            name: entry.name,
            status: entry.status ?? "",
            size: "",
            info: "namespace",
          }),
        )
        .join("");
    case "pods":
      if (state.remote.pods.length === 0) {
        return renderEmptyState("box", t("empty.pods"));
      }
      return state.remote.pods
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: remoteRowSelected(index),
            icon: "box",
            name: entry.name,
            status: entry.phase ?? "",
            size: entry.ready,
            info: podInfoLabel(entry),
            muted: entry.phase !== "Running",
          }),
        )
        .join("");
    case "containers":
      if (state.remote.containers.length === 0) {
        return renderEmptyState("container", t("empty.containers"));
      }
      return state.remote.containers
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: remoteRowSelected(index),
            icon: "container",
            name: entry.name,
            status: entry.ready === null ? "" : entry.ready ? t("ready.yes") : t("ready.no"),
            size: "",
            info: entry.image ?? "",
            muted: entry.ready === false,
          }),
        )
        .join("");
    case "remote":
      if (state.remote.entries.length === 0) {
        return renderEmptyState("folder-open", t("empty.directory"));
      }
      return state.remote.entries
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: remoteRowSelected(index),
            icon: iconForKind(entry.kind),
            name: displayRemoteName(entry),
            status: entry.permissions ?? entryKindLabel(entry.kind),
            size: formatBytes(entry.size),
            info: entry.modifiedAt ?? "",
          }),
        )
        .join("");
  }
}

function renderLocalRows(): string {
  if (state.local.loading) {
    return renderEmptyState("loader", t("empty.loading"));
  }
  if (state.local.error) {
    return renderEmptyState("triangle-alert", state.local.error, "error");
  }
  if (state.local.entries.length === 0) {
    return renderEmptyState("folder-open", t("empty.directory"));
  }

  return state.local.entries
    .map((entry, index) =>
      renderRow({
        panel: "local",
        index,
        grid: "local-grid",
        selected: localRowSelected(index),
        icon: iconForKind(entry.kind),
        name: entry.name,
        status: localKindLabel(entry),
        size: formatBytes(entry.size),
        info: formatLocalDate(entry.modifiedAt),
        muted: entry.readonly,
      }),
    )
    .join("");
}

function remoteRowSelected(index: number): boolean {
  return state.remote.selectedIndices.includes(index) || state.remote.selectedIndex === index;
}

function localRowSelected(index: number): boolean {
  return state.local.selectedIndices.includes(index) || state.local.selectedIndex === index;
}

function renderRow(options: {
  panel: "remote" | "local";
  index: number;
  grid: "remote-grid" | "local-grid";
  selected: boolean;
  icon: string;
  name: string;
  status: string;
  size: string;
  info: string;
  muted?: boolean;
}): string {
  const classes = ["file-row", options.grid, options.selected ? "selected" : "", options.muted ? "muted" : ""]
    .filter(Boolean)
    .join(" ");

  return `
    <button class="${classes}" type="button" data-panel="${options.panel}" data-index="${options.index}" role="option" aria-selected="${options.selected}">
      <span class="name-cell"><i data-lucide="${options.icon}"></i><span>${escapeHtml(options.name)}</span></span>
      <span>${escapeHtml(options.status)}</span>
      <span>${escapeHtml(options.size)}</span>
      <span class="truncate" title="${escapeAttr(options.info)}">${escapeHtml(options.info)}</span>
    </button>
  `;
}

function renderEmptyState(icon: string, message: string, tone = ""): string {
  return `
    <div class="empty-state ${tone}">
      <i data-lucide="${icon}"></i>
      <span class="empty-state-message">${escapeHtml(message)}</span>
    </div>
  `;
}

function renderRemoteBreadcrumbs(): string {
  const crumbs: string[] = [
    renderBreadcrumbButton("~/.kube", "root"),
  ];
  if (state.remote.kubeconfig) {
    crumbs.push(renderBreadcrumbButton(state.remote.kubeconfig.name, "kubeconfig"));
  }
  if (state.remote.namespace) {
    crumbs.push(renderBreadcrumbButton(state.remote.namespace.name, "namespace"));
  }
  if (state.remote.pod) {
    crumbs.push(renderBreadcrumbButton(state.remote.pod.name, "pod"));
  }
  if (state.remote.container) {
    crumbs.push(renderBreadcrumbButton(state.remote.container.name, "container"));
  }
  if (state.remote.level === "remote") {
    crumbs.push(...renderRemotePathBreadcrumbs(state.remote.path));
  }

  return crumbs.join("<i data-lucide=\"chevron-right\"></i>");
}

function renderRemotePathBreadcrumbs(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [renderBreadcrumbButton("/", "remote-path", "/")];
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    crumbs.push(renderBreadcrumbButton(part, "remote-path", current));
  }
  return crumbs;
}

function renderBreadcrumbButton(label: string, level: string, path = ""): string {
  return `
    <button class="breadcrumb-button" type="button" data-breadcrumb="${escapeAttr(level)}" data-path="${escapeAttr(path)}">
      ${escapeHtml(label)}
    </button>
  `;
}

function renderTransfers(): string {
  const gridStyle = `--transfer-columns: ${transferColumnTemplate()};`;
  const canClearTransfers = state.transfers.some((entry) => entry.status !== "running");
  const rows = state.transfers.length
    ? state.transfers
        .map((entry) => {
          const icon = entry.status === "running" ? "loader" : entry.status === "success" ? "check" : "circle-x";
          const direction = entry.direction === "upload" ? "upload" : entry.direction === "download" ? "download" : "file-down";
          const info = transferInfoLabel(entry);
          const status = transferStatusLabel(entry.status);
          return `
            <div class="transfer-row ${entry.status}" style="${gridStyle}">
              <span class="transfer-status">
                <i data-lucide="${icon}"></i>
                <span class="truncate" title="${escapeAttr(status)}">${escapeHtml(status)}</span>
              </span>
              <span><i data-lucide="${direction}"></i></span>
              <span class="transfer-copy-cell">
                <span class="truncate" title="${escapeAttr(entry.source)}">${escapeHtml(entry.source)}</span>
                ${renderTransferCopyButton(entry, "source")}
              </span>
              <span class="transfer-copy-cell">
                <span class="truncate" title="${escapeAttr(entry.destination)}">${escapeHtml(entry.destination)}</span>
                ${renderTransferCopyButton(entry, "destination")}
              </span>
              <span class="transfer-info transfer-copy-cell">
                <span class="truncate" title="${escapeAttr(info)}">${escapeHtml(info)}</span>
                ${renderTransferCopyButton(entry, "info")}
                ${entry.status === "running" ? `<button class="cancel-transfer-button" type="button" data-action="cancel-transfer" data-transfer-id="${entry.id}" title="${escapeAttr(t("transfer.cancelTitle"))}">${escapeHtml(t("transfer.cancel"))}</button>` : ""}
                ${renderTransferProgress(entry)}
              </span>
            </div>
          `;
        })
        .join("")
    : `<div class="transfer-empty">${escapeHtml(t("transfer.empty"))}</div>`;

  return `
    <section class="transfer-panel" aria-label="${escapeAttr(t("transfer.label"))}">
      <div class="transfer-header" style="${gridStyle}">
        ${renderTransferHeaderCell(t("table.status"), 0)}
        ${renderTransferHeaderCell("", 1)}
        ${renderTransferHeaderCell(t("transfer.source"), 2)}
        ${renderTransferHeaderCell(t("transfer.destination"), 3)}
        ${renderTransferHeaderCell(
          t("table.info"),
          4,
          false,
          `<button class="transfer-clear-button" type="button" data-action="clear-transfers" title="${escapeAttr(t("transfer.clearFinished"))}" aria-label="${escapeAttr(t("transfer.clearFinished"))}" ${canClearTransfers ? "" : "disabled"}>
            <i data-lucide="list-x"></i>
          </button>`,
        )}
      </div>
      <div class="transfer-list" data-scroll-key="transfers">${rows}</div>
    </section>
  `;
}

function renderTransferProgress(entry: TransferEntry): string {
  if (entry.status !== "running") {
    return "";
  }

  const percent = transferProgressPercent(entry);
  if (percent === null) {
    return `<span class="transfer-progress indeterminate" aria-hidden="true"></span>`;
  }

  return `
    <span class="transfer-progress" aria-hidden="true">
      <span class="transfer-progress-fill" style="width: ${percent.toFixed(1)}%;"></span>
    </span>
  `;
}

function renderTransferCopyButton(entry: TransferEntry, field: TransferCopyField): string {
  const copied = copiedTransferCell?.id === entry.id && copiedTransferCell.field === field;
  const label = copied ? t("transfer.copied") : t("transfer.copy");
  return `
    <button class="transfer-copy-button ${copied ? "copied" : ""}" type="button" data-action="copy-transfer-field" data-transfer-id="${entry.id}" data-transfer-field="${field}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">
      <i data-lucide="${copied ? "check" : "copy"}"></i>
    </button>
  `;
}

function renderTransferHeaderCell(label: string, index: number, resizable = true, action = ""): string {
  return `
    <span class="transfer-header-cell">
      <span>${escapeHtml(label)}</span>
      ${action}
      ${resizable ? `<button class="transfer-resize-handle" type="button" data-transfer-resize="${index}" title="${escapeAttr(t("transfer.resizeColumn"))}"></button>` : ""}
    </span>
  `;
}

function renderKubectlConsole(): string {
  const rows = state.kubectlLogs.length
    ? state.kubectlLogs
        .slice()
        .reverse()
        .map((entry) => {
          const output = kubectlLogOutput(entry);
          const copied = copiedKubectlLogId === entry.id;
          const copyLabel = copied ? t("transfer.copied") : t("console.copyCommandResponse");
          return `
            <div class="console-entry ${entry.finished ? entry.success ? "success" : "failed" : "running"}">
              <div class="console-command">
                <span>${escapeHtml(formatLogTime(entry.startedAt))}</span>
                <span>${escapeHtml(kubectlLogStatus(entry))}</span>
                <span>${escapeHtml(kubectlLogDuration(entry))}</span>
                <code>${escapeHtml(entry.command)}</code>
                <button class="console-copy-button" type="button" data-action="copy-kubectl-message" data-log-id="${entry.id}" title="${escapeAttr(copyLabel)}" aria-label="${escapeAttr(copyLabel)}">
                  <i data-lucide="${copied ? "check" : "copy"}"></i>
                </button>
              </div>
              <div class="console-output">
                ${output ? `<pre>${escapeHtml(output)}</pre>` : `<pre class="muted">${escapeHtml(t("console.noOutput"))}</pre>`}
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="console-empty">${escapeHtml(t("console.empty"))}</div>`;

  return `
    <section class="console-panel" aria-label="${escapeAttr(t("console.label"))}">
      <div class="console-header">
        <div class="console-title">
          <span>${escapeHtml(t("console.title"))}</span>
          <span>${renderKubectlVersionLabel()}</span>
        </div>
        <button class="console-toggle" type="button" data-action="toggle-console" title="${escapeAttr(state.consoleExpanded ? t("console.collapse") : t("console.expand"))}">
          <i data-lucide="${state.consoleExpanded ? "chevron-down" : "chevron-up"}"></i>
        </button>
      </div>
      <div class="console-list" data-scroll-key="console">${rows}</div>
    </section>
  `;
}

function renderKubectlVersionLabel(): string {
  if (!state.kubectl) {
    return escapeHtml(t("console.checking"));
  }
  if (!state.kubectl.available) {
    return state.kubectl.error
      ? `${escapeHtml(t("console.unavailable"))}: ${escapeHtml(state.kubectl.error)}`
      : escapeHtml(t("console.unavailable"));
  }
  return escapeHtml(state.kubectl.version ?? t("console.available"));
}

function renderContextMenu(): string {
  const menu = state.contextMenu;
  if (!menu) {
    return "";
  }
  const remoteOpen = menu.panel === "remote" && canOpenRemote();
  const remoteDownload = menu.panel === "remote" && state.remote.level === "remote" && canDownload();
  const remoteDelete = menu.panel === "remote" && canDeleteRemote();
  const localOpen = menu.panel === "local" && canOpenLocal();
  const localUpload = menu.panel === "local" && canUpload();
  const localDelete = menu.panel === "local" && canDeleteLocal();
  if (!remoteOpen && !remoteDownload && !remoteDelete && !localOpen && !localUpload && !localDelete) {
    return "";
  }
  return `
    <div class="context-menu" style="left: ${menu.x}px; top: ${menu.y}px;">
      ${
        remoteOpen
          ? `<button type="button" data-action="open-remote"><i data-lucide="folder-open"></i><span>${escapeHtml(t("action.open"))}</span></button>`
          : ""
      }
      ${
        remoteDownload
          ? `<button type="button" data-action="download"><i data-lucide="download"></i><span>${escapeHtml(t("action.download"))}</span></button>`
          : ""
      }
      ${
        remoteDelete
          ? `<button class="danger-menu-item" type="button" data-action="delete-remote"><i data-lucide="trash-2"></i><span>${escapeHtml(t("action.delete"))}</span></button>`
          : ""
      }
      ${
        localOpen
          ? `<button type="button" data-action="open-local"><i data-lucide="folder-open"></i><span>${escapeHtml(t("action.open"))}</span></button>`
          : ""
      }
      ${
        localUpload
          ? `<button type="button" data-action="upload"><i data-lucide="upload"></i><span>${escapeHtml(t("action.upload"))}</span></button>`
          : ""
      }
      ${
        localDelete
          ? `<button class="danger-menu-item" type="button" data-action="delete-local"><i data-lucide="trash-2"></i><span>${escapeHtml(t("action.delete"))}</span></button>`
          : ""
      }
    </div>
  `;
}

function canOpenRemote(): boolean {
  return selectedRemoteOpenIndex() !== null && !state.remote.loading && state.activeKubectlActions === 0;
}

function canOpenLocal(): boolean {
  return selectedLocalOpenIndex() !== null && !state.local.loading;
}

function canDownload(): boolean {
  return Boolean(
    selectedRemoteEntries().length > 0 &&
      remoteTarget() &&
      state.local.path &&
      !state.remote.loading &&
      state.remote.tarAvailable !== false,
  );
}

function canUpload(): boolean {
  return Boolean(
    selectedLocalEntries().length > 0 &&
      remoteTarget() &&
      state.remote.level === "remote" &&
      !state.remote.loading &&
      state.remote.tarAvailable !== false,
  );
}

function canDeleteRemote(): boolean {
  return Boolean(
    selectedRemoteEntries().length > 0 &&
      remoteTarget() &&
      !state.remote.loading &&
      state.activeKubectlActions === 0,
  );
}

function canDeleteLocal(): boolean {
  return selectedLocalEntries().length > 0 && !state.local.loading;
}

function updateSelection(panel: string): void {
  app.querySelectorAll<HTMLElement>(`.file-row[data-panel="${panel}"]`).forEach((row) => {
    const index = Number(row.dataset.index);
    const selected =
      panel === "remote"
        ? remoteRowSelected(index)
        : localRowSelected(index);
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  });
}

function updateActionButtons(): void {
  app.querySelectorAll<HTMLButtonElement>('[data-action="open-remote"]').forEach((button) => {
    button.disabled = !canOpenRemote();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-action="open-local"]').forEach((button) => {
    button.disabled = !canOpenLocal();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-action="download"]').forEach((button) => {
    button.disabled = !canDownload();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-action="upload"]').forEach((button) => {
    button.disabled = !canUpload();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-action="delete-remote"]').forEach((button) => {
    button.disabled = !canDeleteRemote();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-action="delete-local"]').forEach((button) => {
    button.disabled = !canDeleteLocal();
  });
}

function iconForKind(kind: EntryKind): string {
  switch (kind) {
    case "directory":
      return "folder";
    case "file":
      return "file";
    case "symlink":
      return "link";
    default:
      return "file-question";
  }
}

function localKindLabel(entry: LocalFileEntry): string {
  const kind = entryKindLabel(entry.kind);
  if (entry.readonly) {
    return t("kind.readonly", { kind });
  }
  return kind;
}

function entryKindLabel(kind: EntryKind): string {
  switch (kind) {
    case "directory":
      return t("kind.directory");
    case "file":
      return t("kind.file");
    case "symlink":
      return t("kind.symlink");
    default:
      return t("kind.unknown");
  }
}

function podInfoLabel(entry: PodEntry): string {
  return [
    countLabel(entry.restartCount, "pod.restarts.one", "pod.restarts.other"),
    countLabel(entry.containers.length, "pod.containers.one", "pod.containers.other"),
  ].join(", ");
}

function countLabel(count: number, oneKey: TranslationKey, otherKey: TranslationKey): string {
  return t(count === 1 ? oneKey : otherKey, { count });
}

function displayRemoteName(entry: RemoteFileEntry): string {
  if (entry.symlinkTarget) {
    return `${entry.name} -> ${entry.symlinkTarget}`;
  }
  return entry.name;
}

function joinRemotePath(base: string, child: string): string {
  if (base === "/") {
    return `/${child.replace(/^\/+/, "")}`;
  }
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

function parentRemotePath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  if (!normalized || normalized === "/") {
    return "/";
  }
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function formatBytes(size: number | null): string {
  if (size === null || Number.isNaN(size)) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatLocalDate(value: number | null): string {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function elapsedLabel(entry: TransferEntry): string {
  const end = entry.finishedAt ?? Date.now();
  return formatDuration(end - entry.startedAt);
}

function transferInfoLabel(entry: TransferEntry): string {
  if (entry.error) {
    return entry.error;
  }

  const progress = transferProgressFraction(entry);
  const transferredBytes = effectiveTransferredBytes(entry);
  const parts: string[] = [];

  if (progress !== null) {
    const prefix = entry.progressMode === "estimated" && entry.status === "running" ? "~" : "";
    parts.push(`${prefix}${Math.round(progress * 100)}%`);
  }

  if (entry.totalBytes !== null && transferredBytes !== null) {
    parts.push(t("transfer.sizeOf", {
      done: formatBytes(Math.min(transferredBytes, entry.totalBytes)),
      total: formatBytes(entry.totalBytes),
    }));
  } else if (transferredBytes !== null) {
    parts.push(t("transfer.sizeCopied", { bytes: formatBytes(transferredBytes) }));
  }

  const remaining = transferRemainingLabel(entry, transferredBytes);
  if (entry.status === "running" && remaining) {
    parts.push(remaining);
  } else {
    parts.push(t("transfer.elapsed", { time: elapsedLabel(entry) }));
  }

  return parts.join(" | ");
}

function transferProgressPercent(entry: TransferEntry): number | null {
  const fraction = transferProgressFraction(entry);
  return fraction === null ? null : fraction * 100;
}

function transferProgressFraction(entry: TransferEntry): number | null {
  if (entry.totalBytes === null || entry.totalBytes <= 0) {
    return null;
  }

  const transferredBytes = effectiveTransferredBytes(entry);
  if (transferredBytes === null) {
    return null;
  }

  const fraction = transferredBytes / entry.totalBytes;
  const max = entry.status === "running" ? 0.99 : 1;
  return Math.max(0, Math.min(max, fraction));
}

function effectiveTransferredBytes(entry: TransferEntry): number | null {
  if (entry.transferredBytes !== null) {
    return entry.transferredBytes;
  }
  if (entry.status === "running" && entry.progressMode === "estimated") {
    return estimatedTransferredBytes(entry);
  }
  return null;
}

function transferRemainingLabel(entry: TransferEntry, transferredBytes: number | null): string | null {
  if (entry.totalBytes === null || transferredBytes === null || transferredBytes <= 0) {
    return null;
  }

  const elapsedMs = Math.max(1, Date.now() - entry.startedAt);
  const bytesPerMs =
    entry.progressMode === "estimated"
      ? (estimatedTransferBytesPerMs ?? DEFAULT_ESTIMATED_TRANSFER_BYTES_PER_MS)
      : transferredBytes / elapsedMs;
  if (!Number.isFinite(bytesPerMs) || bytesPerMs <= 0) {
    return null;
  }

  const remainingBytes = Math.max(0, entry.totalBytes - transferredBytes);
  if (remainingBytes <= 0) {
    return null;
  }

  return t("transfer.remaining", { time: formatDuration(remainingBytes / bytesPerMs) });
}

function formatDuration(valueMs: number): string {
  const seconds = Math.max(1, Math.round(valueMs / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes} min` : `${minutes} min ${remainingSeconds} s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} h` : `${hours} h ${remainingMinutes} min`;
}

function transferStatusLabel(status: TransferStatus): string {
  switch (status) {
    case "running":
      return t("transfer.status.running");
    case "success":
      return t("transfer.status.success");
    case "failed":
      return t("transfer.status.failed");
  }
}

function isTransferCopyField(value: string | undefined): value is TransferCopyField {
  return value === "source" || value === "destination" || value === "info";
}

function transferCopyValue(entry: TransferEntry, field: TransferCopyField): string {
  switch (field) {
    case "source":
      return entry.source;
    case "destination":
      return entry.destination;
    case "info":
      return transferInfoLabel(entry);
  }
}

function kubectlLogStatus(entry: KubectlLogEntry): string {
  if (!entry.finished) {
    return "RUN";
  }
  return entry.success ? "OK" : t("console.errorStatus");
}

function kubectlLogOutput(entry: KubectlLogEntry): string {
  return [entry.stdout, entry.stderr, entry.error].filter(Boolean).join("\n");
}

function kubectlLogClipboardText(entry: KubectlLogEntry): string {
  const output = kubectlLogOutput(entry) || t("console.noOutput");
  return t("console.clipboardText", { command: entry.command, output });
}

function kubectlLogDuration(entry: KubectlLogEntry): string {
  if (entry.finished) {
    return `${entry.durationMs} ms`;
  }
  return `${Math.max(0, Date.now() - entry.startedAt)} ms`;
}

function formatLogTime(value: number): string {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
