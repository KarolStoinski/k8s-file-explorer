use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    ffi::{OsStr, OsString},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use wait_timeout::ChildExt;

const DEFAULT_KUBECTL_TIMEOUT: Duration = Duration::from_secs(120);
const KUBECTL_REQUEST_TIMEOUT: &str = "90s";
const COPY_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_KUBECONFIG_BYTES: u64 = 10 * 1024 * 1024;
const KUBECTL_TIMEOUT_ENV: &str = "K8S_FILE_EXPLORER_KUBECTL_TIMEOUT_SECONDS";
const MAX_KUBECTL_LOGS: usize = 200;

static KUBECTL_LOGS: OnceLock<Mutex<Vec<KubectlLogEntry>>> = OnceLock::new();
static ACTIVE_KUBECTL_OPERATIONS: OnceLock<Mutex<HashMap<u64, u32>>> = OnceLock::new();
static NEXT_KUBECTL_LOG_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KubeconfigEntry {
    id: String,
    name: String,
    path: String,
    is_valid: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NamespaceEntry {
    name: String,
    status: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PodEntry {
    name: String,
    namespace: String,
    phase: Option<String>,
    ready: String,
    restart_count: u64,
    containers: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContainerEntry {
    name: String,
    image: Option<String>,
    ready: Option<bool>,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum EntryKind {
    File,
    Directory,
    Symlink,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileEntry {
    name: String,
    path: String,
    kind: EntryKind,
    size: Option<u64>,
    permissions: Option<String>,
    owner: Option<String>,
    group: Option<String>,
    modified_at: Option<String>,
    symlink_target: Option<String>,
    can_read: bool,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileEntry {
    name: String,
    path: String,
    kind: EntryKind,
    size: Option<u64>,
    modified_at: Option<u64>,
    readonly: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalDirectory {
    path: String,
    parent: Option<String>,
    entries: Vec<LocalFileEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTarget {
    kubeconfig: String,
    namespace: String,
    pod: String,
    container: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferResult {
    source: String,
    destination: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TempDownloadResult {
    local_path: String,
}

#[derive(Debug)]
struct ProcessOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KubectlLogEntry {
    id: u64,
    command: String,
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
    error: Option<String>,
    started_at: u64,
    duration_ms: u128,
    finished: bool,
}

#[tauri::command]
fn check_kubectl() -> ToolStatus {
    let args = kubectl_args_with_request_timeout(os_args(["version", "--client", "-o", "json"]));
    let program = kubectl_program();

    match run_logged_kubectl_program(&program, &args, kubectl_timeout(), None) {
        Ok(output) if output.success => {
            let version = serde_json::from_str::<Value>(&output.stdout)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/clientVersion/gitVersion")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            value
                                .pointer("/clientVersion/major")
                                .and_then(Value::as_str)
                        })
                        .map(ToOwned::to_owned)
                });

            ToolStatus {
                available: true,
                version,
                error: None,
            }
        }
        Ok(output) => ToolStatus {
            available: false,
            version: None,
            error: Some(format_process_error("kubectl version", &output)),
        },
        Err(error) => ToolStatus {
            available: false,
            version: None,
            error: Some(error),
        },
    }
}

#[tauri::command]
fn scan_kubeconfigs() -> Result<Vec<KubeconfigEntry>, String> {
    let kube_dir = home_dir()?.join(".kube");
    if !kube_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&kube_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        if metadata.len() > MAX_KUBECONFIG_BYTES {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let looks_valid = looks_like_kubeconfig(&path);
        let candidate = is_kubeconfig_candidate(&path, &name) || looks_valid;
        if !candidate {
            continue;
        }

        entries.push(KubeconfigEntry {
            id: path_id(&path),
            name,
            path: path_to_string(&path),
            is_valid: looks_valid,
            error: if looks_valid {
                None
            } else {
                Some("Plik nie wygląda jak kubeconfig.".to_string())
            },
        });
    }

    entries.sort_by(|a, b| {
        let a_key = if a.name == "config" { "" } else { &a.name };
        let b_key = if b.name == "config" { "" } else { &b.name };
        a_key.to_lowercase().cmp(&b_key.to_lowercase())
    });

    Ok(entries)
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    Ok(path_to_string(&home_dir()?))
}

#[tauri::command]
fn get_kubectl_logs() -> Vec<KubectlLogEntry> {
    kubectl_logs()
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn list_namespaces(kubeconfig: String) -> Result<Vec<NamespaceEntry>, String> {
    let args = vec![
        OsString::from("--kubeconfig"),
        OsString::from(kubeconfig),
        OsString::from("get"),
        OsString::from("namespaces"),
        OsString::from("-o"),
        OsString::from("custom-columns=NAME:.metadata.name,STATUS:.status.phase"),
        OsString::from("--no-headers"),
    ];

    let stdout = run_kubectl(args)?;
    let mut namespaces = stdout
        .lines()
        .filter_map(parse_namespace_summary_line)
        .collect::<Vec<_>>();

    namespaces.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(namespaces)
}

#[tauri::command]
fn list_pods(kubeconfig: String, namespace: String) -> Result<Vec<PodEntry>, String> {
    let args = vec![
        OsString::from("--kubeconfig"),
        OsString::from(kubeconfig),
        OsString::from("-n"),
        OsString::from(namespace.clone()),
        OsString::from("get"),
        OsString::from("pods"),
        OsString::from("-o"),
        OsString::from("custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,CONTAINERS:.spec.containers[*].name"),
        OsString::from("--no-headers"),
    ];

    let stdout = run_kubectl(args)?;
    let mut pods = stdout
        .lines()
        .filter_map(|line| parse_pod_summary_line(line, &namespace))
        .collect::<Vec<_>>();

    pods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(pods)
}

#[tauri::command]
fn list_containers(
    kubeconfig: String,
    namespace: String,
    pod: String,
) -> Result<Vec<ContainerEntry>, String> {
    let args = vec![
        OsString::from("--kubeconfig"),
        OsString::from(kubeconfig),
        OsString::from("-n"),
        OsString::from(namespace),
        OsString::from("get"),
        OsString::from("pod"),
        OsString::from(pod),
        OsString::from("-o"),
        OsString::from("custom-columns=NAME:.spec.containers[*].name,IMAGE:.spec.containers[*].image,READY:.status.containerStatuses[*].ready"),
        OsString::from("--no-headers"),
    ];

    let stdout = run_kubectl(args)?;
    let containers = parse_container_summary(&stdout);

    Ok(containers)
}

fn parse_namespace_summary_line(line: &str) -> Option<NamespaceEntry> {
    let mut columns = line.split_whitespace();
    let name = columns.next()?.to_string();
    let status = columns.next().and_then(none_marker_to_option);
    Some(NamespaceEntry { name, status })
}

fn parse_container_summary(stdout: &str) -> Vec<ContainerEntry> {
    stdout
        .lines()
        .next()
        .map(parse_container_summary_line)
        .unwrap_or_default()
}

fn parse_container_summary_line(line: &str) -> Vec<ContainerEntry> {
    let columns = line.split_whitespace().collect::<Vec<_>>();
    if columns.len() < 3 {
        return Vec::new();
    }

    let names = split_kubectl_list(columns[0]);
    let images = split_kubectl_list(columns[1]);
    let readiness = split_kubectl_list(columns[2]);

    names
        .into_iter()
        .enumerate()
        .map(|(index, name)| ContainerEntry {
            name,
            image: images.get(index).cloned(),
            ready: readiness
                .get(index)
                .map(|value| value.eq_ignore_ascii_case("true")),
        })
        .collect()
}

fn parse_pod_summary_line(line: &str, namespace: &str) -> Option<PodEntry> {
    let columns = line.split_whitespace().collect::<Vec<_>>();
    if columns.len() < 5 {
        return None;
    }

    let name = columns[0].to_string();
    let phase = none_marker_to_option(columns[1]);
    let ready_values = split_kubectl_list(columns[2]);
    let restart_values = split_kubectl_list(columns[3]);
    let containers = split_kubectl_list(columns[4]);
    let ready_count = ready_values
        .iter()
        .filter(|value| value.eq_ignore_ascii_case("true"))
        .count();
    let total_containers = containers.len().max(ready_values.len());
    let restart_count = restart_values
        .iter()
        .filter_map(|value| value.parse::<u64>().ok())
        .sum();

    Some(PodEntry {
        name,
        namespace: namespace.to_string(),
        phase,
        ready: format!("{ready_count}/{total_containers}"),
        restart_count,
        containers,
    })
}

fn split_kubectl_list(value: &str) -> Vec<String> {
    if value == "<none>" || value.is_empty() {
        return Vec::new();
    }
    value
        .split(',')
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn none_marker_to_option(value: &str) -> Option<String> {
    if value == "<none>" {
        None
    } else {
        Some(value.to_string())
    }
}

#[tauri::command]
fn list_remote_dir(target: RemoteTarget, path: String) -> Result<Vec<RemoteFileEntry>, String> {
    let mut args = target_base_args(&target);
    args.push(OsString::from("exec"));
    args.push(OsString::from(&target.pod));
    if let Some(container) = target
        .container
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.push(OsString::from("-c"));
        args.push(OsString::from(container));
    }
    args.push(OsString::from("--"));
    args.push(OsString::from("ls"));
    args.push(OsString::from("-la"));
    args.push(OsString::from("--"));
    args.push(OsString::from(&path));

    let stdout = run_kubectl(args)?;
    let mut entries = stdout
        .lines()
        .filter_map(|line| parse_ls_line(line, &path))
        .collect::<Vec<_>>();

    entries.sort_by(|a, b| {
        kind_order(&a.kind)
            .cmp(&kind_order(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
fn list_local_dir(path: Option<String>) -> Result<LocalDirectory, String> {
    let directory = match path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => home_dir()?,
    };

    if !directory.exists() {
        return Err("Lokalna ścieżka nie istnieje.".to_string());
    }
    if !directory.is_dir() {
        return Err("Lokalna ścieżka nie jest katalogiem.".to_string());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        let file_type = metadata.file_type();
        let kind = if file_type.is_dir() {
            EntryKind::Directory
        } else if file_type.is_file() {
            EntryKind::File
        } else if file_type.is_symlink() {
            EntryKind::Symlink
        } else {
            EntryKind::Unknown
        };

        entries.push(LocalFileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: path_to_string(&path),
            kind,
            size: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            modified_at: metadata.modified().ok().and_then(system_time_to_millis),
            readonly: metadata.permissions().readonly(),
        });
    }

    entries.sort_by(|a, b| {
        kind_order(&a.kind)
            .cmp(&kind_order(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(LocalDirectory {
        path: path_to_string(&directory),
        parent: directory.parent().map(path_to_string),
        entries,
    })
}

#[tauri::command]
fn join_local_path(base: String, child: String) -> String {
    path_to_string(&PathBuf::from(base).join(child))
}

#[tauri::command]
async fn copy_remote_to_local(
    target: RemoteTarget,
    remote_path: String,
    local_path: String,
    operation_id: Option<u64>,
) -> Result<TransferResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_remote_to_local_blocking(target, remote_path, local_path, operation_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn copy_remote_to_local_blocking(
    target: RemoteTarget,
    remote_path: String,
    local_path: String,
    operation_id: Option<u64>,
) -> Result<TransferResult, String> {
    let mut args = target_base_args(&target);
    args.push(OsString::from("cp"));
    if let Some(container) = target
        .container
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.push(OsString::from("-c"));
        args.push(OsString::from(container));
    }
    args.push(OsString::from(format!("{}:{remote_path}", target.pod)));
    args.push(OsString::from(&local_path));

    run_kubectl_with_timeout_and_operation(args, COPY_TIMEOUT, operation_id)?;
    Ok(TransferResult {
        source: remote_path,
        destination: local_path,
        message: "Transfer zakończony.".to_string(),
    })
}

#[tauri::command]
async fn copy_local_to_remote(
    target: RemoteTarget,
    local_path: String,
    remote_path: String,
    operation_id: Option<u64>,
) -> Result<TransferResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy_local_to_remote_blocking(target, local_path, remote_path, operation_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn copy_local_to_remote_blocking(
    target: RemoteTarget,
    local_path: String,
    remote_path: String,
    operation_id: Option<u64>,
) -> Result<TransferResult, String> {
    let mut args = target_base_args(&target);
    args.push(OsString::from("cp"));
    if let Some(container) = target
        .container
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        args.push(OsString::from("-c"));
        args.push(OsString::from(container));
    }
    args.push(OsString::from(&local_path));
    args.push(OsString::from(format!("{}:{remote_path}", target.pod)));

    run_kubectl_with_timeout_and_operation(args, COPY_TIMEOUT, operation_id)?;
    Ok(TransferResult {
        source: local_path,
        destination: remote_path,
        message: "Transfer zakończony.".to_string(),
    })
}

#[tauri::command]
async fn download_remote_to_temp(
    target: RemoteTarget,
    remote_path: String,
    operation_id: Option<u64>,
) -> Result<TempDownloadResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        download_remote_to_temp_blocking(target, remote_path, operation_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn download_remote_to_temp_blocking(
    target: RemoteTarget,
    remote_path: String,
    operation_id: Option<u64>,
) -> Result<TempDownloadResult, String> {
    let temp_dir = std::env::temp_dir().join("k8s-file-explorer");
    fs::create_dir_all(&temp_dir).map_err(|error| error.to_string())?;

    let file_name = remote_file_name(&remote_path)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "remote-file".to_string());
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let local_path = temp_dir.join(format!("{millis}-{}", sanitize_file_name(&file_name)));
    let local_path_string = path_to_string(&local_path);

    copy_remote_to_local_blocking(target, remote_path, local_path_string.clone(), operation_id)?;
    Ok(TempDownloadResult {
        local_path: local_path_string,
    })
}

#[tauri::command]
fn cancel_kubectl_operation(operation_id: u64) -> Result<(), String> {
    let Some(process_id) = active_kubectl_operations()
        .lock()
        .map_err(|error| error.to_string())?
        .get(&operation_id)
        .copied()
    else {
        return Err("Operacja nie jest już aktywna.".to_string());
    };

    kill_process(process_id)
}

#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    open::that(path).map_err(|error| error.to_string())
}

fn run_kubectl(args: Vec<OsString>) -> Result<String, String> {
    run_kubectl_with_timeout(args, kubectl_timeout())
}

fn run_kubectl_with_timeout(args: Vec<OsString>, timeout: Duration) -> Result<String, String> {
    run_kubectl_with_timeout_and_operation(args, timeout, None)
}

fn run_kubectl_with_timeout_and_operation(
    args: Vec<OsString>,
    timeout: Duration,
    operation_id: Option<u64>,
) -> Result<String, String> {
    let program = kubectl_program();
    let args = kubectl_args_with_request_timeout(args);
    let output = run_logged_kubectl_program(&program, &args, timeout, operation_id)?;
    if output.success {
        Ok(output.stdout)
    } else {
        Err(format_process_error("kubectl", &output))
    }
}

fn run_logged_kubectl_program(
    program: &OsStr,
    args: &[OsString],
    timeout: Duration,
    operation_id: Option<u64>,
) -> Result<ProcessOutput, String> {
    let command = format_command(program, args);
    let id = NEXT_KUBECTL_LOG_ID.fetch_add(1, Ordering::Relaxed);
    let started_at = now_millis();
    let started = std::time::Instant::now();
    push_kubectl_log(KubectlLogEntry {
        id,
        command,
        success: false,
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        error: None,
        started_at,
        duration_ms: 0,
        finished: false,
    });

    let output = match run_program(program, args, timeout, operation_id) {
        Ok(output) => output,
        Err(error) => {
            update_kubectl_log(KubectlLogEntry {
                id,
                command: format_command(program, args),
                success: false,
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(error.clone()),
                started_at,
                duration_ms: started.elapsed().as_millis(),
                finished: true,
            });
            return Err(error);
        }
    };

    update_kubectl_log(KubectlLogEntry {
        id,
        command: format_command(program, args),
        success: output.success,
        code: output.code,
        stdout: output.stdout.clone(),
        stderr: output.stderr.clone(),
        error: None,
        started_at,
        duration_ms: started.elapsed().as_millis(),
        finished: true,
    });
    Ok(output)
}

fn kubectl_logs() -> &'static Mutex<Vec<KubectlLogEntry>> {
    KUBECTL_LOGS.get_or_init(|| Mutex::new(Vec::new()))
}

fn push_kubectl_log(entry: KubectlLogEntry) {
    let Ok(mut logs) = kubectl_logs().lock() else {
        return;
    };
    logs.push(entry);
    if logs.len() > MAX_KUBECTL_LOGS {
        let overflow = logs.len() - MAX_KUBECTL_LOGS;
        logs.drain(0..overflow);
    }
}

fn update_kubectl_log(entry: KubectlLogEntry) {
    let Ok(mut logs) = kubectl_logs().lock() else {
        return;
    };
    if let Some(existing) = logs.iter_mut().find(|log| log.id == entry.id) {
        *existing = entry;
    } else {
        logs.push(entry);
    }
}

fn active_kubectl_operations() -> &'static Mutex<HashMap<u64, u32>> {
    ACTIVE_KUBECTL_OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_kubectl_operation(operation_id: u64, process_id: u32) {
    if let Ok(mut operations) = active_kubectl_operations().lock() {
        operations.insert(operation_id, process_id);
    }
}

fn unregister_kubectl_operation(operation_id: u64) {
    if let Ok(mut operations) = active_kubectl_operations().lock() {
        operations.remove(&operation_id);
    }
}

fn kill_process(process_id: u32) -> Result<(), String> {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &process_id.to_string(), "/T", "/F"]);
        command
    } else {
        let mut command = Command::new("kill");
        command.args(["-TERM", &process_id.to_string()]);
        command
    };

    let output = command.output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn now_millis() -> u64 {
    system_time_to_millis(SystemTime::now()).unwrap_or_default()
}

fn format_command(program: &OsStr, args: &[OsString]) -> String {
    std::iter::once(program.to_os_string())
        .chain(args.iter().cloned())
        .map(|part| quote_arg(&part))
        .collect::<Vec<_>>()
        .join(" ")
}

fn quote_arg(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    if value.is_empty() {
        return "''".to_string();
    }
    if value.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '/' | '.' | '_' | '-' | ':' | '=')
    }) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn kubectl_args_with_request_timeout(args: Vec<OsString>) -> Vec<OsString> {
    let mut with_timeout = Vec::with_capacity(args.len() + 2);
    with_timeout.push(OsString::from("--request-timeout"));
    with_timeout.push(OsString::from(KUBECTL_REQUEST_TIMEOUT));
    with_timeout.extend(args);
    with_timeout
}

fn kubectl_timeout() -> Duration {
    env::var(KUBECTL_TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_KUBECTL_TIMEOUT)
}

fn run_program(
    program: &OsStr,
    args: &[OsString],
    timeout: Duration,
    operation_id: Option<u64>,
) -> Result<ProcessOutput, String> {
    let program_display = program.to_string_lossy();
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                format!("Nie znaleziono programu `{program_display}` w PATH.")
            } else {
                error.to_string()
            }
        })?;
    if let Some(operation_id) = operation_id {
        register_kubectl_operation(operation_id, child.id());
    }

    let status = match child.wait_timeout(timeout).map_err(|error| {
        if let Some(operation_id) = operation_id {
            unregister_kubectl_operation(operation_id);
        }
        error.to_string()
    })? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(operation_id) = operation_id {
                unregister_kubectl_operation(operation_id);
            }
            return Err(format!(
                "Przekroczono limit czasu ({timeout_seconds}s) dla programu `{program_display}`. \
                 Możesz zwiększyć limit zmienną środowiskową {KUBECTL_TIMEOUT_ENV}.",
                timeout_seconds = timeout.as_secs()
            ));
        }
    };
    if let Some(operation_id) = operation_id {
        unregister_kubectl_operation(operation_id);
    }

    let stdout = read_pipe(child.stdout.take());
    let stderr = read_pipe(child.stderr.take());

    Ok(ProcessOutput {
        success: status.success(),
        code: status.code(),
        stdout,
        stderr,
    })
}

fn read_pipe<R: Read>(pipe: Option<R>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut bytes = Vec::new();
    if pipe.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
}

fn format_process_error(command: &str, output: &ProcessOutput) -> String {
    let details = if !output.stderr.is_empty() {
        output.stderr.clone()
    } else if !output.stdout.is_empty() {
        output.stdout.clone()
    } else {
        "Brak dodatkowych informacji.".to_string()
    };

    match output.code {
        Some(code) => format!("{command} zakończył się kodem {code}: {details}"),
        None => format!("{command} zakończył się błędem: {details}"),
    }
}

fn os_args<const N: usize>(args: [&str; N]) -> Vec<OsString> {
    args.into_iter().map(OsString::from).collect()
}

fn kubectl_program() -> OsString {
    if let Some(path) = find_executable_in_path("kubectl") {
        return path.into_os_string();
    }

    for candidate in common_kubectl_paths() {
        if candidate.is_file() {
            return candidate.into_os_string();
        }
    }

    OsString::from(if cfg!(windows) {
        "kubectl.exe"
    } else {
        "kubectl"
    })
}

fn find_executable_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    let extensions = executable_extensions();

    for directory in env::split_paths(&path_var) {
        for extension in &extensions {
            let candidate = directory.join(format!("{binary}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn executable_extensions() -> Vec<String> {
    if !cfg!(windows) {
        return vec![String::new()];
    }

    let mut extensions = vec![String::new()];
    if let Some(path_ext) = env::var_os("PATHEXT") {
        extensions.extend(
            path_ext
                .to_string_lossy()
                .split(';')
                .filter(|extension| !extension.trim().is_empty())
                .map(|extension| extension.to_ascii_lowercase()),
        );
    } else {
        extensions.push(".exe".to_string());
    }
    extensions
}

fn common_kubectl_paths() -> Vec<PathBuf> {
    if cfg!(windows) {
        return vec![PathBuf::from(r"C:\ProgramData\chocolatey\bin\kubectl.exe")];
    }

    vec![
        PathBuf::from("/opt/homebrew/bin/kubectl"),
        PathBuf::from("/usr/local/bin/kubectl"),
        PathBuf::from("/usr/bin/kubectl"),
    ]
}

fn target_base_args(target: &RemoteTarget) -> Vec<OsString> {
    vec![
        OsString::from("--kubeconfig"),
        OsString::from(&target.kubeconfig),
        OsString::from("-n"),
        OsString::from(&target.namespace),
    ]
}

fn parse_ls_line(line: &str, base_path: &str) -> Option<RemoteFileEntry> {
    if line.trim().is_empty() || line.starts_with("total ") {
        return None;
    }

    let (fields, raw_name) = split_ls_fields(line)?;
    let permissions = fields[0].clone();
    let owner = fields[2].clone();
    let group = fields[3].clone();
    let size = fields[4].parse::<u64>().ok();
    let modified_at = Some(format!("{} {} {}", fields[5], fields[6], fields[7]));

    let (name, symlink_target) = if permissions.starts_with('l') {
        match raw_name.split_once(" -> ") {
            Some((name, target)) => (name.to_string(), Some(target.to_string())),
            None => (raw_name, None),
        }
    } else {
        (raw_name, None)
    };

    if name == "." || name == ".." {
        return None;
    }

    let kind = match permissions.chars().next() {
        Some('d') => EntryKind::Directory,
        Some('-') => EntryKind::File,
        Some('l') => EntryKind::Symlink,
        _ => EntryKind::Unknown,
    };

    Some(RemoteFileEntry {
        path: join_remote_path(base_path, &name),
        name,
        kind,
        size,
        permissions: Some(permissions),
        owner: Some(owner),
        group: Some(group),
        modified_at,
        symlink_target,
        can_read: true,
        error: None,
    })
}

fn split_ls_fields(line: &str) -> Option<(Vec<String>, String)> {
    let bytes = line.as_bytes();
    let mut fields = Vec::with_capacity(8);
    let mut index = 0;

    for _ in 0..8 {
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let start = index;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if start == index {
            return None;
        }
        fields.push(line[start..index].to_string());
    }

    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }

    if index >= bytes.len() {
        return None;
    }

    Some((fields, line[index..].to_string()))
}

fn join_remote_path(base_path: &str, child: &str) -> String {
    if base_path == "/" {
        format!("/{}", child.trim_start_matches('/'))
    } else {
        format!(
            "{}/{}",
            base_path.trim_end_matches('/'),
            child.trim_start_matches('/')
        )
    }
}

fn kind_order(kind: &EntryKind) -> u8 {
    match kind {
        EntryKind::Directory => 0,
        EntryKind::Symlink => 1,
        EntryKind::File => 2,
        EntryKind::Unknown => 3,
    }
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Nie można ustalić katalogu domowego.".to_string())
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn path_id(path: &Path) -> String {
    path_to_string(path)
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn is_kubeconfig_candidate(path: &Path, name: &str) -> bool {
    if name == "config" {
        return true;
    }

    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "yaml" | "yml" | "conf" | "kubeconfig"
            )
        })
        .unwrap_or(false)
}

fn looks_like_kubeconfig(path: &Path) -> bool {
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };
    content.contains("clusters:") && content.contains("contexts:") && content.contains("users:")
}

fn system_time_to_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn remote_file_name(remote_path: &str) -> Option<String> {
    remote_path
        .trim_end_matches('/')
        .rsplit('/')
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_file_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();

    if sanitized.trim().is_empty() {
        "remote-file".to_string()
    } else {
        sanitized
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            check_kubectl,
            cancel_kubectl_operation,
            get_kubectl_logs,
            scan_kubeconfigs,
            get_home_dir,
            list_namespaces,
            list_pods,
            list_containers,
            list_remote_dir,
            list_local_dir,
            join_local_path,
            copy_remote_to_local,
            copy_local_to_remote,
            download_remote_to_temp,
            open_local_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
