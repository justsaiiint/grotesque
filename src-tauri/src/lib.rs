mod acp;
mod grok_adapter;
mod mcp_target;
mod sessions;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::{DownloadEvent, PageLoadEvent, WebviewBuilder};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};
use tauri_plugin_dialog::DialogExt;

/// Default Quit / ⌘Q exits on macOS without ExitRequested.
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("desk-settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("desk-quit", "Quit Grotesque")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let zoom_in = MenuItemBuilder::with_id("desk-zoom-in", "Zoom In")
        .accelerator("CmdOrCtrl+.")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("desk-zoom-out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("desk-zoom-reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Grotesque")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;
    let close = MenuItemBuilder::with_id("desk-close", "Close")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&close)
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &view, &window])
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == "desk-quit" {
            let _ = app.emit("quit-requested", ());
        }
        if event.id() == "desk-close" {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
        }
        if event.id() == "desk-settings" {
            let _ = app.emit("settings-requested", ());
        }
        if event.id() == "desk-zoom-in" {
            let _ = app.emit("zoom-in-requested", ());
        }
        if event.id() == "desk-zoom-out" {
            let _ = app.emit("zoom-out-requested", ());
        }
        if event.id() == "desk-zoom-reset" {
            let _ = app.emit("zoom-reset-requested", ());
        }
    });
    Ok(())
}

struct QuitOk(Arc<AtomicBool>);

#[tauri::command]
fn allow_and_quit(app: tauri::AppHandle, ok: State<QuitOk>, pool: State<acp::AcpLive>) {
    ok.0.store(true, Ordering::SeqCst);
    pool.inner().reset_all();
    app.exit(0);
}

#[tauri::command]
fn pin_traffic_lights() {
    traffic_lights::pin();
}

pub type PermissionGate = acp::PermissionGate;
pub type AcpLive = acp::AcpLive;

#[tauri::command]
async fn run_grok_stream(
    app: tauri::AppHandle,
    gate: State<'_, PermissionGate>,
    pool: State<'_, AcpLive>,
    chat_key: String,
    prompt: String,
    on_event: Channel<grok_adapter::StreamEvent>,
    model: Option<String>,
    effort: Option<String>,
    cwd: Option<String>,
    mode: Option<String>,
    session_id: Option<String>,
    force_new: Option<bool>,
    attachments: Option<Vec<acp::AttachIn>>,
) -> Result<grok_adapter::GrokRunResult, String> {
    let gate = gate.inner().clone();
    let pool = pool.inner().clone();
    let force_new = force_new.unwrap_or(false);
    let attachments = attachments.unwrap_or_default();

    let result = tauri::async_runtime::spawn_blocking(move || {
        acp::run_prompt(
            &app,
            &gate,
            &pool,
            &on_event,
            &chat_key,
            &prompt,
            &attachments,
            cwd.as_deref(),
            mode.as_deref(),
            model.as_deref(),
            effort.as_deref(),
            session_id.as_deref(),
            force_new,
        )
    })
    .await
    .map_err(|e| format!("Grok task failed: {e}"))?;
    Ok(result)
}

#[tauri::command]
fn respond_card(
    gate: State<'_, PermissionGate>,
    chat_key: String,
    id: u64,
    payload: String,
) -> Result<(), String> {
    let key = format!("{chat_key}:{id}");
    let mut map = gate
        .lock()
        .map_err(|_| "permission gate lock poisoned".to_string())?;
    if let Some(tx) = map.remove(&key) {
        let _ = tx.send(payload);
        Ok(())
    } else {
        Err("No pending card with that id.".into())
    }
}

#[tauri::command]
fn set_run_mode(
    pool: State<'_, AcpLive>,
    chat_key: String,
    mode: String,
) -> Result<(), String> {
    acp::set_desk_mode(pool.inner(), &chat_key, &mode)
}

#[tauri::command]
fn reset_session(pool: State<'_, AcpLive>, chat_key: Option<String>) -> Result<(), String> {
    match chat_key {
        Some(k) if !k.is_empty() => pool.inner().reset_chat(&k),
        _ => pool.inner().reset_all(),
    }
    Ok(())
}

#[tauri::command]
fn stop_turn(pool: State<'_, AcpLive>, chat_key: String) -> Result<(), String> {
    acp::stop_turn(pool.inner(), &chat_key)
}

#[tauri::command]
async fn list_project_sessions(cwd: String) -> Result<Vec<sessions::SessionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::list_sessions(&cwd))
        .await
        .map_err(|e| format!("List sessions failed: {e}"))?
}

#[tauri::command]
fn recents_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set.".to_string())?;
    let dir = PathBuf::from(home).join(".grotesque").join("recents");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create Recents folder: {e}"))?;
    dir.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Invalid Recents path.".to_string())
}

#[tauri::command]
async fn load_session_history(
    cwd: String,
    session_id: String,
) -> Result<Vec<sessions::HistoryMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::load_history(&cwd, &session_id))
        .await
        .map_err(|e| format!("Load history failed: {e}"))?
}

#[tauri::command]
async fn load_subagent_history(
    cwd: String,
    parent_id: String,
    sub_id: String,
    label: Option<String>,
) -> Result<Vec<sessions::HistoryMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        sessions::load_subagent_history(&cwd, &parent_id, &sub_id, label)
    })
    .await
    .map_err(|e| format!("Load history failed: {e}"))?
}

#[tauri::command]
async fn list_subagents(
    cwd: String,
    parent_id: String,
) -> Result<Vec<sessions::SubagentInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::list_subagents(&cwd, &parent_id))
        .await
        .map_err(|e| format!("Load subagents failed: {e}"))?
}

#[tauri::command]
async fn build_session_search_index(cwds: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sessions::build_search_index(&cwds))
        .await
        .map_err(|e| format!("Search index failed: {e}"))?
}

#[tauri::command]
async fn search_session_texts(
    cwds: Vec<String>,
    query: String,
) -> Result<Vec<sessions::SessionSearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || sessions::search_index_hits(&cwds, &query))
        .await
        .map_err(|e| format!("Search failed: {e}"))
}

#[tauri::command]
fn load_session_usage(cwd: String, session_id: String) -> Result<sessions::SessionUsage, String> {
    sessions::load_usage(&cwd, &session_id)
}

#[tauri::command]
async fn load_usage_stats() -> Result<sessions::UsageStats, String> {
    tauri::async_runtime::spawn_blocking(sessions::load_usage_stats)
        .await
        .map_err(|_| "Could not load use stats.".to_string())?
}

#[tauri::command]
fn load_recent_prompts(cwd: String) -> Result<Vec<String>, String> {
    sessions::load_recent_prompts(&cwd, 20)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathHit {
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn list_path_hits(cwd: String, prefix: String) -> Result<Vec<PathHit>, String> {
    path_hits(&cwd, &prefix)
}

#[derive(Serialize)]
struct ProjectPathHit {
    raw: String,
    path: String,
}

/// Tokens that resolve to a real file or folder inside the project.
#[tauri::command]
fn project_paths_exist(cwd: String, paths: Vec<String>) -> Vec<ProjectPathHit> {
    let Ok(root) = PathBuf::from(cwd.trim()).canonicalize() else {
        return vec![];
    };
    if !root.is_dir() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    // Cap one paint.
    for raw in paths.into_iter().take(64) {
        let key = raw.trim().to_string();
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        if let Some(path) = resolve_project_path(&root, &key) {
            out.push(ProjectPathHit {
                raw: key,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    out
}

fn resolve_project_path(root: &Path, raw: &str) -> Option<PathBuf> {
    let mut raw = raw.trim().to_string();
    if let Some(rest) = raw.strip_prefix("file://") {
        raw = rest.to_string();
    }
    raw = raw.replace('\\', "/");
    if raw.is_empty() || raw == "/" || raw == "." || raw == "./" || raw == ".." {
        return None;
    }
    let expanded = expand_home_path(&raw).ok()?;
    let under_root = |p: PathBuf| -> Option<PathBuf> {
        let canon = p.canonicalize().ok()?;
        if canon.starts_with(root) {
            Some(canon)
        } else {
            None
        }
    };
    if expanded.is_absolute() {
        if let Some(hit) = under_root(expanded) {
            return Some(hit);
        }
        // `/src/foo` in chat is the file in the project, not the disk root.
        if raw.starts_with('/') && !raw.starts_with("//") && !raw.starts_with("~/") {
            let rel = raw.trim_start_matches('/');
            if !rel.is_empty() {
                return under_root(root.join(rel));
            }
        }
        return None;
    }
    let rel = raw.strip_prefix("./").unwrap_or(raw.as_str());
    under_root(root.join(rel))
}

#[tauri::command]
fn list_skill_commands(cwd: String) -> Result<Vec<grok_adapter::SkillSlash>, String> {
    Ok(grok_adapter::list_skill_commands(&cwd))
}

#[tauri::command]
async fn load_plugins_snapshot(cwd: String) -> Result<grok_adapter::PluginsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || grok_adapter::load_plugins_snapshot(&cwd))
        .await
        .map_err(|_| "Could not load plugins.".to_string())?
}

#[tauri::command]
async fn set_mcp_enabled(name: String, enabled: bool, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        grok_adapter::set_mcp_enabled(&name, enabled, &cwd)
    })
    .await
    .map_err(|_| "Could not update MCP.".to_string())?
}

#[tauri::command]
async fn remove_mcp_server(name: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || grok_adapter::remove_mcp_server(&name, &cwd))
        .await
        .map_err(|_| "Could not remove MCP.".to_string())?
}

#[tauri::command]
async fn add_mcp_url(name: String, url: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || grok_adapter::add_mcp_url(&name, &url, &cwd))
        .await
        .map_err(|_| "Could not add MCP.".to_string())?
}

