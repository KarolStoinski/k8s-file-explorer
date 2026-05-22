import { invoke } from "@tauri-apps/api/core";
import { createIcons, icons } from "lucide";
import "./styles.css";

type EntryKind = "file" | "directory" | "symlink" | "unknown";
type RemoteLevel = "kubeconfigs" | "namespaces" | "pods" | "containers" | "remote";
type TransferStatus = "running" | "success" | "failed";
type TransferDirection = "download" | "upload" | "temp";

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
  path: string;
  selectedIndex: number | null;
  loading: boolean;
  error: string | null;
}

interface LocalState {
  path: string;
  parent: string | null;
  entries: LocalFileEntry[];
  selectedIndex: number | null;
  loading: boolean;
  error: string | null;
}

interface AppState {
  kubectl: ToolStatus | null;
  remote: RemoteState;
  local: LocalState;
  transfers: TransferEntry[];
  kubectlLogs: KubectlLogEntry[];
  activeKubectlActions: number;
  nextTransferId: number;
  bootError: string | null;
}

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Missing #app root");
}

const app: HTMLDivElement = appRoot;

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
    path: "/",
    selectedIndex: null,
    loading: false,
    error: null,
  },
  local: {
    path: "",
    parent: null,
    entries: [],
    selectedIndex: null,
    loading: false,
    error: null,
  },
  transfers: [],
  kubectlLogs: [],
  activeKubectlActions: 0,
  nextTransferId: 1,
  bootError: null,
};

app.addEventListener("click", (event) => {
  void handleClick(event);
});

app.addEventListener("dblclick", (event) => {
  void handleDoubleClick(event);
});

app.addEventListener("keydown", (event) => {
  void handleKeydown(event);
});

void init();

window.setInterval(() => {
  void loadKubectlLogs();
}, 1000);

async function init(): Promise<void> {
  render();

  try {
    const [kubectl] = await Promise.all([
      invoke<ToolStatus>("check_kubectl"),
      loadKubeconfigs(false),
      loadLocalDir(null, false),
      loadKubectlLogs(false),
    ]);
    state.kubectl = kubectl;
  } catch (error) {
    state.bootError = formatError(error);
  } finally {
    render();
  }
}