#[tauri::command]
async fn list_marketplace_plugins(
    cwd: String,
) -> Result<Vec<grok_adapter::MarketPlugin>, String> {
    tauri::async_runtime::spawn_blocking(move || grok_adapter::list_marketplace_plugins(&cwd))
        .await
        .map_err(|_| "Could not load marketplace.".to_string())?
}

#[tauri::command]
async fn install_marketplace_plugin(source: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        grok_adapter::install_marketplace_plugin(&source, &cwd)
    })
    .await
    .map_err(|_| "Could not install plugin.".to_string())?
}

#[tauri::command]
async fn sign_in_mcp(name: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || acp::sign_in_mcp(&name, &cwd))
        .await
        .map_err(|_| "Could not start sign-in.".to_string())?
}

#[tauri::command]
async fn sign_out_mcp(name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || grok_adapter::sign_out_mcp(&name))
        .await
        .map_err(|_| "Could not sign out.".to_string())?
}

#[tauri::command]
async fn set_skill_enabled(name: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || grok_adapter::set_skill_enabled(&name, enabled))
        .await
        .map_err(|_| "Could not update skill.".to_string())?
}

fn path_hits(cwd: &str, prefix: &str) -> Result<Vec<PathHit>, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let root_canon = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };
    let prefix = prefix.replace('\\', "/");
    if prefix.split('/').any(|p| p == "..") {
        return Ok(vec![]);
    }
    let (parent_rel, name_pre) = match prefix.rfind('/') {
        Some(i) => (&prefix[..=i], &prefix[i + 1..]),
        None => ("", prefix.as_str()),
    };
    let pre = name_pre.to_ascii_lowercase();
    let mut hits = Vec::new();
    if parent_rel.is_empty() && !pre.is_empty() {
        // Cap dirents so @ on a large tree stays fast. Files first (open a match).
        let mut budget = 2_000u32;
        walk_path_hits(&root_canon, &root_canon, "", &pre, &mut hits, &mut budget);
        hits.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (false, true) => std::cmp::Ordering::Less,
            (true, false) => std::cmp::Ordering::Greater,
            _ => a.path.to_ascii_lowercase().cmp(&b.path.to_ascii_lowercase()),
        });
        hits.truncate(40);
        return Ok(hits);
    }
    let parent = if parent_rel.is_empty() {
        root_canon.clone()
    } else {
        root_canon.join(parent_rel.trim_end_matches('/'))
    };
    let parent_canon = match parent.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(vec![]),
    };
    if !parent_canon.starts_with(&root_canon) {
        return Ok(vec![]);
    }
    collect_dir_hits(&parent_canon, parent_rel, &pre, &mut hits);
    hits.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.path.to_ascii_lowercase().cmp(&b.path.to_ascii_lowercase()),
    });
    hits.truncate(40);
    Ok(hits)
}

fn skip_path_name(name: &str, pre: &str) -> bool {
    if name == "." || name == ".." {
        return true;
    }
    if name.starts_with('.') && !pre.starts_with('.') {
        return true;
    }
    matches!(name, "node_modules" | "target" | "dist" | ".git")
}

fn collect_dir_hits(dir: &std::path::Path, parent_rel: &str, pre: &str, hits: &mut Vec<PathHit>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if skip_path_name(&name, pre) {
            continue;
        }
        if !pre.is_empty() && !name.to_ascii_lowercase().starts_with(pre) {
            continue;
        }
        let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let rel = format!("{parent_rel}{name}");
        hits.push(PathHit {
            path: if is_dir { format!("{rel}/") } else { rel },
            is_dir,
        });
    }
}

fn walk_path_hits(
    root: &std::path::Path,
    dir: &std::path::Path,
    rel: &str,
    pre: &str,
    hits: &mut Vec<PathHit>,
    budget: &mut u32,
) {
    if *budget == 0 || hits.len() >= 40 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut ents: Vec<_> = rd.flatten().collect();
    ents.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for ent in ents {
        if *budget == 0 || hits.len() >= 40 {
            return;
        }
        *budget = budget.saturating_sub(1);
        let name = ent.file_name().to_string_lossy().to_string();
        if skip_path_name(&name, pre) {
            continue;
        }
        let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        if name.to_ascii_lowercase().starts_with(pre) {
            hits.push(PathHit {
                path: if is_dir {
                    format!("{child_rel}/")
                } else {
                    child_rel.clone()
                },
                is_dir,
            });
        }
        if is_dir {
            let Ok(next) = ent.path().canonicalize() else {
                continue;
            };
            if !next.starts_with(root) {
                continue;
            }
            walk_path_hits(root, &next, &child_rel, pre, hits, budget);
        }
    }
}

#[tauri::command]
async fn check_grok() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(grok_adapter::ensure_grok_ready)
        .await
        .map_err(|e| format!("Grok check failed: {e}"))
        .and_then(|r| r.map(|_| ()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AboutInfo {
    grotesque: String,
    cli: Option<String>,
}

#[tauri::command]
async fn about_info(app: tauri::AppHandle) -> AboutInfo {
    let grotesque = app.package_info().version.to_string();
    let cli = tauri::async_runtime::spawn_blocking(grok_adapter::cli_version)
        .await
        .ok()
        .flatten();
    AboutInfo { grotesque, cli }
}

#[tauri::command]
async fn check_cli_update() -> Option<grok_adapter::CliUpdate> {
    tauri::async_runtime::spawn_blocking(grok_adapter::check_cli_update)
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn install_cli_update() -> Result<grok_adapter::CliUpdate, String> {
    tauri::async_runtime::spawn_blocking(grok_adapter::install_cli_update)
        .await
        .map_err(|_| "Could not update Grok CLI.".to_string())?
}

#[tauri::command]
fn list_models() -> Result<Vec<grok_adapter::ModelInfo>, String> {
    Ok(grok_adapter::list_models())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachInfo {
    path: String,
    name: String,
    size: u64,
    mime: String,
    is_dir: bool,
    is_image: bool,
}

fn guess_attach_mime(name: &str) -> (String, bool) {
    let ext = name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => ("image/png".into(), true),
        "jpg" | "jpeg" => ("image/jpeg".into(), true),
        "gif" => ("image/gif".into(), true),
        "webp" => ("image/webp".into(), true),
        "bmp" => ("image/bmp".into(), true),
        "pdf" => ("application/pdf".into(), false),
        "txt" | "md" => ("text/plain".into(), false),
        "json" => ("application/json".into(), false),
        "csv" => ("text/csv".into(), false),
        "svg" => ("image/svg+xml".into(), false),
        _ => ("application/octet-stream".into(), false),
    }
}

#[tauri::command]
fn inspect_attach_paths(paths: Vec<String>) -> Result<Vec<AttachInfo>, String> {
    let mut out = Vec::new();
    for raw in paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let p = PathBuf::from(trimmed);
        if !p.exists() {
            continue;
        }
        let is_dir = p.is_dir();
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| trimmed.to_string());
        let size = if is_dir {
            0
        } else {
            p.metadata().map(|m| m.len()).unwrap_or(0)
        };
        let (mime, is_image) = guess_attach_mime(&name);
        let path = p
            .to_str()
            .ok_or_else(|| format!("Invalid path: {trimmed}"))?
            .to_string();
        out.push(AttachInfo {
            path,
            name,
            size,
            mime,
            is_dir,
            is_image,
        });
    }
    Ok(out)
}

pub(crate) fn strip_b64(raw: &str) -> &str {
    if let Some(i) = raw.find("base64,") {
        &raw[i + 7..]
    } else {
        raw.trim()
    }
}

pub(crate) fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i];
        let b1 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] } else { 0 };
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if i + 1 < data.len() {
            out.push(T[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(T[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("Invalid attachment data.".into()),
        }
    }
    let s: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if s.len() % 4 != 0 {
        return Err("Invalid attachment data.".into());
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for chunk in s.chunks_exact(4) {
        let n = chunk.iter().filter(|&&c| c == b'=').count();
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        let c = if chunk[2] == b'=' { 0 } else { val(chunk[2])? };
        let d = if chunk[3] == b'=' { 0 } else { val(chunk[3])? };
        let triple = (u32::from(a) << 18) | (u32::from(b) << 12) | (u32::from(c) << 6) | u32::from(d);
        out.push((triple >> 16) as u8);
        if n < 2 {
            out.push((triple >> 8) as u8);
        }
        if n < 1 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

fn safe_attach_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("paste")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    if base.is_empty() || base == "." || base == ".." {
        "paste.bin".into()
    } else {
        base
    }
}

/// Write pasted bytes to a temp file so the agent has a path.
#[tauri::command]
fn save_temp_attach(name: String, data: String) -> Result<String, String> {
    let bytes = b64_decode(strip_b64(&data))?;
    if bytes.is_empty() || bytes.len() as u64 > 12 * 1024 * 1024 {
        return Err("Attachment empty or too large (12 MB max).".into());
    }
    let safe = safe_attach_name(&name);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("grok-desk-attach-{stamp}-{safe}"));
    std::fs::write(&path, &bytes).map_err(|e| format!("Cannot save attachment: {e}"))?;
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Invalid temp path.".into())
}

fn expand_home_path(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Path is empty.".into());
    }
    let expanded = if raw == "~" {
        std::env::var("HOME").map_err(|_| "HOME is not set.".to_string())?
    } else if let Some(rest) = raw.strip_prefix("~/") {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set.".to_string())?;
        format!("{home}/{rest}")
    } else {
        raw.to_string()
    };
    Ok(PathBuf::from(expanded))
}

fn is_obsidian_vault_dir(dir: &std::path::Path) -> bool {
    dir.is_dir() && dir.join(".obsidian").is_dir()
}

fn obsidian_app_exists() -> bool {
    if PathBuf::from("/Applications/Obsidian.app").is_dir() {
        return true;
    }
    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join("Applications/Obsidian.app").is_dir())
        .unwrap_or(false)
}

pub(crate) fn percent_encode_path(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub(crate) fn file_uri(path: &str) -> String {
    if path.starts_with('/') {
        format!("file://{}", percent_encode_path(path))
    } else {
        format!("file:///{}", percent_encode_path(path))
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillFileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<SkillFileNode>,
}

fn skill_folder_for(path: &Path) -> Option<PathBuf> {
    if path.is_file()
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
    {
        return path.parent().map(|p| p.to_path_buf());
    }
    let mut dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    for _ in 0..8 {
        if dir.join("SKILL.md").is_file() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

fn walk_skill_dir(dir: &Path, depth: usize, left: &mut usize) -> Vec<SkillFileNode> {
    if depth == 0 || *left == 0 {
        return vec![];
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut ents: Vec<(String, PathBuf, bool)> = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name == "node_modules"
            || name.eq_ignore_ascii_case("SKILL.md")
        {
            continue;
        }
        let p = ent.path();
        let is_dir = p.is_dir();
        ents.push((name, p, is_dir));
    }
    ents.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    let mut out = Vec::new();
    for (name, p, is_dir) in ents {
        if *left == 0 {
            break;
        }
        *left -= 1;
        let children = if is_dir {
            walk_skill_dir(&p, depth - 1, left)
        } else {
            vec![]
        };
        let Some(path) = p.to_str().map(str::to_string) else {
            continue;
        };
        out.push(SkillFileNode {
            name,
            path,
            is_dir,
            children,
        });
    }
    out
}

/// Extra files in a skill folder.
#[tauri::command]
fn list_skill_files(path: String) -> Result<Vec<SkillFileNode>, String> {
    let p = expand_home_path(&path)?;
    let folder = skill_folder_for(&p).ok_or_else(|| "Skill folder is not on disk.".to_string())?;
    let mut left = 80usize;
    Ok(walk_skill_dir(&folder, 6, &mut left))
}

/// Open a skill file in TextEdit.
#[tauri::command]
fn open_in_textedit(path: String) -> Result<(), String> {
    let p = expand_home_path(&path)?;
    if !p.is_file() {
        return Err("File is not on disk.".into());
    }
    if skill_folder_for(&p).is_none() {
        return Err("That file is not in a skill folder.".into());
    }
    let status = std::process::Command::new("open")
        .args(["-a", "TextEdit", "--"])
        .arg(&p)
        .status()
        .map_err(|e| format!("Cannot open TextEdit: {e}"))?;
    if !status.success() {
        return Err("Cannot open TextEdit.".into());
    }
    Ok(())
}

/// Create `grotesque.log` if needed, then open it.
#[tauri::command]
fn open_app_log(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|_| "Cannot find the log folder.".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|_| "Cannot create the log folder.".to_string())?;
    let path = dir.join("grotesque.log");
    if !path.is_file() {
        let ver = app.package_info().version.to_string();
        std::fs::write(&path, format!("Grotesque {ver}\n"))
            .map_err(|_| "Cannot create the log.".to_string())?;
    }
    let status = std::process::Command::new("open")
        .arg(&path)
        .status()
        .map_err(|e| format!("Cannot open log: {e}"))?;
    if !status.success() {
        return Err("Cannot open log.".into());
    }
    Ok(())
}

/// Open an http(s) address in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let t = url.trim();
    if !(t.starts_with("https://") || t.starts_with("http://")) {
        return Err("Not a web address.".into());
    }
    std::process::Command::new("open")
        .arg(t)
        .status()
        .map_err(|e| format!("Cannot open link: {e}"))?;
    Ok(())
}

/// Open a file or folder with the default app (browser for HTML).
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = expand_home_path(&path)?;
    if !p.exists() {
        return Err("Path is not on disk.".into());
    }
    std::process::Command::new("open")
        .arg(&p)
        .status()
        .map_err(|e| format!("Cannot open: {e}"))?;
    Ok(())
}

/// Open a file in Preview or the Mac default browser.
#[tauri::command]
fn open_path_with(path: String, app: String) -> Result<(), String> {
    let app = app.trim();
    let p = expand_home_path(&path)?;
    if !p.exists() {
        return Err("Path is not on disk.".into());
    }
    match app {
        "Preview" => {
            let bundle = mac_app_bundle("Preview")
                .unwrap_or_else(|| PathBuf::from("/System/Applications/Preview.app"));
            open_with_app(&bundle, &p, "Preview")
        }
        "browser" => {
            let (_, bundle) =
                default_browser_app().ok_or_else(|| "No default browser.".to_string())?;
            open_with_app(&bundle, &p, "Browser")
        }
        _ => Err("Unknown app.".into()),
    }
}

fn open_with_app(app: &Path, file: &Path, label: &str) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(["-a"])
        .arg(app)
        .arg("--")
        .arg(file)
        .status()
        .map_err(|e| format!("Cannot open {label}: {e}"))?;
    if !status.success() {
        return Err(format!("{label} is not installed."));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn default_browser_app() -> Option<(String, PathBuf)> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSString, NSURL};
    let ws = NSWorkspace::sharedWorkspace();
    let https = NSURL::URLWithString(&NSString::from_str("https://example.com"))?;
    let app_url = ws.URLForApplicationToOpenURL(&https)?;
    let path = PathBuf::from(app_url.path()?.to_string());
    if !path.exists() {
        return None;
    }
    let bundle = NSBundle::bundleWithURL(&app_url)?;
    let name = ["CFBundleDisplayName", "CFBundleName"]
        .into_iter()
        .find_map(|key| {
            let v = bundle.objectForInfoDictionaryKey(&NSString::from_str(key))?;
            let s = v.downcast::<NSString>().ok()?;
            let t = s.to_string();
            (!t.is_empty()).then_some(t)
        })?;
    Some((name, path))
}

#[cfg(not(target_os = "macos"))]
fn default_browser_app() -> Option<(String, PathBuf)> {
    None
}

/// Copy a file to a path the operator picked.
#[tauri::command]
fn copy_path(from: String, to: String) -> Result<(), String> {
    let src = expand_home_path(&from)?;
    let dest = expand_home_path(&to)?;
    if !src.is_file() {
        return Err("File is not on disk.".into());
    }
    if src == dest {
        return Ok(());
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("Cannot save a copy: {e}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MacAppIcons {
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    downloads: Option<String>,
}

#[cfg(target_os = "macos")]
fn mac_app_bundle(name: &str) -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSString;
    let ws = NSWorkspace::sharedWorkspace();
    #[allow(deprecated)]
    let found = ws.fullPathForApplication(&NSString::from_str(name));
    if let Some(p) = found {
        let path = PathBuf::from(p.to_string());
        if path.exists() {
            return Some(path);
        }
    }
    let cands: &[&str] = match name {
        "Preview" => &[
            "/System/Applications/Preview.app",
            "/Applications/Preview.app",
        ],
        "Finder" => &["/System/Library/CoreServices/Finder.app"],
        _ => &[],
    };
    cands
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

#[cfg(target_os = "macos")]
fn write_mac_file_icon(src: &Path, dest: &Path) -> Option<String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSSize, NSString};
    if dest.is_file() {
        return dest.to_str().map(str::to_string);
    }
    if !src.exists() {
        return None;
    }
    let ws = NSWorkspace::sharedWorkspace();
    let icon = ws.iconForFile(&NSString::from_str(src.to_str()?));
    icon.setSize(NSSize {
        width: 64.0,
        height: 64.0,
    });
    let tiff = icon.TIFFRepresentation()?;
    std::fs::create_dir_all(dest.parent()?).ok()?;
    std::fs::write(dest, tiff.to_vec()).ok()?;
    dest.is_file()
        .then(|| dest.to_str().map(str::to_string))
        .flatten()
}

/// 16px macOS icons for Preview, the default browser, Finder, and Downloads.
#[tauri::command]
fn mac_app_icons() -> MacAppIcons {
    #[cfg(not(target_os = "macos"))]
    {
        return MacAppIcons {
            preview: None,
            browser: None,
            browser_name: None,
            finder: None,
            downloads: None,
        };
    }
    #[cfg(target_os = "macos")]
    {
        let dir = std::env::temp_dir().join("grotesque-app-icons");
        let icon = |name: &str, file: &str| {
            let src = mac_app_bundle(name)?;
            write_mac_file_icon(&src, &dir.join(file))
        };
        let downloads = std::env::var("HOME").ok().and_then(|home| {
            let folder = PathBuf::from(home).join("Downloads");
            write_mac_file_icon(&folder, &dir.join("downloads.tiff"))
        });
        let (browser_name, browser) = default_browser_app()
            .map(|(name, path)| {
                (
                    Some(name),
                    write_mac_file_icon(&path, &dir.join("browser.tiff")),
                )
            })
            .unwrap_or((None, None));
        MacAppIcons {
            preview: icon("Preview", "preview.tiff"),
            browser,
            browser_name,
            finder: icon("Finder", "finder.tiff"),
            downloads,
        }
    }
}

/// Read one file in a project folder. Name is a single basename.
#[tauri::command]
fn read_project_text(cwd: String, name: String) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.contains('/') || n.contains('\\') || n.contains("..") {
        return Err("Bad file name.".into());
    }
    let root = PathBuf::from(cwd.trim())
        .canonicalize()
        .map_err(|_| "Folder is not on disk.".to_string())?;
    let path = root.join(n);
    let canon = path
        .canonicalize()
        .map_err(|_| "File is not on disk.".to_string())?;
    if !canon.starts_with(&root) {
        return Err("File is outside the project.".into());
    }
    let mut body =
        std::fs::read_to_string(&canon).map_err(|e| format!("Cannot read file: {e}"))?;
    const MAX: usize = 80_000;
    if body.len() > MAX {
        body.truncate(MAX);
        body.push('…');
    }
    Ok(body)
}