async function loadKubectlLogs(shouldRender = true): Promise<void> {
  try {
    const logs = await invoke<KubectlLogEntry[]>("get_kubectl_logs");
    const lastCurrent = state.kubectlLogs.at(-1)?.id ?? null;
    const lastNext = logs.at(-1)?.id ?? null;
    if (lastCurrent === lastNext && state.kubectlLogs.length === logs.length) {
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

function updateKubectlRuntimeViews(): void {
  const consolePanel = app.querySelector<HTMLElement>(".console-panel");
  if (consolePanel) {
    consolePanel.outerHTML = renderKubectlConsole();
  }

  const topActions = app.querySelector<HTMLElement>(".top-actions");
  if (topActions) {
    const activity = topActions.querySelector<HTMLElement>(".kubectl-activity");
    const nextActivity = renderKubectlActivity();
    if (nextActivity && !activity) {
      topActions.insertAdjacentHTML("afterbegin", nextActivity);
    } else if (!nextActivity && activity) {
      activity.remove();
    }
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

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function handleClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement;
  const action = target.closest<HTMLButtonElement>("[data-action]");
  if (action) {
    if (action.disabled) {
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
  } else if (panel === "local") {
    state.local.selectedIndex = index;
  }
  updateSelection(panel ?? "");
  updateActionButtons();
}

async function handleDoubleClick(event: MouseEvent): Promise<void> {
  if (state.remote.loading || state.activeKubectlActions > 0) {
    return;
  }

  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>("[data-panel][data-index]");
  if (!row) {
    return;
  }

  const index = Number(row.dataset.index);
  if (!Number.isFinite(index)) {
    return;
  }

  if (row.dataset.panel === "remote") {
    await openRemoteIndex(index);
  } else if (row.dataset.panel === "local") {
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
    ["refresh-remote", "remote-up", "remote-root", "download", "upload"].includes(action)
  ) {
    return;
  }

  switch (action) {
    case "refresh-remote":
      await refreshRemote();
      break;
    case "refresh-local":
      await loadLocalDir(state.local.path || null, true);
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
    case "download":
      await downloadSelectedRemote();
      break;
    case "upload":
      await uploadSelectedLocal();
      break;
  }
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

async function openKubeconfig(index: number): Promise<void> {
  const kubeconfig = state.remote.kubeconfigs[index];
  if (!kubeconfig) {
    return;
  }
  if (!kubeconfig.isValid && !window.confirm(`${kubeconfig.name} może nie być kubeconfigiem. Spróbować mimo to?`)) {
    return;
  }

  state.remote = {
    ...state.remote,
    level: "namespaces",
    kubeconfig,
    namespace: null,
    pod: null,
    container: null,
    namespaces: [],
    pods: [],
    containers: [],
    entries: [],
    path: "/",
    selectedIndex: null,
    loading: true,
    error: null,
  };
  render();

  try {
    state.remote.namespaces = await invokeKubectl<NamespaceEntry[]>("list_namespaces", {
      kubeconfig: kubeconfig.path,
    });
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

  state.remote = {
    ...state.remote,
    level: "pods",
    namespace,
    pod: null,
    container: null,
    pods: [],
    containers: [],
    entries: [],
    selectedIndex: null,
    loading: true,
    error: null,
  };
  render();

  try {
    state.remote.pods = await invokeKubectl<PodEntry[]>("list_pods", {
      kubeconfig: kubeconfig.path,
      namespace: namespace.name,
    });
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

  state.remote = {
    ...state.remote,
    pod,
    container: null,
    containers: [],
    entries: [],
    selectedIndex: null,
    loading: true,
    error: null,
  };
  render();

  try {
    const containers = await invokeKubectl<ContainerEntry[]>("list_containers", {
      kubeconfig: kubeconfig.path,
      namespace: namespace.name,
      pod: pod.name,
    });

    state.remote.containers = containers;
    if (containers.length > 1) {
      state.remote.level = "containers";
      state.remote.loading = false;
      render();
      return;
    }

    state.remote.container = containers[0] ?? null;
    state.remote.level = "remote";
    state.remote.loading = false;
    await loadRemotePath("/");
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
  state.remote.level = "remote";
  state.remote.selectedIndex = null;
  await loadRemotePath("/");
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

  if (!window.confirm(`Pobrać plik "${entry.name}" do katalogu tymczasowego i otworzyć lokalnie?`)) {
    return;
  }

  const target = remoteTarget();
  if (!target) {
    return;
  }

  const transferId = addTransfer("temp", entry.path, "temp");
  try {
    const result = await invokeKubectl<TempDownloadResult>("download_remote_to_temp", {
      target,
      remotePath: entry.path,
    });
    updateTransfer(transferId, "success", result.localPath, null);
    await invoke("open_local_file", { path: result.localPath });
  } catch (error) {
    updateTransfer(transferId, "failed", "temp", formatError(error));
  }
}

async function loadRemotePath(path: string): Promise<void> {
  const target = remoteTarget();
  if (!target) {
    return;
  }

  state.remote = {
    ...state.remote,
    level: "remote",
    path,
    entries: [],
    selectedIndex: null,
    loading: true,
    error: null,
  };
  render();

  try {
    state.remote.entries = await invokeKubectl<RemoteFileEntry[]>("list_remote_dir", {
      target,
      path,
    });
  } catch (error) {
    state.remote.error = formatError(error);
  } finally {
    state.remote.loading = false;
    render();
  }
}

async function loadLocalDir(path: string | null, showLoading: boolean): Promise<void> {
  if (showLoading) {
    state.local.loading = true;
    state.local.error = null;
    render();
  }

  try {
    const directory = await invoke<LocalDirectory>("list_local_dir", { path });
    state.local.path = directory.path;
    state.local.parent = directory.parent;
    state.local.entries = directory.entries;
    state.local.selectedIndex = null;
    state.local.error = null;
  } catch (error) {
    state.local.error = formatError(error);
  } finally {
    state.local.loading = false;
    if (showLoading) {
      render();
    }
  }
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
        await openKubeconfig(state.remote.kubeconfigs.indexOf(state.remote.kubeconfig));
      }
      break;
    case "pods":
      if (state.remote.namespace) {
        await openNamespace(state.remote.namespaces.indexOf(state.remote.namespace));
      }
      break;
    case "containers":
      if (state.remote.pod) {
        await openPod(state.remote.pods.indexOf(state.remote.pod));
      }
      break;
    case "remote":
      await loadRemotePath(state.remote.path);
      break;
  }
}

async function remoteUp(): Promise<void> {
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
      state.remote.selectedIndex = null;
      render();
      return;
    case "containers":
      state.remote.level = "pods";
      state.remote.pod = null;
      state.remote.container = null;
      state.remote.selectedIndex = null;
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
      } else {
        state.remote.level = "pods";
        state.remote.pod = null;
        state.remote.container = null;
      }
      state.remote.entries = [];
      state.remote.selectedIndex = null;
      render();
      return;
  }
}

async function downloadSelectedRemote(): Promise<void> {
  const entry = selectedRemoteEntry();
  const target = remoteTarget();
  if (!entry || !target || !state.local.path) {
    return;
  }

  const destination = await invoke<string>("join_local_path", {
    base: state.local.path,
    child: entry.name,
  });

  if (localNameExists(entry.name) && !window.confirm(`Lokalny element "${entry.name}" już istnieje. Nadpisać?`)) {
    return;
  }

  const transferId = addTransfer("download", entry.path, destination);
  try {
    await invokeKubectl("copy_remote_to_local", {
      target,
      remotePath: entry.path,
      localPath: destination,
    });
    updateTransfer(transferId, "success", destination, null);
    await loadLocalDir(state.local.path, true);
  } catch (error) {
    updateTransfer(transferId, "failed", destination, formatError(error));
  }
}

async function uploadSelectedLocal(): Promise<void> {
  const entry = selectedLocalEntry();
  const target = remoteTarget();
  if (!entry || !target || state.remote.level !== "remote") {
    return;
  }

  const destination = joinRemotePath(state.remote.path, entry.name);
  if (remoteNameExists(entry.name) && !window.confirm(`Zdalny element "${entry.name}" już istnieje. Nadpisać?`)) {
    return;
  }

  const transferId = addTransfer("upload", entry.path, destination);
  try {
    await invokeKubectl("copy_local_to_remote", {
      target,
      localPath: entry.path,
      remotePath: destination,
    });
    updateTransfer(transferId, "success", destination, null);
    await loadRemotePath(state.remote.path);
  } catch (error) {
    updateTransfer(transferId, "failed", destination, formatError(error));
  }
}

function resetRemoteToRoot(): void {
  state.remote.level = "kubeconfigs";
  state.remote.namespace = null;
  state.remote.pod = null;
  state.remote.container = null;
  state.remote.namespaces = [];
  state.remote.pods = [];
  state.remote.containers = [];
  state.remote.entries = [];
  state.remote.path = "/";
  state.remote.selectedIndex = null;
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
  if (state.remote.level !== "remote" || state.remote.selectedIndex === null) {
    return null;
  }
  return state.remote.entries[state.remote.selectedIndex] ?? null;
}

function selectedLocalEntry(): LocalFileEntry | null {
  if (state.local.selectedIndex === null) {
    return null;
  }
  return state.local.entries[state.local.selectedIndex] ?? null;
}

function localNameExists(name: string): boolean {
  return state.local.entries.some((entry) => entry.name === name);
}

function remoteNameExists(name: string): boolean {
  return state.remote.entries.some((entry) => entry.name === name);
}

function addTransfer(direction: TransferDirection, source: string, destination: string): number {
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
  render();
}

function render(): void {
  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">k8s</span>
          <div>
            <h1>k8s-file-explorer</h1>
            <p>${renderKubectlStatus()}</p>
          </div>
        </div>
        <div class="top-actions">
          ${renderKubectlActivity()}
          <button class="tool-button" type="button" data-action="download" title="Pobierz z poda" ${canDownload() ? "" : "disabled"}>
            <i data-lucide="download"></i><span>Pobierz</span>
          </button>
          <button class="tool-button" type="button" data-action="upload" title="Wyślij do poda" ${canUpload() ? "" : "disabled"}>
            <i data-lucide="upload"></i><span>Wyślij</span>
          </button>
        </div>
      </header>
      ${state.bootError ? `<div class="banner error">${escapeHtml(state.bootError)}</div>` : `<div class="banner-placeholder" aria-hidden="true"></div>`}
      <main class="workspace">
        ${renderRemotePanel()}
        ${renderLocalPanel()}
      </main>
      ${renderTransfers()}
      ${renderKubectlConsole()}
    </div>
  `;

  createIcons({ icons });
  updateActionButtons();
}

function renderKubectlStatus(): string {
  if (!state.kubectl) {
    return "Sprawdzanie kubectl...";
  }
  if (!state.kubectl.available) {
    return `kubectl niedostępny${state.kubectl.error ? `: ${escapeHtml(state.kubectl.error)}` : ""}`;
  }
  return `kubectl ${escapeHtml(state.kubectl.version ?? "dostępny")}`;
}

function renderKubectlActivity(): string {
  if (state.activeKubectlActions === 0) {
    return "";
  }
  return `
    <span class="kubectl-activity" aria-live="polite">
      <i data-lucide="loader"></i>
      <span>kubectl działa</span>
    </span>
  `;
}

function renderRemotePanel(): string {
  return `
    <section class="panel remote-panel" aria-label="Kubernetes">
      <div class="panel-header">
        <div>
          <h2>Kubernetes</h2>
          <div class="breadcrumbs">${renderRemoteBreadcrumbs()}</div>
        </div>
        <div class="panel-actions">
          <button class="icon-button" type="button" data-action="remote-root" title="Katalog główny Kubernetes" ${state.remote.loading || state.activeKubectlActions > 0 ? "disabled" : ""}>
            <i data-lucide="network"></i>
          </button>
          <button class="icon-button" type="button" data-action="remote-up" title="Poziom wyżej" ${state.remote.level === "kubeconfigs" || state.remote.loading || state.activeKubectlActions > 0 ? "disabled" : ""}>
            <i data-lucide="arrow-up"></i>
          </button>
          <button class="icon-button" type="button" data-action="refresh-remote" title="Odśwież" ${state.remote.loading || state.activeKubectlActions > 0 ? "disabled" : ""}>
            <i data-lucide="${state.remote.loading || state.activeKubectlActions > 0 ? "loader" : "refresh-cw"}"></i>
          </button>
        </div>
      </div>
      <div class="table-header remote-grid">
        <span>Nazwa</span>
        <span>Status</span>
        <span>Rozmiar</span>
        <span>Info</span>
      </div>
      <div class="file-list" role="listbox" aria-busy="${state.remote.loading}">
        ${renderRemoteRows()}
      </div>
    </section>
  `;
}

function renderLocalPanel(): string {
  return `
    <section class="panel local-panel" aria-label="Lokalny system plików">
      <div class="panel-header">
        <div>
          <h2>Lokalnie</h2>
          <input class="path-input" data-local-path value="${escapeAttr(state.local.path)}" aria-label="Lokalna ścieżka" />
        </div>
        <div class="panel-actions">
          <button class="icon-button" type="button" data-action="local-home" title="Katalog domowy">
            <i data-lucide="home"></i>
          </button>
          <button class="icon-button" type="button" data-action="local-up" title="Poziom wyżej" ${state.local.parent ? "" : "disabled"}>
            <i data-lucide="arrow-up"></i>
          </button>
          <button class="icon-button" type="button" data-action="refresh-local" title="Odśwież">
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
      </div>
      <div class="table-header local-grid">
        <span>Nazwa</span>
        <span>Typ</span>
        <span>Rozmiar</span>
        <span>Modyfikacja</span>
      </div>
      <div class="file-list" role="listbox" aria-busy="${state.local.loading}">
        ${renderLocalRows()}
      </div>
    </section>
  `;
}

function renderRemoteRows(): string {
  if (state.remote.loading) {
    return renderEmptyState("loader", "Ładowanie...");
  }
  if (state.remote.error) {
    return renderEmptyState("triangle-alert", state.remote.error, "error");
  }

  switch (state.remote.level) {
    case "kubeconfigs":
      if (state.remote.kubeconfigs.length === 0) {
        return renderEmptyState("folder-search", "Brak kubeconfigów w ~/.kube.");
      }
      return state.remote.kubeconfigs
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: state.remote.selectedIndex === index,
            icon: entry.isValid ? "server" : "triangle-alert",
            name: entry.name,
            status: entry.isValid ? "kubeconfig" : "niepoprawny",
            size: "",
            info: entry.path,
            muted: !entry.isValid,
          }),
        )
        .join("");
    case "namespaces":
      if (state.remote.namespaces.length === 0) {
        return renderEmptyState("folder-open", "Brak namespace'ów.");
      }
      return state.remote.namespaces
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: state.remote.selectedIndex === index,
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
        return renderEmptyState("box", "Brak podów.");
      }
      return state.remote.pods
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: state.remote.selectedIndex === index,
            icon: "box",
            name: entry.name,
            status: entry.phase ?? "",
            size: entry.ready,
            info: `${entry.restartCount} restartów, ${entry.containers.length} kont.`,
            muted: entry.phase !== "Running",
          }),
        )
        .join("");
    case "containers":
      if (state.remote.containers.length === 0) {
        return renderEmptyState("container", "Brak kontenerów.");
      }
      return state.remote.containers
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: state.remote.selectedIndex === index,
            icon: "container",
            name: entry.name,
            status: entry.ready === null ? "" : entry.ready ? "ready" : "not ready",
            size: "",
            info: entry.image ?? "",
            muted: entry.ready === false,
          }),
        )
        .join("");
    case "remote":
      if (state.remote.entries.length === 0) {
        return renderEmptyState("folder-open", "Pusty katalog.");
      }
      return state.remote.entries
        .map((entry, index) =>
          renderRow({
            panel: "remote",
            index,
            grid: "remote-grid",
            selected: state.remote.selectedIndex === index,
            icon: iconForKind(entry.kind),
            name: displayRemoteName(entry),
            status: entry.permissions ?? entry.kind,
            size: formatBytes(entry.size),
            info: entry.modifiedAt ?? "",
          }),
        )
        .join("");
  }
}

function renderLocalRows(): string {
  if (state.local.loading) {
    return renderEmptyState("loader", "Ładowanie...");
  }
  if (state.local.error) {
    return renderEmptyState("triangle-alert", state.local.error, "error");
  }
  if (state.local.entries.length === 0) {
    return renderEmptyState("folder-open", "Pusty katalog.");
  }

  return state.local.entries
    .map((entry, index) =>
      renderRow({
        panel: "local",
        index,
        grid: "local-grid",
        selected: state.local.selectedIndex === index,
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
      <span class="truncate">${escapeHtml(options.info)}</span>
    </button>
  `;
}

function renderEmptyState(icon: string, message: string, tone = ""): string {
  return `
    <div class="empty-state ${tone}">
      <i data-lucide="${icon}"></i>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function renderRemoteBreadcrumbs(): string {
  const crumbs = ["root"];
  if (state.remote.kubeconfig) {
    crumbs.push(state.remote.kubeconfig.name);
  }
  if (state.remote.namespace) {
    crumbs.push(state.remote.namespace.name);
  }
  if (state.remote.pod) {
    crumbs.push(state.remote.pod.name);
  }
  if (state.remote.container) {
    crumbs.push(state.remote.container.name);
  }
  if (state.remote.level === "remote") {
    crumbs.push(state.remote.path);
  }

  return crumbs.map((crumb) => `<span>${escapeHtml(crumb)}</span>`).join("<i data-lucide=\"chevron-right\"></i>");
}

function renderTransfers(): string {
  const rows = state.transfers.length
    ? state.transfers
        .map((entry) => {
          const icon = entry.status === "running" ? "loader" : entry.status === "success" ? "check" : "circle-x";
          const direction = entry.direction === "upload" ? "upload" : entry.direction === "download" ? "download" : "file-down";
          return `
            <div class="transfer-row ${entry.status}">
              <span class="transfer-status"><i data-lucide="${icon}"></i>${escapeHtml(entry.status)}</span>
              <span><i data-lucide="${direction}"></i></span>
              <span class="truncate">${escapeHtml(entry.source)}</span>
              <span class="truncate">${escapeHtml(entry.destination)}</span>
              <span class="truncate">${escapeHtml(entry.error ?? elapsedLabel(entry))}</span>
            </div>
          `;
        })
        .join("")
    : `<div class="transfer-empty">Brak transferów</div>`;

  return `
    <section class="transfer-panel" aria-label="Transfery">
      <div class="transfer-header">
        <span>Status</span>
        <span></span>
        <span>Źródło</span>
        <span>Cel</span>
        <span>Info</span>
      </div>
      <div class="transfer-list">${rows}</div>
    </section>
  `;
}

function renderKubectlConsole(): string {
  const rows = state.kubectlLogs.length
    ? state.kubectlLogs
        .slice()
        .reverse()
        .map((entry) => {
          const output = [entry.stdout, entry.stderr, entry.error].filter(Boolean).join("\n");
          return `
            <div class="console-entry ${entry.finished ? entry.success ? "success" : "failed" : "running"}">
              <div class="console-command">
                <span>${escapeHtml(formatLogTime(entry.startedAt))}</span>
                <span>${escapeHtml(kubectlLogStatus(entry))}</span>
                <span>${escapeHtml(kubectlLogDuration(entry))}</span>
                <code>${escapeHtml(entry.command)}</code>
              </div>
              ${output ? `<pre>${escapeHtml(output)}</pre>` : `<pre class="muted">Brak outputu</pre>`}
            </div>
          `;
        })
        .join("")
    : `<div class="console-empty">Brak wywołań kubectl</div>`;

  return `
    <section class="console-panel" aria-label="Konsola kubectl">
      <div class="console-header">
        <span>Konsola kubectl</span>
      </div>
      <div class="console-list">${rows}</div>
    </section>
  `;
}

function canDownload(): boolean {
  return Boolean(selectedRemoteEntry() && remoteTarget() && state.local.path && !state.remote.loading && state.activeKubectlActions === 0);
}

function canUpload(): boolean {
  return Boolean(
    selectedLocalEntry() &&
      remoteTarget() &&
      state.remote.level === "remote" &&
      !state.remote.loading &&
      state.activeKubectlActions === 0,
  );
}

function updateSelection(panel: string): void {
  app.querySelectorAll<HTMLElement>(`.file-row[data-panel="${panel}"]`).forEach((row) => {
    const index = Number(row.dataset.index);
    const selected =
      panel === "remote"
        ? state.remote.selectedIndex === index
        : state.local.selectedIndex === index;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-selected", String(selected));
  });
}

function updateActionButtons(): void {
  const download = app.querySelector<HTMLButtonElement>('[data-action="download"]');
  const upload = app.querySelector<HTMLButtonElement>('[data-action="upload"]');
  if (download) {
    download.disabled = !canDownload();
  }
  if (upload) {
    upload.disabled = !canUpload();
  }
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
  if (entry.readonly) {
    return `${entry.kind}, read-only`;
  }
  return entry.kind;
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
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function elapsedLabel(entry: TransferEntry): string {
  const end = entry.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - entry.startedAt) / 1000));
  return seconds <= 1 ? "1 s" : `${seconds} s`;
}

function kubectlLogStatus(entry: KubectlLogEntry): string {
  if (!entry.finished) {
    return "RUN";
  }
  return entry.success ? "OK" : "BŁĄD";
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
  return new Date(value).toLocaleTimeString(undefined, {
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