/// Reveal a file or open a folder in Finder.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = expand_home_path(&path)?;
    if !p.exists() {
        return Err("Path is not on disk.".into());
    }
    let mut cmd = std::process::Command::new("open");
    if p.is_dir() {
        cmd.arg(&p);
    } else {
        cmd.arg("-R").arg(&p);
    }
    cmd.status()
        .map_err(|e| format!("Cannot open Finder: {e}"))?;
    Ok(())
}

/// Paths from the list that contain an `.obsidian` folder.
#[tauri::command]
fn list_obsidian_vaults(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            expand_home_path(p)
                .map(|dir| is_obsidian_vault_dir(&dir))
                .unwrap_or(false)
        })
        .collect()
}

/// Open a project folder as an Obsidian vault.
#[tauri::command]
fn open_in_obsidian(path: String) -> Result<(), String> {
    let p = expand_home_path(&path)?;
    if !is_obsidian_vault_dir(&p) {
        return Err("Not an Obsidian vault.".into());
    }
    if !obsidian_app_exists() {
        return Err("Obsidian is not installed.".into());
    }
    let uri = format!("obsidian://open?path={}", percent_encode_path(&p.to_string_lossy()));
    std::process::Command::new("open")
        .arg(&uri)
        .status()
        .map_err(|e| format!("Cannot open Obsidian: {e}"))?;
    Ok(())
}

/// Download a remote image/video/audio file to a temp path the webview can show.
#[tauri::command]
async fn fetch_remote_media(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_remote_media_to_temp(&url))
        .await
        .map_err(|e| format!("Media fetch task failed: {e}"))?
}

fn fetch_remote_media_to_temp(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.len() > 2048 {
        return Err("URL too long.".into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) URLs.".into());
    }
    if url.contains(['\n', '\r', '\0']) {
        return Err("Invalid URL.".into());
    }

    let output = std::process::Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "25",
            "--max-filesize",
            "12000000",
            "--max-redirs",
            "5",
            "--proto",
            "=http,https",
            "--proto-redir",
            "=http,https",
            "-A",
            "Grotesque",
            "-H",
            "Accept: image/avif,image/webp,image/*,video/*,audio/*,*/*;q=0.8",
            url,
        ])
        .output()
        .map_err(|e| format!("Cannot fetch media: {e}"))?;

    if !output.status.success() {
        return Err("Could not fetch media.".into());
    }
    if output.stdout.is_empty() || output.stdout.len() > 12 * 1024 * 1024 {
        return Err("Media empty or too large.".into());
    }

    let ext = sniff_media_ext(url, &output.stdout);
    let name = format!("grok-desk-media-{:x}.{ext}", fnv1a(url.as_bytes()));
    let path = std::env::temp_dir().join(name);
    std::fs::write(&path, &output.stdout).map_err(|e| format!("Cannot save media: {e}"))?;
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| "Invalid temp path.".into())
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn sniff_media_ext(url: &str, bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return "png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "jpg";
    }
    if bytes.starts_with(b"GIF8") {
        return "gif";
    }
    if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        return "mp4";
    }
    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    for ext in ["png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mov", "mp3", "wav", "m4a"] {
        if path.ends_with(&format!(".{ext}")) {
            return if ext == "jpeg" { "jpg" } else { ext };
        }
    }
    "bin"
}

/// Re-apply light inset after AppKit tiles the titlebar. Wry
/// `trafficLightPosition` writes X only. A live resize handler flickers;
/// `drawRect` plus a frame observer do not.
#[cfg(target_os = "macos")]
mod traffic_lights {
    use std::ptr;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, define_class, msg_send, sel, MainThreadOnly};
    use objc2_app_kit::NSView;
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect};

    const BAR_H: f64 = 52.0;
    const LIGHT_X: f64 = 20.0;
    const LIGHT_STEP: f64 = 20.0;

    static PAD: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());
    static CONTAINER: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());
    static APPLYING: AtomicBool = AtomicBool::new(false);

    pub struct PadIvars;

    define_class!(
        #[unsafe(super(NSView))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PadIvars]
        pub struct TrafficPad;

        impl TrafficPad {
            #[unsafe(method(drawRect:))]
            fn draw_rect(&self, _dirty: NSRect) {
                unsafe { apply_from_view(self) };
            }

            #[unsafe(method(onChrome:))]
            fn on_chrome(&self, _n: *mut AnyObject) {
                unsafe { apply_from_view(self) };
            }

            #[unsafe(method(pinSoon))]
            fn pin_soon(&self) {
                unsafe {
                    apply_from_view(self);
                    schedule(self as *const TrafficPad as *mut AnyObject, 0.0);
                    schedule(self as *const TrafficPad as *mut AnyObject, 0.05);
                    schedule(self as *const TrafficPad as *mut AnyObject, 0.25);
                };
            }

            #[unsafe(method(hitTest:))]
            fn hit_test(&self, _p: NSPoint) -> *mut AnyObject {
                // Pad must not steal clicks from the webview.
                std::ptr::null_mut()
            }
        }
    );

    struct ApplyGuard;

    impl Drop for ApplyGuard {
        fn drop(&mut self) {
            APPLYING.store(false, Ordering::SeqCst);
        }
    }

    unsafe fn apply_from_view(view: &TrafficPad) {
        let window: *mut AnyObject = msg_send![view, window];
        if window.is_null() {
            return;
        }
        apply(window);
    }

    unsafe fn ns_name(name: &std::ffi::CStr) -> *mut AnyObject {
        msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()]
    }

    unsafe fn observe(pad: *mut AnyObject, name: &std::ffi::CStr, object: *mut AnyObject) {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        let n = ns_name(name);
        let _: () = msg_send![
            center,
            addObserver: pad,
            selector: sel!(onChrome:),
            name: n,
            object: object
        ];
    }

    unsafe fn unobserve(pad: *mut AnyObject, name: &std::ffi::CStr, object: *mut AnyObject) {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        let n = ns_name(name);
        let _: () = msg_send![center, removeObserver: pad, name: n, object: object];
    }

    unsafe fn watch_container(container: *mut AnyObject) {
        let pad = PAD.load(Ordering::SeqCst);
        if pad.is_null() || container.is_null() {
            return;
        }
        let prev = CONTAINER.swap(container, Ordering::SeqCst);
        if prev == container {
            return;
        }
        if !prev.is_null() {
            unobserve(pad, c"NSViewFrameDidChangeNotification", prev);
        }
        let _: () = msg_send![container, setPostsFrameChangedNotifications: true];
        observe(pad, c"NSViewFrameDidChangeNotification", container);
    }

    unsafe fn schedule(pad: *mut AnyObject, delay: f64) {
        if pad.is_null() {
            return;
        }
        let none: *mut AnyObject = ptr::null_mut();
        let _: () = msg_send![
            pad,
            performSelector: sel!(onChrome:),
            withObject: none,
            afterDelay: delay
        ];
    }

    pub unsafe fn apply(window: *mut AnyObject) {
        if APPLYING.swap(true, Ordering::SeqCst) {
            return;
        }
        let _guard = ApplyGuard;
        let close: *mut AnyObject = msg_send![window, standardWindowButton: 0usize];
        let mini: *mut AnyObject = msg_send![window, standardWindowButton: 1usize];
        let zoom: *mut AnyObject = msg_send![window, standardWindowButton: 2usize];
        if close.is_null() || mini.is_null() {
            return;
        }
        let btn_super: *mut AnyObject = msg_send![close, superview];
        if btn_super.is_null() {
            return;
        }
        let container: *mut AnyObject = msg_send![btn_super, superview];
        if container.is_null() {
            return;
        }
        let parent: *mut AnyObject = msg_send![container, superview];
        if parent.is_null() {
            return;
        }
        watch_container(container);

        let parent_bounds: NSRect = msg_send![parent, bounds];
        let target_y = parent_bounds.size.height - BAR_H;
        let mut bar: NSRect = msg_send![container, frame];
        if (bar.size.height - BAR_H).abs() > 0.5 || (bar.origin.y - target_y).abs() > 0.5 {
            bar.size.height = BAR_H;
            bar.origin.y = target_y;
            let _: () = msg_send![container, setFrame: bar];
        }

        let mut inner: NSRect = msg_send![btn_super, frame];
        if (inner.size.height - BAR_H).abs() > 0.5 || inner.origin.y.abs() > 0.5 {
            inner.size.height = BAR_H;
            inner.origin.y = 0.0;
            let _: () = msg_send![btn_super, setFrame: inner];
        }

        let close_frame: NSRect = msg_send![close, frame];
        let mini_frame: NSRect = msg_send![mini, frame];
        let gap = mini_frame.origin.x - close_frame.origin.x;
        let step = if gap > 0.5 { gap } else { LIGHT_STEP };
        let origin_y = ((BAR_H - close_frame.size.height) / 2.0).round().max(0.0);
        for (i, btn) in [close, mini, zoom].into_iter().enumerate() {
            if btn.is_null() {
                continue;
            }
            let mut frame: NSRect = msg_send![btn, frame];
            let x = LIGHT_X + (i as f64 * step);
            if (frame.origin.x - x).abs() <= 0.5 && (frame.origin.y - origin_y).abs() <= 0.5 {
                continue;
            }
            frame.origin.x = x;
            frame.origin.y = origin_y;
            let _: () = msg_send![btn, setFrame: frame];
        }
    }

    /// After restore and `setTitle`, AppKit tiles the default bar.
    pub fn pin() {
        let pad = PAD.load(Ordering::SeqCst);
        if pad.is_null() {
            return;
        }
        let none: *mut AnyObject = ptr::null_mut();
        unsafe {
            let _: () = msg_send![
                pad,
                performSelectorOnMainThread: sel!(pinSoon),
                withObject: none,
                waitUntilDone: false
            ];
        }
    }

    pub fn install(win: &tauri::WebviewWindow) {
        let Ok(ptr) = win.ns_window() else {
            return;
        };
        let window = ptr as *mut AnyObject;
        if window.is_null() {
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        unsafe {
            apply(window);
            let pad = TrafficPad::alloc(mtm).set_ivars(PadIvars);
            let pad: Retained<TrafficPad> = msg_send![super(pad), init];
            let content: *mut AnyObject = msg_send![window, contentView];
            if content.is_null() {
                return;
            }
            let bounds: NSRect = msg_send![content, bounds];
            let _: () = msg_send![&*pad, setFrame: bounds];
            let _: () = msg_send![&*pad, setAutoresizingMask: 18usize]; // width+height follow content
            let _: () = msg_send![content, addSubview: &*pad];
            let pad_ptr = Retained::as_ptr(&pad) as *mut TrafficPad as *mut AnyObject;
            PAD.store(pad_ptr, Ordering::SeqCst);
            observe(pad_ptr, c"NSWindowDidMoveNotification", window);
            observe(pad_ptr, c"NSWindowDidBecomeKeyNotification", window);
            observe(
                pad_ptr,
                c"NSWindowDidChangeBackingPropertiesNotification",
                window,
            );
            apply(window);
            let none: *mut AnyObject = ptr::null_mut();
            let _: () = msg_send![
                pad_ptr,
                performSelector: sel!(pinSoon),
                withObject: none,
                afterDelay: 0.0
            ];
            std::mem::forget(pad); // keep for the window life
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod traffic_lights {
    pub fn install(_win: &tauri::WebviewWindow) {}
    pub fn pin() {}
}

/// Both ⌘ together capture the frontmost window.
#[cfg(target_os = "macos")]
mod both_cmd {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventMask, NSRunningApplication,
    };
    use objc2_core_foundation::{
        CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType,
    };
    use objc2_core_graphics::{
        kCGNullWindowID, CGImage, CGPreflightScreenCaptureAccess, CGRectNull,
        CGRequestScreenCaptureAccess, CGWindowImageOption, CGWindowListCopyWindowInfo,
        CGWindowListOption, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowName, kCGWindowNumber,
        kCGWindowOwnerName, kCGWindowOwnerPID,
    };
    #[allow(deprecated)]
    use objc2_core_graphics::CGWindowListCreateImage;
    use objc2_foundation::{NSDictionary, NSString};
    use serde::Serialize;
    use std::path::Path;
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use tauri::{AppHandle, Emitter, Manager};

    // IOLLEvent.h device bits (not NSEventModifierFlagCommand).
    const LEFT_CMD: usize = 0x00000008;
    const RIGHT_CMD: usize = 0x00000010;

    static LEFT_DOWN: AtomicBool = AtomicBool::new(false);
    static RIGHT_DOWN: AtomicBool = AtomicBool::new(false);
    static LEFT_AT: AtomicU64 = AtomicU64::new(0);
    static RIGHT_AT: AtomicU64 = AtomicU64::new(0);
    static FIRED: AtomicBool = AtomicBool::new(false);
    static BUSY: AtomicBool = AtomicBool::new(false);
    static ASKED_CAPTURE: AtomicBool = AtomicBool::new(false);
    const KEY_LEFT_CMD: u16 = 55;
    const KEY_RIGHT_CMD: u16 = 54;
    const NS_COMMAND: usize = 1 << 20;
    // Held ⌘ then the other is much longer than this.
    const CHORD_MS: u64 = 200;

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SnapShot {
        path: String,
        title: String,
        icon: Option<String>,
    }

    struct FrontWin {
        id: u32,
        title: String,
        pid: i32,
        owner: String,
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn dict_get(dict: &CFDictionary<CFString, CFType>, key: &'static CFString) -> Option<CFRetained<CFType>> {
        dict.get(key)
    }

    fn cf_str(val: Option<CFRetained<CFType>>) -> Option<String> {
        let s = val?.downcast::<CFString>().ok()?;
        Some(s.to_string())
    }

    fn cf_i64(val: Option<CFRetained<CFType>>) -> Option<i64> {
        val?.downcast::<CFNumber>().ok()?.as_i64()
    }

    fn cf_bool(val: Option<CFRetained<CFType>>) -> bool {
        val.and_then(|v| v.downcast::<CFBoolean>().ok())
            .map(|b| b.as_bool())
            .unwrap_or(true)
    }

    fn front_window() -> Option<FrontWin> {
        let raw = CGWindowListCopyWindowInfo(
            CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
            kCGNullWindowID,
        )?;
        type WinDict = CFDictionary<CFString, CFType>;
        let arr: CFRetained<CFArray<WinDict>> = unsafe { CFRetained::cast_unchecked(raw) };
        let our_pid = i64::from(std::process::id());
        let mut ours: Option<FrontWin> = None;
        for i in 0..arr.len() {
            let Some(dict) = arr.get(i) else {
                continue;
            };
            if cf_i64(unsafe { dict_get(&dict, kCGWindowLayer) }) != Some(0) {
                continue;
            }
            if !cf_bool(unsafe { dict_get(&dict, kCGWindowIsOnscreen) }) {
                continue;
            }
            let Some(id) = cf_i64(unsafe { dict_get(&dict, kCGWindowNumber) })
                .and_then(|n| u32::try_from(n).ok())
            else {
                continue;
            };
            let pid = cf_i64(unsafe { dict_get(&dict, kCGWindowOwnerPID) }).unwrap_or(0) as i32;
            let owner = cf_str(unsafe { dict_get(&dict, kCGWindowOwnerName) }).unwrap_or_default();
            let name = cf_str(unsafe { dict_get(&dict, kCGWindowName) }).unwrap_or_default();
            let title = if name.trim().is_empty() {
                owner.clone()
            } else {
                name
            };
            let win = FrontWin {
                id,
                title,
                pid,
                owner,
            };
            if i64::from(pid) == our_pid || win.owner.eq_ignore_ascii_case("Grotesque") {
                if ours.is_none() {
                    ours = Some(win);
                }
                continue;
            }
            return Some(win);
        }
        ours
    }

    fn write_icon(pid: i32, dest: &std::path::Path) -> Option<()> {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        let icon = app.icon()?;
        let tiff = icon.TIFFRepresentation()?;
        std::fs::write(dest, tiff.to_vec()).ok()?;
        dest.is_file().then_some(())
    }

    #[allow(deprecated)]
    fn grab_window_image(win_id: Option<u32>) -> Option<CFRetained<CGImage>> {
        let bounds = unsafe { CGRectNull };
        let opts = CGWindowImageOption::BoundsIgnoreFraming | CGWindowImageOption::BestResolution;
        let tries: [(CGWindowListOption, CGWindowImageOption); 2] = if win_id.is_some() {
            [
                (CGWindowListOption::OptionIncludingWindow, opts),
                (
                    CGWindowListOption::OptionIncludingWindow
                        | CGWindowListOption::OptionOnScreenOnly,
                    opts,
                ),
            ]
        } else {
            [
                (
                    CGWindowListOption::OptionOnScreenOnly,
                    CGWindowImageOption::Default,
                ),
                (
                    CGWindowListOption::OptionOnScreenOnly,
                    opts,
                ),
            ]
        };
        let id = win_id.unwrap_or(kCGNullWindowID);
        for (list, image_opt) in tries {
            let Some(img) = CGWindowListCreateImage(bounds, list, id, image_opt) else {
                continue;
            };
            if CGImage::width(Some(&img)) >= 2 && CGImage::height(Some(&img)) >= 2 {
                return Some(img);
            }
        }
        None
    }

    fn write_jpeg(img: &CGImage, path: &Path) -> Result<(), String> {
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), img);
        let empty = NSDictionary::<NSString, AnyObject>::new();
        let data = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &empty)
        }
        .ok_or_else(|| "Cannot encode snapshot.".to_string())?;
        let ns_path = NSString::from_str(
            path.to_str()
                .ok_or_else(|| "Invalid snapshot path.".to_string())?,
        );
        if !data.writeToFile_atomically(&ns_path, true) {
            return Err("Cannot write snapshot.".into());
        }
        Ok(())
    }

    fn capture_cli(path: &Path, win_id: Option<u32>) -> bool {
        let mut cmd = std::process::Command::new("screencapture");
        cmd.args(["-x", "-t", "jpg"]);
        if let Some(id) = win_id {
            cmd.arg(format!("-l{id}"));
        }
        cmd.arg(path);
        cmd.status().map(|s| s.success()).unwrap_or(false) && path.is_file()
    }

    fn capture_front() -> Result<SnapShot, String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let win = front_window();
        let path = std::env::temp_dir().join(format!("grotesque-snap-{stamp}.jpg"));
        let id = win.as_ref().map(|w| w.id);
        let mut ok = false;
        if let Some(img) = grab_window_image(id) {
            ok = write_jpeg(&img, &path).is_ok() && path.is_file();
        }
        if !ok {
            ok = capture_cli(&path, id);
        }
        if !ok && !CGPreflightScreenCaptureAccess() && !ASKED_CAPTURE.swap(true, Ordering::SeqCst)
        {
            let _ = CGRequestScreenCaptureAccess();
            if let Some(img) = grab_window_image(id) {
                ok = write_jpeg(&img, &path).is_ok() && path.is_file();
            }
            if !ok {
                ok = capture_cli(&path, id);
            }
        }
        if !ok {
            return Err(
                "Cannot capture window. Allow Screen Recording for Grotesque in System Settings."
                    .into(),
            );
        }
        let path = path
            .to_str()
            .ok_or_else(|| "Invalid snapshot path.".to_string())?
            .to_string();
        let title = win
            .as_ref()
            .map(|w| w.title.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Window".into());
        let icon = win.as_ref().and_then(|w| {
            let ip = std::env::temp_dir().join(format!("grotesque-snap-icon-{stamp}.tiff"));
            write_icon(w.pid, &ip)?;
            ip.to_str().map(str::to_string)
        });
        Ok(SnapShot { path, title, icon })
    }

    fn set_side(down: &AtomicBool, at: &AtomicU64, now_down: bool, t: u64) {
        let was = down.swap(now_down, Ordering::SeqCst);
        if now_down && !was {
            at.store(t, Ordering::SeqCst);
        }
        if !now_down {
            at.store(0, Ordering::SeqCst);
        }
    }

    fn on_flags(app: &AppHandle, flags: usize, key_code: u16) {
        let cmd = flags & NS_COMMAND != 0;
        if !cmd {
            LEFT_DOWN.store(false, Ordering::SeqCst);
            RIGHT_DOWN.store(false, Ordering::SeqCst);
            LEFT_AT.store(0, Ordering::SeqCst);
            RIGHT_AT.store(0, Ordering::SeqCst);
            FIRED.store(false, Ordering::SeqCst);
            return;
        }
        let t = now_ms();
        let left_bit = flags & LEFT_CMD != 0;
        let right_bit = flags & RIGHT_CMD != 0;
        if left_bit || right_bit {
            set_side(&LEFT_DOWN, &LEFT_AT, left_bit, t);
            set_side(&RIGHT_DOWN, &RIGHT_AT, right_bit, t);
        } else if key_code == KEY_LEFT_CMD {
            let now_down = !LEFT_DOWN.load(Ordering::SeqCst);
            set_side(&LEFT_DOWN, &LEFT_AT, now_down, t);
        } else if key_code == KEY_RIGHT_CMD {
            let now_down = !RIGHT_DOWN.load(Ordering::SeqCst);
            set_side(&RIGHT_DOWN, &RIGHT_AT, now_down, t);
        }
        let left = LEFT_DOWN.load(Ordering::SeqCst);
        let right = RIGHT_DOWN.load(Ordering::SeqCst);
        if !left || !right {
            FIRED.store(false, Ordering::SeqCst);
            return;
        }
        if FIRED.load(Ordering::SeqCst) {
            return;
        }
        let lt = LEFT_AT.load(Ordering::SeqCst);
        let rt = RIGHT_AT.load(Ordering::SeqCst);
        if lt == 0 || rt == 0 || lt.abs_diff(rt) > CHORD_MS {
            return;
        }
        FIRED.store(true, Ordering::SeqCst);
        if BUSY.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = capture_front();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            match result {
                Ok(snap) => {
                    let _ = app.emit("screen-snapshot", snap);
                }
                Err(e) => {
                    let _ = app.emit("screen-snapshot-error", e);
                }
            }
            BUSY.store(false, Ordering::SeqCst);
        });
    }

    pub fn install(app: &AppHandle) {
        let mask = NSEventMask::FlagsChanged;
        let app_g = app.clone();
        let global = RcBlock::new(move |ev: NonNull<NSEvent>| {
            let ev = unsafe { ev.as_ref() };
            on_flags(&app_g, ev.modifierFlags().0, ev.keyCode());
        });
        if let Some(mon) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global) {
            std::mem::forget(mon);
        }
        std::mem::forget(global);

        let app_l = app.clone();
        let local = RcBlock::new(move |ev: NonNull<NSEvent>| -> *mut NSEvent {
            let evr = unsafe { ev.as_ref() };
            on_flags(&app_l, evr.modifierFlags().0, evr.keyCode());
            ev.as_ptr()
        });
        let mon = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local)
        };
        if let Some(mon) = mon {
            std::mem::forget(mon);
        }
        std::mem::forget(local);
    }
}

#[cfg(not(target_os = "macos"))]
mod both_cmd {
    pub fn install(_app: &tauri::AppHandle) {}
}

const BROWSER_LABEL: &str = "panel-browser";
static BROWSER_SHOWN: AtomicBool = AtomicBool::new(false);

struct LastDownload(Mutex<Option<PathBuf>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNav {
    url: String,
    title: String,
    loading: bool,
}

fn browser_file_name(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|s| s.last())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "download".into())
}

fn parse_http_url(raw: &str) -> Result<Url, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("Enter a URL.".into());
    }
    let with_scheme = if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else if t.starts_with("about:") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    Url::parse(&with_scheme).map_err(|_| "Not a web address.".to_string())
}

fn emit_browser_nav(app: &tauri::AppHandle, url: String, title: String, loading: bool) {
    let _ = app.emit(
        "browser-nav",
        BrowserNav {
            url,
            title,
            loading,
        },
    );
}

fn ensure_browser(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview(BROWSER_LABEL).is_some() {
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is missing.".to_string())?;
    let handle = app.clone();
    let handle_title = app.clone();
    let handle_dl = app.clone();
    let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
    let builder = WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(blank))
        .on_page_load(move |_webview, payload| {
            let url = payload.url().to_string();
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_browser_nav(&handle, url, String::new(), loading);
        })
        .on_document_title_changed(move |_webview, title| {
            emit_browser_nav(&handle_title, String::new(), title, false);
        })
        .on_download(move |webview, event| {
            let app = webview.app_handle().clone();
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let name = browser_file_name(url.as_str());
                    let picked = handle_dl
                        .dialog()
                        .file()
                        .set_file_name(&name)
                        .set_title("Save download")
                        .blocking_save_file()
                        .and_then(|p| p.into_path().ok());
                    let Some(path) = picked else {
                        return false;
                    };
                    if let Some(last) = app.try_state::<LastDownload>() {
                        if let Ok(mut g) = last.0.lock() {
                            *g = Some(path.clone());
                        }
                    }
                    *destination = path;
                    true
                }
                DownloadEvent::Finished { success, path, .. } => {
                    if !success {
                        return true;
                    }
                    let saved = path.filter(|p| p.exists()).or_else(|| {
                        app.try_state::<LastDownload>()
                            .and_then(|last| last.0.lock().ok().and_then(|mut g| g.take()))
                    });
                    if let Some(p) = saved {
                        let _ = std::process::Command::new("open").arg(&p).status();
                    }
                    true
                }
                _ => true,
            }
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| format!("Cannot open the in-app browser: {e}"))?;
    if let Some(wv) = app.get_webview(BROWSER_LABEL) {
        let _ = wv.hide();
        bind_browser_wk(&wv);
    }
    Ok(())
}

#[tauri::command]
fn browser_set_bounds(app: tauri::AppHandle, x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
    if !visible {
        if !BROWSER_SHOWN.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(wv) = app.get_webview(BROWSER_LABEL) {
            let _ = wv.hide();
        }
        return Ok(());
    }
    ensure_browser(&app)?;
    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser is missing.".to_string())?;
    let width = w.max(1.0);
    let height = h.max(1.0);
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    wv.show().map_err(|e| e.to_string())?;
    BROWSER_SHOWN.store(true, Ordering::SeqCst);
    bind_browser_wk(&wv);
    plus_layer::order_front();
    Ok(())
}

fn bind_browser_wk<R: tauri::Runtime>(wv: &tauri::Webview<R>) {
    let _ = wv.with_webview(|platform| {
        #[cfg(target_os = "macos")]
        plus_layer::bind_webview(platform.inner());
    });
}

#[tauri::command]
fn browser_navigate(app: tauri::AppHandle, url: String) -> Result<String, String> {
    ensure_browser(&app)?;
    let parsed = parse_http_url(&url)?;
    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser is missing.".to_string())?;
    let href = parsed.to_string();
    wv.navigate(parsed).map_err(|e| format!("Could not open that page: {e}"))?;
    emit_browser_nav(&app, href.clone(), String::new(), true);
    Ok(href)
}

#[tauri::command]
fn browser_reload(app: tauri::AppHandle) -> Result<(), String> {
    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser is missing.".to_string())?;
    wv.reload().map_err(|e| e.to_string())
}

#[tauri::command]
fn browser_stop(app: tauri::AppHandle) -> Result<(), String> {
    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser is missing.".to_string())?;
    wv.eval("window.stop()").map_err(|e| e.to_string())
}

/// Grotesque + card on the in-app page. CSS in the pane cannot cover that view.
/// Clicks and hover use a window monitor: the card hangs over the URL bar, outside
/// the page hit-test.
#[cfg(target_os = "macos")]
mod plus_layer {
    use std::ffi::c_void;
    use std::ptr;
    use std::sync::atomic::{AtomicI8, AtomicPtr, Ordering};
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, AnyProtocol};
    use objc2::{class, define_class, msg_send, ClassType, MainThreadOnly};
    use objc2_app_kit::{NSColor, NSEvent, NSEventMask, NSEventType};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
    use tauri::Emitter;

    static APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
    static WK: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());
    static OVERLAY: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());
    static HOST: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());
    static MONITOR: AtomicPtr<AnyObject> = AtomicPtr::new(ptr::null_mut());
    static OPENED: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    static HOVER: AtomicI8 = AtomicI8::new(-1);

    pub struct PlusIvars;

    define_class!(
        #[unsafe(super(objc2::runtime::NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PlusIvars]
        pub struct PlusHost;

        impl PlusHost {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn on_message(&self, _controller: *mut AnyObject, message: *mut AnyObject) {
                unsafe {
                    let body: *mut AnyObject = msg_send![message, body];
                    if body.is_null() {
                        return;
                    }
                    let s: Retained<NSString> = msg_send![body, description];
                    let route = s.to_string();
                    if route == "pick/page" || route == "pick/side" {
                        emit_pick(&route);
                    }
                }
            }
        }
    );

    pub fn bind_webview(ptr: *mut c_void) {
        if ptr.is_null() {
            return;
        }
        WK.store(ptr as *mut AnyObject, Ordering::SeqCst);
    }

    fn emit_pick(route: &str) {
        hide_overlay();
        if let Ok(g) = APP.lock() {
            if let Some(app) = g.as_ref() {
                let _ = app.emit("plus-pick", route.to_string());
            }
        }
    }

    pub fn hide_overlay() {
        HOVER.store(-1, Ordering::SeqCst);
        unsafe {
            let overlay = OVERLAY.load(Ordering::SeqCst);
            if !overlay.is_null() {
                let _: () = msg_send![overlay, setHidden: true];
                let _: () = msg_send![overlay, removeFromSuperview];
            }
            let mon = MONITOR.swap(ptr::null_mut(), Ordering::SeqCst);
            if !mon.is_null() {
                let _: () = msg_send![class!(NSEvent), removeMonitor: mon];
            }
        }
    }

    fn set_hover(row: i8) {
        if HOVER.swap(row, Ordering::SeqCst) == row {
            return;
        }
        let overlay = OVERLAY.load(Ordering::SeqCst);
        if overlay.is_null() {
            return;
        }
        let js = format!(
            "document.querySelectorAll('.pick').forEach(function(el,i){{el.classList.toggle('is-hover',i==={row})}})"
        );
        unsafe {
            let _: () = msg_send![
                overlay,
                evaluateJavaScript: &*NSString::from_str(&js),
                completionHandler: ptr::null_mut::<AnyObject>()
            ];
        }
    }

    fn hide() {
        hide_overlay();
        if let Ok(g) = APP.lock() {
            if let Some(app) = g.as_ref() {
                let _ = app.emit("plus-pick", "dismiss".to_string());
            }
        }
    }

    pub fn order_front() {
        unsafe {
            let overlay = OVERLAY.load(Ordering::SeqCst);
            if overlay.is_null() {
                return;
            }
            let hidden: bool = msg_send![overlay, isHidden];
            if hidden {
                return;
            }
            let parent: *mut AnyObject = msg_send![overlay, superview];
            if parent.is_null() {
                return;
            }
            let _: () = msg_send![
                parent,
                addSubview: overlay,
                positioned: 1isize,
                relativeTo: ptr::null_mut::<AnyObject>()
            ];
        }
    }

    unsafe fn overlay_frame(wk: *mut AnyObject, x: f64, y: f64, w: f64, h: f64) -> NSRect {
        let bounds: NSRect = msg_send![wk, bounds];
        let flipped: bool = msg_send![wk, isFlipped];
        let width = w.max(160.0);
        let height = h.max(72.0);
        let mut ox = x;
        if ox + width > bounds.size.width - 8.0 {
            ox = (bounds.size.width - width - 8.0).max(8.0);
        }
        if ox < 8.0 {
            ox = 8.0;
        }
        let oy = if flipped {
            y
        } else {
            bounds.size.height - y - height
        };
        NSRect {
            origin: NSPoint { x: ox, y: oy },
            size: NSSize { width, height },
        }
    }

    fn host(mtm: MainThreadMarker) -> Retained<PlusHost> {
        let existing = HOST.load(Ordering::SeqCst);
        if !existing.is_null() {
            return unsafe { Retained::retain(existing as *mut PlusHost).unwrap() };
        }
        if let Some(proto) = AnyProtocol::get(c"WKScriptMessageHandler") {
            let cls = PlusHost::class();
            unsafe {
                let _ = objc2::ffi::class_addProtocol(cls as *const AnyClass as *mut AnyClass, proto);
            }
        }
        let host = PlusHost::alloc(mtm).set_ivars(PlusIvars);
        let host: Retained<PlusHost> = unsafe { msg_send![super(host), init] };
        HOST.store(Retained::as_ptr(&host) as *mut AnyObject, Ordering::SeqCst);
        std::mem::forget(host.clone());
        host
    }

    unsafe fn make_overlay(
        frame: NSRect,
        host: &PlusHost,
        html: &str,
    ) -> Result<Retained<AnyObject>, String> {
        let config: *mut AnyObject = msg_send![class!(WKWebViewConfiguration), new];
        if config.is_null() {
            return Err("Plus menu is missing.".into());
        }
        let ucc: *mut AnyObject = msg_send![config, userContentController];
        let _: () = msg_send![
            ucc,
            addScriptMessageHandler: host,
            name: &*NSString::from_str("plus")
        ];
        let wv: *mut AnyObject = msg_send![class!(WKWebView), alloc];
        let wv: *mut AnyObject = msg_send![wv, initWithFrame: frame, configuration: config];
        if wv.is_null() {
            return Err("Plus menu is missing.".into());
        }
        paint_overlay(wv, frame, html);
        Ok(Retained::retain(wv).unwrap())
    }

    unsafe fn paint_overlay(wv: *mut AnyObject, frame: NSRect, html: &str) {
        let _: () = msg_send![wv, setFrame: frame];
        let _: () = msg_send![wv, setClipsToBounds: true];
        let _: () = msg_send![wv, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![wv, layer];
        let _: () = msg_send![layer, setCornerRadius: 14.0f64];
        let _: () = msg_send![layer, setMasksToBounds: true];
        let _: () = msg_send![layer, setZPosition: 1_000_000f64];
        let dark = !html.contains("data-theme=\"light\"");
        let fill = if dark {
            NSColor::colorWithCalibratedRed_green_blue_alpha(0.173, 0.173, 0.18, 1.0)
        } else {
            NSColor::colorWithCalibratedRed_green_blue_alpha(1.0, 1.0, 1.0, 1.0)
        };
        let cg: *mut AnyObject = msg_send![&*fill, CGColor];
        let _: () = msg_send![layer, setBackgroundColor: cg];
        let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
        let _: () = msg_send![
            wv,
            setValue: no,
            forKey: &*NSString::from_str("drawsBackground")
        ];
        let _: () = msg_send![wv, setUnderPageBackgroundColor: &*fill];
        let _: () = msg_send![
            wv,
            loadHTMLString: &*NSString::from_str(html),
            baseURL: ptr::null_mut::<AnyObject>()
        ];
        let _: () = msg_send![wv, setHidden: false];
    }

    pub fn set(
        app: &tauri::AppHandle,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        html: &str,
    ) -> Result<(), String> {
        if let Ok(mut g) = APP.lock() {
            *g = Some(app.clone());
        }
        if html.is_empty() {
            hide_overlay();
            return Ok(());
        }
        let wk = WK.load(Ordering::SeqCst);
        if wk.is_null() {
            return Err("Browser is missing.".into());
        }
        let mtm = MainThreadMarker::new().ok_or_else(|| "Main thread is missing.".to_string())?;
        let frame = unsafe { overlay_frame(wk, x, y, w, h) };
        let host = host(mtm);
        let overlay_ptr = OVERLAY.load(Ordering::SeqCst);
        let overlay = if overlay_ptr.is_null() {
            let overlay = unsafe { make_overlay(frame, &host, html)? };
            OVERLAY.store(Retained::as_ptr(&overlay) as *mut AnyObject, Ordering::SeqCst);
            std::mem::forget(overlay.clone());
            overlay
        } else {
            unsafe {
                paint_overlay(overlay_ptr, frame, html);
                Retained::retain(overlay_ptr).unwrap()
            }
        };
        unsafe {
            let _: () = msg_send![wk, setClipsToBounds: false];
            let _: () = msg_send![
                wk,
                addSubview: &*overlay,
                positioned: 1isize,
                relativeTo: ptr::null_mut::<AnyObject>()
            ];
        }
        if let Ok(mut g) = OPENED.lock() {
            *g = Some(std::time::Instant::now());
        }
        unsafe {
            let win: *mut AnyObject = msg_send![&*overlay, window];
            if !win.is_null() {
                let _: () = msg_send![win, setAcceptsMouseMovedEvents: true];
            }
        }
        hide_monitor();
        install_monitor();
        Ok(())
    }

    fn hide_monitor() {
        unsafe {
            let mon = MONITOR.swap(ptr::null_mut(), Ordering::SeqCst);
            if !mon.is_null() {
                let _: () = msg_send![class!(NSEvent), removeMonitor: mon];
            }
        }
    }

    fn point_in(rect: NSRect, p: NSPoint) -> bool {
        p.x >= rect.origin.x
            && p.x <= rect.origin.x + rect.size.width
            && p.y >= rect.origin.y
            && p.y <= rect.origin.y + rect.size.height
    }

    unsafe fn card_in_window(overlay: *mut AnyObject) -> NSRect {
        let bounds: NSRect = msg_send![overlay, bounds];
        msg_send![
            overlay,
            convertRect: bounds,
            toView: ptr::null_mut::<AnyObject>()
        ]
    }

    fn row_at(card: NSRect, p: NSPoint) -> i8 {
        if !point_in(card, p) {
            return -1;
        }
        if p.y >= card.origin.y + card.size.height / 2.0 {
            0
        } else {
            1
        }
    }

    fn install_monitor() {
        use block2::RcBlock;
        use std::ptr::NonNull;
        let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
            unsafe {
                let down = event.as_ref().r#type() == NSEventType::LeftMouseDown;
                if down {
                    if let Ok(g) = OPENED.lock() {
                        if let Some(t) = *g {
                            if t.elapsed() < std::time::Duration::from_millis(250) {
                                return event.as_ptr();
                            }
                        }
                    }
                }
                let overlay = OVERLAY.load(Ordering::SeqCst);
                if overlay.is_null() {
                    return event.as_ptr();
                }
                let hidden: bool = msg_send![overlay, isHidden];
                if hidden {
                    return event.as_ptr();
                }
                let loc = event.as_ref().locationInWindow();
                let row = row_at(card_in_window(overlay), loc);
                if row >= 0 {
                    if down {
                        emit_pick(if row == 0 { "pick/page" } else { "pick/side" });
                        return ptr::null_mut();
                    }
                    set_hover(row);
                    return event.as_ptr();
                }
                set_hover(-1);
                if down {
                    hide();
                }
            }
            event.as_ptr()
        });
        unsafe {
            let mon: *mut AnyObject = msg_send![
                class!(NSEvent),
                addLocalMonitorForEventsMatchingMask: NSEventMask::LeftMouseDown.union(NSEventMask::MouseMoved),
                handler: &*block
            ];
            MONITOR.store(mon, Ordering::SeqCst);
        }
        std::mem::forget(block);
    }
}

#[cfg(not(target_os = "macos"))]
mod plus_layer {
    pub fn bind_webview(_ptr: *mut std::ffi::c_void) {}

    pub fn set(
        _app: &tauri::AppHandle,
        _x: f64,
        _y: f64,
        _w: f64,
        _h: f64,
        _html: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    pub fn hide_overlay() {}

    pub fn order_front() {}
}

#[tauri::command]
fn plus_menu_set(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    html: Option<String>,
) -> Result<(), String> {
    if !visible {
        plus_layer::hide_overlay();
        return Ok(());
    }
    let html = html.unwrap_or_default();
    let wv = app
        .get_webview(BROWSER_LABEL)
        .ok_or_else(|| "Browser is missing.".to_string())?;
    #[cfg(target_os = "macos")]
    {
        if objc2_foundation::MainThreadMarker::new().is_some() {
            bind_browser_wk(&wv);
            return plus_layer::set(&app, x, y, w, h, &html);
        }
        let app2 = app.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        wv.with_webview(move |platform| {
            plus_layer::bind_webview(platform.inner());
            let r = plus_layer::set(&app2, x, y, w, h, &html);
            let _ = tx.send(r);
        })
        .map_err(|e| e.to_string())?;
        return rx
            .recv_timeout(std::time::Duration::from_millis(800))
            .map_err(|_| "Plus menu timed out.".to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    plus_layer::set(&app, x, y, w, h, &html)
}

/// After Mac sleep: drop dead grok processes. Live turns fail; session id stays.
#[cfg(target_os = "macos")]
mod mac_wake {
    use crate::acp::AcpLive;
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    pub fn install(pool: AcpLive) {
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let block = RcBlock::new(move |_note: NonNull<NSNotification>| {
            pool.after_wake();
        });
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidWakeNotification),
                None,
                None,
                &block,
            )
        };
        std::mem::forget(observer);
        std::mem::forget(block);
    }
}

#[cfg(not(target_os = "macos"))]
mod mac_wake {
    pub fn install(_pool: crate::acp::AcpLive) {}
}

/// Dock-launched apps get a short PATH. grok and Homebrew live outside it.
fn extend_gui_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        format!("{home}/.grok/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    for extra in extras.into_iter().rev() {
        if extra.is_empty() || parts.iter().any(|p| p == &extra) {
            continue;
        }
        if std::path::Path::new(&extra).is_dir() {
            parts.insert(0, extra);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    extend_gui_path();
    let gate: PermissionGate = Arc::new(Mutex::new(HashMap::new()));
    let pool: AcpLive = Arc::new(acp::AcpPool::new());
    let pool_wake = pool.clone();
    let last_download = LastDownload(Mutex::new(None));
    let quit_ok = Arc::new(AtomicBool::new(false));
    let quit_ok_run = quit_ok.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(gate)
        .manage(pool)
        .manage(last_download)
        .manage(QuitOk(quit_ok))
        .setup(move |app| {
            install_menu(app)?;
            if let Some(win) = app.get_webview_window("main") {
                traffic_lights::install(&win);
            }
            both_cmd::install(app.handle());
            mac_wake::install(pool_wake);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_grok_stream,
            respond_card,
            set_run_mode,
            reset_session,
            stop_turn,
            list_project_sessions,
            recents_dir,
            load_session_history,
            load_subagent_history,
            list_subagents,
            build_session_search_index,
            search_session_texts,
            load_session_usage,
            load_usage_stats,
            load_recent_prompts,
            list_path_hits,
            project_paths_exist,
            list_skill_commands,
            load_plugins_snapshot,
            set_mcp_enabled,
            remove_mcp_server,
            add_mcp_url,
            list_marketplace_plugins,
            install_marketplace_plugin,
            sign_in_mcp,
            sign_out_mcp,
            set_skill_enabled,
            list_skill_files,
            open_in_textedit,
            check_grok,
            about_info,
            open_app_log,
            check_cli_update,
            install_cli_update,
            list_models,
            fetch_remote_media,
            open_url,
            browser_set_bounds,
            browser_navigate,
            browser_reload,
            browser_stop,
            plus_menu_set,
            open_path,
            open_path_with,
            copy_path,
            mac_app_icons,
            read_project_text,
            reveal_in_finder,
            list_obsidian_vaults,
            open_in_obsidian,
            inspect_attach_paths,
            save_temp_attach,
            allow_and_quit,
            pin_traffic_lights
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if quit_ok_run.load(Ordering::SeqCst) {
                        return;
                    }
                    api.prevent_exit();
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if has_visible_windows {
                        return;
                    }
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                        traffic_lights::pin();
                    }
                }
                _ => {}
            }
        });
}
