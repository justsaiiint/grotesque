//! ACP pool: one `grok agent stdio` process per Grotesque chat key.

use crate::grok_adapter::{
    clarify_grok_error, ensure_grok_ready, GrokRunResult, StreamEvent,
};
use crate::mcp_target::{
    ask_header, clip_str, format_read_span, humanize_mcp_query, is_image_path, json_u64,
    nested_str, nested_target as nested_raw_target, urls_from, PATH_KEYS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Pending permission decisions: `"chatKey:id"` → optionId channel.
pub type PermissionGate = Arc<Mutex<HashMap<String, SyncSender<String>>>>;

fn perm_key(chat_key: &str, id: u64) -> String {
    format!("{chat_key}:{id}")
}

/// One warm ACP process (one Grok session).
pub struct AcpHub {
    live: Mutex<Option<LiveAcp>>,
    cancel: AtomicBool,
    /// Active agent PID so Stop can kill without waiting for the live lock.
    child_pid: std::sync::atomic::AtomicU32,
    /// Grotesque mode for the next approval. Readable without the live lock.
    desk_mode: Mutex<String>,
    /// True while `run_prompt` owns this hub. Skip a recycle so start is not dropped.
    busy: AtomicBool,
}

impl AcpHub {
    pub fn new() -> Self {
        Self {
            live: Mutex::new(None),
            cancel: AtomicBool::new(false),
            child_pid: AtomicU32::new(0),
            desk_mode: Mutex::new("auto".into()),
            busy: AtomicBool::new(false),
        }
    }

    fn set_busy(&self, on: bool) {
        self.busy.store(on, Ordering::SeqCst);
    }

    fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }

    fn mode(&self) -> String {
        self.desk_mode
            .lock()
            .map(|m| m.clone())
            .unwrap_or_else(|_| "auto".into())
    }

    fn set_mode(&self, mode: &str) {
        if let Ok(mut g) = self.desk_mode.lock() {
            *g = normalize_mode(mode).to_string();
        }
    }

    fn clear_cancel(&self) {
        self.cancel.store(false, Ordering::SeqCst);
    }

    fn request_cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn set_child_pid(&self, pid: u32) {
        self.child_pid.store(pid, Ordering::SeqCst);
    }

    fn clear_child_pid(&self) {
        self.child_pid.store(0, Ordering::SeqCst);
    }

    /// SIGKILL the agent process immediately (does not need the live lock).
    fn force_kill_child(&self) {
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{pid}")])
            .status();
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

/// Stop the live turn for one chat. Queue and session id stay for the next prompt.
pub fn stop_turn(pool: &AcpLive, chat_key: &str) -> Result<(), String> {
    if chat_key.trim().is_empty() {
        return Err("Missing chat key.".into());
    }
    let hub = pool.hub_for(chat_key)?;
    hub.request_cancel();
    // Kill now — run_prompt holds the live lock for the whole turn, so we cannot
    // take LiveAcp here; PID kill unblocks the wait loop immediately.
    hub.force_kill_child();
    if let Ok(mut g) = hub.live.try_lock() {
        if let Some(s) = g.take() {
            s.shutdown();
        }
    }
    Ok(())
}

/// One hub per Grotesque chat key — concurrent chats run in parallel.
pub struct AcpPool {
    hubs: Mutex<HashMap<String, Arc<AcpHub>>>,
}

impl AcpPool {
    pub fn new() -> Self {
        Self {
            hubs: Mutex::new(HashMap::new()),
        }
    }

    fn hub_for(&self, chat_key: &str) -> Result<Arc<AcpHub>, String> {
        let mut map = self
            .hubs
            .lock()
            .map_err(|_| "ACP pool lock poisoned".to_string())?;
        Ok(map
            .entry(chat_key.to_string())
            .or_insert_with(|| Arc::new(AcpHub::new()))
            .clone())
    }

    pub fn reset_chat(&self, chat_key: &str) {
        let hub = {
            let mut map = match self.hubs.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.remove(chat_key)
        };
        if let Some(hub) = hub {
            hub.request_cancel();
            hub.force_kill_child();
            if let Ok(mut g) = hub.live.lock() {
                if let Some(s) = g.take() {
                    s.shutdown();
                }
            }
        }
    }

    fn pid_is_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// After Mac wake: drop dead agents. A live turn fails with session id kept.
    pub fn after_wake(&self) {
        let hubs: Vec<Arc<AcpHub>> = {
            let map = match self.hubs.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.values().cloned().collect()
        };
        for hub in hubs {
            let pid = hub.child_pid.load(Ordering::SeqCst);
            if pid == 0 || Self::pid_is_alive(pid) {
                continue;
            }
            hub.force_kill_child();
            if hub.is_busy() {
                continue;
            }
            if let Ok(mut g) = hub.live.try_lock() {
                if let Some(s) = g.take() {
                    s.shutdown();
                }
            }
        }
    }

    pub fn reset_all(&self) {
        let hubs: Vec<Arc<AcpHub>> = {
            let mut map = match self.hubs.lock() {
                Ok(m) => m,
                Err(_) => return,
            };
            map.drain().map(|(_, h)| h).collect()
        };
        for hub in hubs {
            hub.request_cancel();
            hub.force_kill_child();
            if let Ok(mut g) = hub.live.lock() {
                if let Some(s) = g.take() {
                    s.shutdown();
                }
            }
        }
    }
}

pub type AcpLive = Arc<AcpPool>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOptionDto {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskOptionDto {
    pub label: String,
    pub description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestionDto {
    pub question: String,
    pub options: Vec<AskOptionDto>,
    pub multi_select: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestDto {
    pub id: u64,
    pub chat_key: String,
    pub questions: Vec<AskQuestionDto>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequestDto {
    pub id: u64,
    pub chat_key: String,
    pub plan_content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeChangeDto {
    pub chat_key: String,
    pub mode: String,
}

pub struct LiveAcp {
    child: Child,
    stdin: ChildStdin,
    out_rx: Receiver<Value>,
    next_id: u64,
    session_id: String,
    cwd: String,
    desk_mode: String,
    /// Server requests that arrived during initialize/resume (handle on the next prompt).
    pending_server: Vec<Value>,
    commands: Vec<SlashCmd>,
}

#[derive(Clone, Serialize)]
struct SlashCmd {
    name: String,
    description: String,
}

impl LiveAcp {
    fn pid(&self) -> u32 {
        self.child.id()
    }
}

fn send_event(on_event: &tauri::ipc::Channel<StreamEvent>, kind: &str, data: impl Into<String>) {
    let _ = on_event.send(StreamEvent {
        kind: kind.into(),
        data: data.into(),
    });
}

fn write_msg(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    writeln!(stdin, "{line}").map_err(|e| format!("ACP stdin write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("ACP stdin flush failed: {e}"))?;
    Ok(())
}

fn normalize_mode(mode: &str) -> &str {
    match mode.trim().to_ascii_lowercase().as_str() {
        "bypass" | "bypasspermissions" => "bypass",
        "plan" => "plan",
        _ => "auto",
    }
}

/// Grotesque mode → ACP `session/set_mode` id. Plan is real; Bypass/Auto use default + Grotesque auto-allow.
fn acp_mode_id(desk_mode: &str) -> &'static str {
    match normalize_mode(desk_mode) {
        "plan" => "plan",
        _ => "default",
    }
}

fn is_side_chat(chat_key: &str) -> bool {
    chat_key.starts_with("side:")
}

fn rpc_id(msg: &Value) -> Option<u64> {
    let id = msg.get("id")?;
    if let Some(n) = id.as_u64() {
        return Some(n);
    }
    if let Some(n) = id.as_i64() {
        return u64::try_from(n).ok();
    }
    id.as_str()?.parse().ok()
}

fn ext_method_name(method: &str) -> &str {
    method.strip_prefix('_').unwrap_or(method)
}

fn is_session_update_method(method: &str) -> bool {
    method == "session/update" || ext_method_name(method) == "x.ai/session/update"
}

fn session_update_id(msg: &Value) -> Option<&str> {
    msg.pointer("/params/sessionId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Child sessions share this ACP stdio. Paint only this chat's updates.
fn is_this_session(msg: &Value, session_id: &str) -> bool {
    match session_update_id(msg) {
        None => true,
        Some(sid) => sid == session_id,
    }
}

fn tool_meta_name(update: &Value) -> String {
    update
        .get("_meta")
        .and_then(|m| m.get("x.ai/tool"))
        .and_then(|t| t.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn is_ask_user_method(method: &str) -> bool {
    ext_method_name(method) == "x.ai/ask_user_question"
}

fn is_exit_plan_method(method: &str) -> bool {
    ext_method_name(method) == "x.ai/exit_plan_mode"
}

fn is_ask_user_perm(params: &Value) -> bool {
    let title = params
        .pointer("/toolCall/title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = params
        .pointer("/toolCall/_meta/x.ai/tool/name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = params
        .pointer("/toolCall/_meta/x.ai/tool/kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if kind == "ask_user" || name.contains("ask_user") || title.contains("ask_user") {
        return true;
    }
    params
        .pointer("/toolCall/rawInput/questions")
        .and_then(|v| v.as_array())
        .is_some()
}

fn parse_questions(params: &Value) -> Vec<AskQuestionDto> {
    let raw = params
        .get("questions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for q in raw {
        let question = q
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if question.is_empty() {
            continue;
        }
        let mut options = Vec::new();
        if let Some(arr) = q.get("options").and_then(|v| v.as_array()) {
            for o in arr {
                let label = o
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if label.is_empty() {
                    continue;
                }
                options.push(AskOptionDto {
                    description: o
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    label,
                });
            }
        }
        let multi = q
            .get("multiSelect")
            .or_else(|| q.get("multi_select"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        out.push(AskQuestionDto {
            question,
            options,
            multi_select: multi,
        });
    }
    out
}

fn skip_interview_json() -> Value {
    json!({ "outcome": "skip_interview" })
}

fn keep_planning_json() -> Value {
    json!({
        "outcome": "cancelled",
        "feedback": "Keep planning. Continue improving the plan yourself. Do not ask what should change."
    })
}

fn write_result(stdin: &mut ChildStdin, id: u64, result: Value) -> Result<(), String> {
    write_msg(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }),
    )
}

fn wait_user_payload(
    hub: &AcpHub,
    gate: &PermissionGate,
    gkey: &str,
    rx: &Receiver<String>,
    fallback: Value,
) -> Value {
    loop {
        if hub.is_cancelled() {
            if let Ok(mut g) = gate.lock() {
                g.remove(gkey);
            }
            return fallback;
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(v) => {
                if let Ok(parsed) = serde_json::from_str::<Value>(&v) {
                    return parsed;
                }
                return fallback;
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return fallback,
        }
    }
}

fn fail_result(
    on_event: &tauri::ipc::Channel<StreamEvent>,
    err: String,
    text: String,
    session_id: Option<String>,
) -> GrokRunResult {
    let err = clarify_grok_error(&err);
    send_event(on_event, "error", &err);
    send_event(on_event, "done", "");
    GrokRunResult {
        ok: false,
        text,
        error: Some(err),
        session_id,
    }
}

fn stop_result(
    on_event: &tauri::ipc::Channel<StreamEvent>,
    text: String,
    session_id: Option<String>,
) -> GrokRunResult {
    send_event(on_event, "status", "Stopped");
    send_event(on_event, "done", "stopped");
    GrokRunResult {
        ok: false,
        text,
        error: Some("Stopped.".into()),
        session_id,
    }
}

fn request_session_cancel(session: &mut LiveAcp) {
    let _ = write_msg(
        &mut session.stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session.session_id }
        }),
    );
}

impl LiveAcp {
    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn req(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        write_msg(
            &mut self.stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }),
        )?;
        Ok(id)
    }

    fn wait_result(&mut self, id: u64, timeout: Duration) -> Result<Value, String> {
        let end = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < end {
            let left = end.saturating_duration_since(std::time::Instant::now());
            match self.out_rx.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(msg) => {
                    if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                        if msg.get("id").is_some() {
                            self.answer_auth_server(&msg, method)?;
                            continue;
                        }
                        if let Some(cmds) = parse_available_commands(&msg) {
                            self.commands = cmds;
                        }
                        continue;
                    }
                    if rpc_id(&msg) == Some(id) {
                        if let Some(err) = msg.get("error") {
                            let m = err
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ACP error");
                            return Err(m.to_string());
                        }
                        return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("ACP connection closed.".into());
                }
            }
        }
        Err("Timed out waiting for ACP response.".into())
    }

    fn wait_mcp_auth(&mut self, id: u64, timeout: Duration) -> Result<(), String> {
        let pending = std::mem::take(&mut self.pending_server);
        for msg in pending {
            if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                if msg.get("id").is_some() {
                    self.answer_auth_server(&msg, method)?;
                }
            }
        }
        let end = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < end {
            let left = end.saturating_duration_since(std::time::Instant::now());
            match self.out_rx.recv_timeout(left.min(Duration::from_millis(250))) {
                Ok(msg) => {
                    if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                        if msg.get("id").is_some() {
                            self.answer_auth_server(&msg, method)?;
                        } else if let Some(url) = first_http_url(msg.get("params").unwrap_or(&Value::Null))
                        {
                            let low = method.to_ascii_lowercase();
                            if low.contains("elicit") || low.contains("auth") {
                                open_http_url(&url);
                            }
                        }
                        continue;
                    }
                    if rpc_id(&msg) == Some(id) {
                        if let Some(err) = msg.get("error") {
                            let m = err
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ACP error");
                            let data = err.get("data").and_then(|v| v.as_str()).unwrap_or("");
                            if data.is_empty() {
                                return Err(m.to_string());
                            }
                            return Err(format!("{m}: {data}"));
                        }
                        return Ok(());
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("ACP connection closed.".into());
                }
            }
        }
        Err("Sign-in timed out. Finish the page in the browser, then try again.".into())
    }

    fn answer_auth_server(&mut self, msg: &Value, method: &str) -> Result<(), String> {
        let Some(rid) = rpc_id(msg) else {
            return Ok(());
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        if method == "fs/read_text_file" {
            return auto_fs_read(&mut self.stdin, msg);
        }
        if method == "session/request_permission" {
            let opts = permission_opts_from(&params);
            return write_result(&mut self.stdin, rid, allow_once_result(&opts));
        }
        let low = method.to_ascii_lowercase();
        if let Some(url) = first_http_url(&params) {
            if low.contains("elicit") || low.contains("auth") || low.contains("url") {
                open_http_url(&url);
            }
        }
        write_result(&mut self.stdin, rid, json!({}))
    }

    fn apply_mode(&mut self, desk_mode: &str) -> Result<(), String> {
        let desk_mode = normalize_mode(desk_mode).to_string();
        let mode_id = acp_mode_id(&desk_mode);
        let id = self.req(
            "session/set_mode",
            json!({
                "sessionId": self.session_id,
                "modeId": mode_id,
            }),
        )?;
        self.wait_result(id, Duration::from_secs(15))?;
        self.desk_mode = desk_mode;
        Ok(())
    }

    /// Set ACP `model` and `thought_level` when provided.
    fn apply_model_effort(&mut self, model: Option<&str>, effort: Option<&str>) {
        if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
            let _ = write_msg(
                &mut self.stdin,
                &json!({
                    "jsonrpc": "2.0",
                    "method": "session/set_config_option",
                    "params": {
                        "sessionId": self.session_id,
                        "configId": "model",
                        "value": m
                    }
                }),
            );
        }
        if let Some(e) = effort.map(str::trim).filter(|s| !s.is_empty()) {
            let _ = write_msg(
                &mut self.stdin,
                &json!({
                    "jsonrpc": "2.0",
                    "method": "session/set_config_option",
                    "params": {
                        "sessionId": self.session_id,
                        "configId": "thought_level",
                        "value": e
                    }
                }),
            );
        }
    }

    fn shutdown(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for LiveAcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn remember_pid(hub: &AcpHub, session: Option<&LiveAcp>) {
    if let Some(s) = session {
        hub.set_child_pid(s.pid());
    } else {
        hub.clear_child_pid();
    }
}

fn auto_fs_read(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
    let path = msg
        .pointer("/params/path")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let rid = rpc_id(msg).unwrap_or(0);
    write_msg(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": rid,
            "result": { "content": content }
        }),
    )
}

fn spawn_agent(cwd: &str) -> Result<(Child, ChildStdin, Receiver<Value>), String> {
    let binary = ensure_grok_ready()?;
    // default so ~/.grok [ui] permission_mode = "always-approve" does not
    // swallow session/request_permission. Grotesque auto-allows tools.
    let mut cmd = Command::new(&binary);
    cmd.arg("--permission-mode")
        .arg("default")
        .arg("agent")
        .arg("stdio")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own group so Stop can SIGKILL the tree (`kill -9 -pid`).
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| clarify_grok_error(&format!("Failed to start grok agent: {e}")))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ACP stdin missing.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ACP stdout missing.".to_string())?;

    let (out_tx, out_rx): (SyncSender<Value>, Receiver<Value>) = mpsc::sync_channel(512);
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if out_tx.send(v).is_err() {
                    break;
                }
            }
        }
    });

    Ok((child, stdin, out_rx))
}

fn load_image_data(a: &AttachIn) -> Result<(String, String), String> {
    let mime = if a.mime.trim().is_empty() {
        "image/png".into()
    } else {
        a.mime.trim().to_string()
    };
    if let Some(data) = a.data.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        return Ok((mime, crate::strip_b64(data).to_string()));
    }
    let path = a
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing data for {}.", a.name))?;
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {}: {e}", a.name))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(format!("{} is too large (12 MB max).", a.name));
    }
    Ok((mime, crate::b64_encode(&bytes)))
}

/// Images are ACP image blocks. Other files are resource_link plus a path line in the text.
fn build_prompt_blocks(prompt: &str, attachments: &[AttachIn]) -> Result<Vec<Value>, String> {
    let mut text = prompt.trim().to_string();
    let mut images = Vec::new();
    let mut files = Vec::new();
    let mut img_n = 0u32;

    for a in attachments {
        if a.kind == "image" {
            img_n += 1;
            images.push({
                let (mime, data) = load_image_data(a)?;
                let mut block = json!({
                    "type": "image",
                    "mimeType": mime,
                    "data": data,
                });
                if let Some(p) = a.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    block["uri"] = json!(crate::file_uri(p));
                }
                block
            });
            let label = format!("[Image #{img_n}]");
            if !text.contains(&label) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&label);
            }
        } else if let Some(p) = a.path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            files.push(json!({
                "type": "resource_link",
                "uri": crate::file_uri(p),
                "name": a.name,
                "mimeType": if a.mime.is_empty() { "application/octet-stream" } else { a.mime.as_str() },
                "size": a.size.unwrap_or(0),
            }));
            if !text.contains(p) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(p);
            }
        }
    }

    if text.trim().is_empty() && images.is_empty() && files.is_empty() {
        return Err("Prompt is empty.".into());
    }

    let mut blocks = Vec::new();
    if !text.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    blocks.extend(images);
    blocks.extend(files);
    Ok(blocks)
}

fn work_dir(cwd: Option<&str>) -> String {
    cwd.map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

fn side_scratch_dir(chat_key: &str) -> Result<String, String> {
    let slug: String = chat_key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let slug = if slug.is_empty() {
        "side".into()
    } else {
        slug
    };
    let dir = std::env::temp_dir().join("grotesque-side").join(slug);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create side scratch folder: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Start a fresh ACP process, initialize, and open or resume a session.
fn start_live(
    cwd: &str,
    desk_mode: &str,
    resume_session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    elicitation: bool,
    hub: Option<&AcpHub>,
) -> Result<LiveAcp, String> {
    let (child, stdin, out_rx) = spawn_agent(cwd)?;
    if let Some(h) = hub {
        // Before initialize so Stop can kill during startup.
        h.set_child_pid(child.id());
    }
    let mut live = LiveAcp {
        child,
        stdin,
        out_rx,
        next_id: 1,
        session_id: String::new(),
        cwd: cwd.to_string(),
        desk_mode: normalize_mode(desk_mode).to_string(),
        pending_server: Vec::new(),
        commands: Vec::new(),
    };

    let mut caps = json!({
        "fs": { "readTextFile": true, "writeTextFile": false }
    });
    if elicitation {
        caps["elicitation"] = json!({ "form": {}, "url": {} });
    }
    let init_id = live.req(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": caps,
            "clientInfo": { "name": "grotesque", "version": "0.1.0" }
        }),
    )?;
    live.wait_result(init_id, Duration::from_secs(20))?;

    write_msg(
        &mut live.stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )?;

    // New sessions: yolo/auto off. Grotesque auto-allows tools. Plan uses session/set_mode.
    // Process already started with --permission-mode default (overrides config always-approve).
    let session_id = if let Some(sid) = resume_session_id.filter(|s| !s.is_empty()) {
        let id = live.req(
            "session/resume",
            json!({
                "sessionId": sid,
                "cwd": cwd,
                "_meta": {
                    "yoloMode": false,
                    "autoMode": false
                }
            }),
        )?;
        match live.wait_result(id, Duration::from_secs(60)) {
            Ok(_) => sid.to_string(),
            Err(e) => {
                return Err(format!(
                    "Could not open that chat. The session did not resume ({e})."
                ));
            }
        }
    } else {
        open_new_session(&mut live, cwd)?
    };

    live.session_id = session_id;

    live.apply_model_effort(model, effort);
    live.apply_mode(desk_mode)?;
    Ok(live)
}

const MCP_AUTH_TIMEOUT: Duration = Duration::from_secs(600);

fn first_http_url(v: &Value) -> Option<String> {
    match v {
        Value::String(s)
            if s.starts_with("https://")
                || s.starts_with("http://127.0.0.1")
                || s.starts_with("http://localhost") =>
        {
            Some(s.clone())
        }
        Value::Array(a) => a.iter().find_map(first_http_url),
        Value::Object(m) => {
            for key in [
                "url",
                "uri",
                "authorizationUrl",
                "authorization_url",
                "verification_uri",
                "authUrl",
            ] {
                if let Some(s) = m.get(key).and_then(|x| x.as_str()) {
                    if s.starts_with("http://") || s.starts_with("https://") {
                        return Some(s.to_string());
                    }
                }
            }
            m.values().find_map(first_http_url)
        }
        _ => None,
    }
}

fn open_http_url(url: &str) {
    let ok = url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost");
    if !ok {
        return;
    }
    let _ = Command::new("open").arg(url).status();
}

fn allow_once_result(opts: &[PermissionOptionDto]) -> Value {
    json!({
        "outcome": {
            "outcome": "selected",
            "optionId": pick_allow_option(opts)
        }
    })
}

fn permission_opts_from(params: &Value) -> Vec<PermissionOptionDto> {
    let options = params
        .get("options")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut opts = Vec::new();
    for o in options {
        opts.push(PermissionOptionDto {
            option_id: o
                .get("optionId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            name: o
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            kind: o
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    if opts.is_empty() {
        opts = vec![PermissionOptionDto {
            option_id: "allow-once".into(),
            name: "Allow once".into(),
            kind: "allow_once".into(),
        }];
    }
    opts
}

fn clarify_mcp_auth_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("does not use oauth") || lower.contains("does not support oauth") {
        return "This plugin does not use sign-in.".into();
    }
    if lower.contains("not found") && lower.contains("server") {
        return "That MCP server was not found.".into();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "Sign-in timed out. Finish the page in the browser, then try again.".into();
    }
    if lower.contains("not found") && (lower.contains("grok") || lower.contains("no such file")) {
        return clarify_grok_error(err);
    }
    if !err.trim().is_empty() {
        return err.trim().to_string();
    }
    "Sign-in failed.".into()
}

/// Start Grok MCP OAuth for one server. Opens the browser. Does not write credentials.
pub fn sign_in_mcp(name: &str, cwd: &str) -> Result<(), String> {
    if !crate::grok_adapter::valid_mcp_name(name) {
        return Err("That MCP name is not valid.".into());
    }
    let work = work_dir(Some(cwd));
    let mut live = start_live(&work, "bypass", None, None, None, true, None)?;
    let id = match live.req(
        "_x.ai/mcp/auth_trigger",
        json!({
            "session_id": live.session_id,
            "server_name": name,
        }),
    ) {
        Ok(id) => id,
        Err(e) => {
            live.shutdown();
            return Err(clarify_mcp_auth_error(&e));
        }
    };
    let out = live.wait_mcp_auth(id, MCP_AUTH_TIMEOUT);
    live.shutdown();
    out.map_err(|e| clarify_mcp_auth_error(&e))
}

fn open_new_session(live: &mut LiveAcp, cwd: &str) -> Result<String, String> {
    let id = live.req(
        "session/new",
        json!({
            "cwd": cwd,
            "mcpServers": [],
            "_meta": {
                "yoloMode": false,
                "autoMode": false
            }
        }),
    )?;
    let session_val = live.wait_result(id, Duration::from_secs(60))?;
    let session_id = session_val
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return Err("ACP session/new returned no sessionId.".into());
    }
    Ok(session_id)
}

/// Apply Grotesque run mode without waiting on the live turn lock.
pub fn set_desk_mode(pool: &AcpLive, chat_key: &str, mode: &str) -> Result<(), String> {
    let hub = pool.hub_for(chat_key)?;
    let mode = normalize_mode(mode).to_string();
    hub.set_mode(&mode);
    if let Ok(mut g) = hub.live.try_lock() {
        if let Some(s) = g.as_mut() {
            if s.is_alive() {
                s.apply_mode(&mode)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachIn {
    pub path: Option<String>,
    pub name: String,
    pub mime: String,
    pub kind: String,
    pub data: Option<String>,
    pub size: Option<u64>,
}

const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

/// Run one prompt on the agent for `chat_key` (own process per chat).
pub fn run_prompt(
    app: &AppHandle,
    gate: &PermissionGate,
    pool: &AcpLive,
    on_event: &tauri::ipc::Channel<StreamEvent>,
    chat_key: &str,
    prompt: &str,
    attachments: &[AttachIn],
    cwd: Option<&str>,
    mode: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    resume_session_id: Option<&str>,
    force_new: bool,
) -> GrokRunResult {
    let prompt = prompt.trim();
    let blocks = match build_prompt_blocks(prompt, attachments) {
        Ok(b) => b,
        Err(e) => return fail_result(on_event, e, String::new(), None),
    };
    if chat_key.trim().is_empty() {
        return fail_result(on_event, "Missing chat key.".into(), String::new(), None);
    }

    let hub = match pool.hub_for(chat_key) {
        Ok(h) => h,
        Err(e) => return fail_result(on_event, e, String::new(), None),
    };
    hub.clear_cancel();
    hub.set_busy(true);
    struct BusyClear<'a>(&'a AcpHub);
    impl Drop for BusyClear<'_> {
        fn drop(&mut self) {
            self.0.set_busy(false);
        }
    }
    let _busy = BusyClear(&hub);

    let work = if is_side_chat(chat_key) {
        match side_scratch_dir(chat_key) {
            Ok(d) => d,
            Err(e) => {
                return fail_result(on_event, e, String::new(), None);
            }
        }
    } else {
        work_dir(cwd)
    };
    let desk_mode = normalize_mode(mode.unwrap_or("auto")).to_string();
    hub.set_mode(&desk_mode);
    let wanted_sid = if force_new {
        None
    } else {
        resume_session_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    {
        let mut g = match hub.live.lock() {
            Ok(g) => g,
            Err(_) => {
                return fail_result(
                    on_event,
                    "ACP session lock poisoned.".into(),
                    String::new(),
                    None,
                );
            }
        };

        let needs_new = {
            if force_new {
                true
            } else {
                match g.as_mut() {
                    None => true,
                    Some(s) => {
                        if !s.is_alive() {
                            true
                        } else if s.cwd != work {
                            true
                        } else {
                            match &wanted_sid {
                                Some(want) if want != &s.session_id => true,
                                _ => false,
                            }
                        }
                    }
                }
            }
        };

        if needs_new {
            if let Some(old) = g.take() {
                old.shutdown();
            }
            let resume = if force_new {
                None
            } else {
                wanted_sid.as_deref()
            };
            let status = if force_new || resume.is_none() {
                format!("Starting new chat ({desk_mode})…")
            } else {
                format!("Opening chat ({desk_mode})…")
            };
            send_event(on_event, "status", status);
            match start_live(&work, &desk_mode, resume, model, effort, false, Some(&hub)) {
                Ok(s) => {
                    hub.set_child_pid(s.pid());
                    *g = Some(s);
                }
                Err(e) => {
                    hub.clear_child_pid();
                    if hub.is_cancelled() {
                        return stop_result(on_event, String::new(), None);
                    }
                    return fail_result(on_event, e, String::new(), None);
                }
            }
            if hub.is_cancelled() {
                if let Some(s) = g.take() {
                    s.shutdown();
                }
                hub.clear_child_pid();
                return stop_result(on_event, String::new(), None);
            }
        } else if let Some(s) = g.as_mut() {
            hub.set_child_pid(s.pid());
            s.apply_model_effort(model, effort);
            if s.desk_mode != desk_mode {
                if let Err(e) = s.apply_mode(&desk_mode) {
                    send_event(on_event, "status", format!("Mode switch note: {e}"));
                }
            }
            send_event(
                on_event,
                "status",
                format!("Continuing session ({desk_mode})…"),
            );
        }
    }

    let mut g = match hub.live.lock() {
        Ok(g) => g,
        Err(_) => {
            return fail_result(
                on_event,
                "ACP session lock poisoned.".into(),
                String::new(),
                None,
            );
        }
    };
    if g.as_ref().is_none() {
        hub.clear_child_pid();
        return fail_result(on_event, "No ACP session.".into(), String::new(), None);
    }

    remember_pid(&hub, g.as_ref());
    if hub.is_cancelled() {
        if let Some(s) = g.take() {
            s.shutdown();
        }
        hub.clear_child_pid();
        return stop_result(on_event, String::new(), None);
    }
    let session_id = g.as_ref().unwrap().session_id.clone();

    {
        let mode_now = g.as_ref().unwrap().desk_mode.as_str();
        if mode_now == "plan" {
            send_event(on_event, "status", "Plan mode on (no normal file edits)…");
        } else {
            send_event(on_event, "status", "Tools auto-approved for this mode…");
        }
    }

    {
        let cmds = g.as_ref().unwrap().commands.clone();
        if !cmds.is_empty() {
            send_event(on_event, "commands", json!(cmds).to_string());
        }
    }

    let prompt_id = {
        let session = g.as_mut().unwrap();
        match session.req(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": blocks
            }),
        ) {
            Ok(i) => i,
            Err(e) => {
                let sid = Some(session_id.clone());
                if let Some(s) = g.take() {
                    s.shutdown();
                }
                return fail_result(on_event, e, String::new(), sid);
            }
        }
    };

    let mut accumulated = String::new();

    let pending = {
        let session = g.as_mut().unwrap();
        std::mem::take(&mut session.pending_server)
    };
    for msg in pending {
        if hub.is_cancelled() {
            break;
        }
        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            if rpc_id(&msg).is_some() {
                let session = g.as_mut().unwrap();
                if let Err(e) = handle_server_request(
                    app,
                    gate,
                    on_event,
                    &mut session.stdin,
                    &msg,
                    method,
                    &mut session.desk_mode,
                    &hub,
                    chat_key,
                ) {
                    send_event(on_event, "status", e);
                }
            }
        }
    }

    loop {
        if hub.is_cancelled() {
            hub.clear_child_pid();
            if let Some(mut s) = g.take() {
                request_session_cancel(&mut s);
                s.shutdown();
            }
            return stop_result(on_event, accumulated, Some(session_id));
        }

        let poll = {
            let session = match g.as_mut() {
                Some(s) => s,
                None => break,
            };
            match session.out_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(v) => Ok(v),
                Err(RecvTimeoutError::Timeout) => {
                    if session.is_alive() {
                        Err("timeout_alive")
                    } else {
                        Err("dead")
                    }
                }
                Err(RecvTimeoutError::Disconnected) => Err("disconnected"),
            }
        };

        let msg = match poll {
            Ok(v) => v,
            Err("timeout_alive") => continue,
            Err("dead") | Err("disconnected") => {
                let _ = g.take();
                hub.clear_child_pid();
                if hub.is_cancelled() {
                    return stop_result(on_event, accumulated, Some(session_id));
                }
                return fail_result(
                    on_event,
                    "The agent process stopped. This chat is still the same session.".into(),
                    accumulated,
                    Some(session_id),
                );
            }
            Err(_) => break,
        };

        if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
            if msg.get("id").is_some() {
                let session = g.as_mut().unwrap();
                if let Err(e) = handle_server_request(
                    app,
                    gate,
                    on_event,
                    &mut session.stdin,
                    &msg,
                    method,
                    &mut session.desk_mode,
                    &hub,
                    chat_key,
                ) {
                    send_event(on_event, "status", e);
                }
                continue;
            }
            if is_session_update_method(method) && is_this_session(&msg, &session_id) {
                handle_session_update(on_event, &msg, &mut accumulated);
            }
            continue;
        }

        if rpc_id(&msg) == Some(prompt_id) {
            if let Some(err) = msg.get("error") {
                let e = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("ACP prompt failed")
                    .to_string();
                return fail_result(on_event, e, accumulated, Some(session_id));
            }
            break;
        }
    }

    if hub.is_cancelled() {
        hub.clear_child_pid();
        if let Some(mut s) = g.take() {
            request_session_cancel(&mut s);
            s.shutdown();
        }
        return stop_result(on_event, accumulated, Some(session_id));
    }

    if let Some(s) = g.as_mut() {
        hub.set_child_pid(s.pid());
        let want = hub.mode();
        if s.desk_mode != want {
            let _ = s.apply_mode(&want);
        }
    }

    send_event(on_event, "done", "");
    GrokRunResult {
        ok: true,
        text: accumulated,
        error: None,
        session_id: Some(session_id),
    }
}

fn parse_available_commands(msg: &Value) -> Option<Vec<SlashCmd>> {
    let update = msg.pointer("/params/update")?;
    let kind = update.get("sessionUpdate").and_then(|v| v.as_str())?;
    if kind != "available_commands_update" {
        return None;
    }
    let arr = update
        .get("availableCommands")
        .or_else(|| update.get("available_commands"))?
        .as_array()?;
    let mut out = Vec::new();
    for c in arr {
        let raw = c.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if raw.is_empty() {
            continue;
        }
        let name = raw.trim_start_matches('/').to_string();
        let description = c
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        out.push(SlashCmd { name, description });
    }
    Some(out)
}

fn emit_usage(on_event: &tauri::ipc::Channel<StreamEvent>, msg: &Value, update: &Value, kind: &str) {
    if kind == "usage_update" {
        if let Some(used) = json_u64(update.get("used")) {
            let size = json_u64(update.get("size"));
            send_event(on_event, "usage", json!({ "used": used, "size": size }).to_string());
        }
        return;
    }
    let used = json_u64(msg.pointer("/_meta/totalTokens"))
        .or_else(|| json_u64(msg.pointer("/params/_meta/totalTokens")))
        .or_else(|| json_u64(update.pointer("/_meta/totalTokens")));
    if let Some(used) = used {
        send_event(on_event, "usage", json!({ "used": used }).to_string());
    }
}

fn raw_input_str(update: &Value, keys: &[&str]) -> Option<String> {
    let input = update.get("rawInput")?;
    for key in keys {
        if let Some(s) = input.get(*key).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn first_tool_path(update: &Value) -> Option<String> {
    if let Some(arr) = update.get("locations").and_then(|v| v.as_array()) {
        for loc in arr {
            if let Some(p) = loc.get("path").and_then(|v| v.as_str()) {
                if !p.is_empty() {
                    return Some(p.to_string());
                }
            }
        }
    }
    update
        .get("rawInput")
        .and_then(|input| nested_str(input, PATH_KEYS))
}

fn first_tool_query(update: &Value) -> Option<String> {
    let raw = update.get("rawInput").and_then(nested_raw_target);
    let name = first_tool_mcp_name(update)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let n = tool_meta_name(update);
            if n.is_empty() {
                None
            } else {
                Some(n)
            }
        })
        .unwrap_or_default();
    humanize_mcp_query(&name, raw)
}

fn raw_input_u64(update: &Value, key: &str) -> Option<u64> {
    json_u64(update.get("rawInput").and_then(|v| v.get(key)))
}

fn first_tool_span(update: &Value) -> Option<String> {
    let kind = update
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let variant = update
        .pointer("/rawInput/variant")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let title = update
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_read = kind == "read"
        || variant.eq_ignore_ascii_case("ReadFile")
        || title.starts_with("read");
    if !is_read {
        return None;
    }
    if first_tool_path(update)
        .as_deref()
        .is_some_and(is_image_path)
    {
        return None;
    }
    Some(format_read_span(
        raw_input_u64(update, "offset"),
        raw_input_u64(update, "limit"),
    ))
}

fn first_tool_command(update: &Value) -> Option<String> {
    raw_input_str(update, &["command", "cmd"])
}

fn is_use_tool_update(update: &Value) -> bool {
    let variant = update
        .pointer("/rawInput/variant")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = update
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let title = update
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    variant.contains("usetool")
        || kind.contains("use_tool")
        || title == "use"
        || title.contains("use_tool")
}

fn first_tool_mcp_name(update: &Value) -> Option<String> {
    if let Some(n) = update
        .pointer("/_meta/mcp/tool")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(n.to_string());
    }
    if !is_use_tool_update(update) {
        return None;
    }
    const KEYS: &[&str] = &["toolName", "tool_name", "tool"];
    update
        .get("rawInput")
        .and_then(|input| nested_str(input, KEYS))
}

fn mcp_server_from_name(name: &str) -> Option<String> {
    let (left, right) = name.split_once("__")?;
    if left.is_empty() || right.is_empty() {
        return None;
    }
    Some(left.to_string())
}

fn first_tool_server(update: &Value) -> Option<String> {
    if let Some(n) = update
        .pointer("/_meta/mcp/server")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(n.to_string());
    }
    const KEYS: &[&str] = &[
        "server",
        "serverName",
        "server_name",
        "mcpServer",
        "mcp_server",
    ];
    update
        .get("rawInput")
        .and_then(|input| nested_str(input, KEYS))
        .or_else(|| first_tool_mcp_name(update).and_then(|n| mcp_server_from_name(&n)))
}

fn first_tool_todos(update: &Value) -> Option<(bool, Vec<Value>)> {
    let input = update.get("rawInput")?;
    let arr = input.get("todos")?.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let merge = input.get("merge").and_then(|v| v.as_bool()).unwrap_or(true);
    Some((merge, arr.clone()))
}

fn is_web_update(update: &Value) -> bool {
    let kind = update
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let title = update
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let variant = update
        .pointer("/rawInput/variant")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    kind.contains("web_search")
        || kind.contains("web-search")
        || kind.contains("web_fetch")
        || kind.contains("webfetch")
        || variant == "websearch"
        || variant.contains("webfetch")
        || variant.contains("openpage")
        || title.starts_with("web search")
        || title.starts_with("opened page")
        || title.starts_with("open page")
}

fn first_tool_web(update: &Value) -> Option<(String, Vec<String>)> {
    if !is_web_update(update) {
        return None;
    }
    let action = update.pointer("/rawOutput/action")?;
    let query = action
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let urls = urls_from(action);
    if query.is_empty() && urls.is_empty() {
        None
    } else {
        Some((query, urls))
    }
}

fn first_tool_text(update: &Value) -> Option<String> {
    if let Some(s) = update.get("content").and_then(|v| v.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    let arr = update.get("content").and_then(|v| v.as_array())?;
    let mut out = String::new();
    for item in arr {
        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
            let t = t.trim();
            if t.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(t);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn parse_subagent_id(text: &str) -> Option<String> {
    for key in ["subagent_id:", "session_id:", "sessionId:"] {
        if let Some(rest) = text.split(key).nth(1) {
            let id = rest
                .split(|c: char| c.is_whitespace() || c == '"' || c == ',')
                .find(|s| !s.is_empty())
                .unwrap_or("")
                .trim_matches(['"', '\'', '`']);
            if id.len() >= 8 {
                return Some(id.to_string());
            }
        }
    }
    None
}

fn first_tool_subagent(update: &Value) -> Option<(String, String, String)> {
    let desc = raw_input_str(update, &["description"]).unwrap_or_default();
    let typ = raw_input_str(update, &["subagent_type", "subagentType"]).unwrap_or_default();
    let mut id = raw_input_str(
        update,
        &[
            "subagent_id",
            "subagentId",
            "sessionId",
            "session_id",
            "child_session_id",
            "task_id",
            "taskId",
        ],
    )
    .unwrap_or_default();
    if id.is_empty() {
        if let Some(text) = first_tool_text(update) {
            if let Some(found) = parse_subagent_id(&text) {
                id = found;
            }
        }
    }
    let title = update
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = update
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let variant = update
        .pointer("/rawInput/variant")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = tool_meta_name(update).to_ascii_lowercase();
    let spawnish = name.contains("spawn")
        || title.contains("subagent")
        || title.contains("spawn")
        || kind.contains("spawn")
        || variant == "task"
        || !typ.is_empty()
        || !id.is_empty();
    if !spawnish || name.contains("subagent_output") || variant == "taskoutput" {
        return None;
    }
    Some((id, desc, typ))
}

fn emit_subagent_event(on_event: &tauri::ipc::Channel<StreamEvent>, update: &Value, live: bool) {
    let id = update
        .get("subagent_id")
        .or_else(|| update.get("child_session_id"))
        .or_else(|| update.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if id.is_empty() {
        return;
    }
    let label = update
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let typ = update
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let raw_status = update
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let status = if live {
        "running"
    } else if raw_status == "failed" || raw_status == "error" || raw_status == "cancelled" {
        "failed"
    } else {
        "done"
    };
    send_event(
        on_event,
        "sub",
        json!({
            "id": id,
            "label": label,
            "type": typ,
            "status": status,
        })
        .to_string(),
    );
}

fn first_tool_diff(update: &Value) -> Option<Value> {
    if let Some(arr) = update.get("content").and_then(|v| v.as_array()) {
        for item in arr {
            if item.get("type").and_then(|v| v.as_str()) != Some("diff") {
                continue;
            }
            let path = item
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut diff = json!({ "path": path });
            if let Some(old) = item.get("oldText").and_then(|v| v.as_str()) {
                diff["old"] = json!(clip_str(old, 12_000));
            }
            if let Some(new) = item.get("newText").and_then(|v| v.as_str()) {
                diff["new"] = json!(clip_str(new, 12_000));
            }
            return Some(diff);
        }
    }
    let input = update.get("rawInput")?;
    let old = input
        .get("old_string")
        .or_else(|| input.get("oldText"))
        .and_then(|v| v.as_str());
    let new = input
        .get("new_string")
        .or_else(|| input.get("newText"))
        .and_then(|v| v.as_str());
    if old.is_none() && new.is_none() {
        return None;
    }
    let path = first_tool_path(update).unwrap_or_default();
    let mut diff = json!({ "path": path });
    if let Some(o) = old {
        diff["old"] = json!(clip_str(o, 12_000));
    }
    if let Some(n) = new {
        diff["new"] = json!(clip_str(n, 12_000));
    }
    Some(diff)
}

fn handle_session_update(
    on_event: &tauri::ipc::Channel<StreamEvent>,
    msg: &Value,
    accumulated: &mut String,
) {
    let none = Value::Null;
    let update = msg.pointer("/params/update").unwrap_or(&none);
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    emit_usage(on_event, msg, update, kind);
    if let Some(cmds) = parse_available_commands(msg) {
        send_event(on_event, "commands", json!(cmds).to_string());
    }

    match kind {
        "agent_message_chunk" => {
            if let Some(text) = update.pointer("/content/text").and_then(|v| v.as_str()) {
                accumulated.push_str(text);
                send_event(on_event, "text", text);
            }
        }
        "agent_thought_chunk" => {
            if let Some(text) = update.pointer("/content/text").and_then(|v| v.as_str()) {
                send_event(on_event, "thought", text);
            }
        }
        "tool_call" | "tool_call_update" => {
            let id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = update
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool_kind = update
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut payload = json!({
                "id": id,
                "title": title,
                "status": status,
                "kind": tool_kind,
            });
            if let Some(n) = first_tool_mcp_name(update) {
                payload["name"] = json!(n);
            } else {
                let tool_name = tool_meta_name(update);
                if !tool_name.is_empty() {
                    payload["name"] = json!(tool_name);
                }
            }
            if let Some(path) = first_tool_path(update) {
                payload["path"] = json!(path);
            }
            if let Some(span) = first_tool_span(update) {
                payload["span"] = json!(span);
            }
            if let Some(diff) = first_tool_diff(update) {
                payload["diff"] = diff;
            }
            if let Some(variant) = update
                .pointer("/rawInput/variant")
                .and_then(|v| v.as_str())
            {
                payload["variant"] = json!(variant);
            }
            if let Some(server) = first_tool_server(update) {
                payload["server"] = json!(server);
            }
            if let Some((merge, todos)) = first_tool_todos(update) {
                payload["todos"] = json!(todos);
                payload["todosMerge"] = json!(merge);
            }
            if let Some((sid, desc, typ)) = first_tool_subagent(update) {
                if !sid.is_empty() {
                    payload["sessionId"] = json!(sid);
                }
                if !desc.is_empty() {
                    payload["description"] = json!(desc);
                }
                if !typ.is_empty() {
                    payload["subagentType"] = json!(typ);
                }
            }
            if let Some((query, urls)) = first_tool_web(update) {
                if !query.is_empty() {
                    payload["query"] = json!(query);
                }
                if !urls.is_empty() {
                    payload["urls"] = json!(urls);
                }
            } else if let Some(q) = first_tool_query(update) {
                payload["query"] = json!(q);
            } else if let Some(q) = first_tool_command(update) {
                payload["query"] = json!(q);
            } else if let Some(q) = update.get("rawInput").and_then(ask_header) {
                payload["query"] = json!(q);
            } else if let Some(q) = title
                .strip_prefix("Web search:")
                .or_else(|| title.strip_prefix("X search:"))
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                payload["query"] = json!(q);
            }
            send_event(on_event, "tool", payload.to_string());
        }
        "current_mode_update" => {
            if let Some(mid) = update.get("currentModeId").and_then(|v| v.as_str()) {
                send_event(on_event, "status", format!("Mode: {mid}"));
            }
        }
        "subagent_spawned" => emit_subagent_event(on_event, update, true),
        "subagent_finished" => emit_subagent_event(on_event, update, false),
        "auto_compact_started" => send_event(on_event, "compact", "start"),
        "auto_compact_completed" | "auto_compact_cancelled" => {
            send_event(on_event, "compact", "done")
        }
        _ => {}
    }
}

fn handle_server_request(
    app: &AppHandle,
    gate: &PermissionGate,
    on_event: &tauri::ipc::Channel<StreamEvent>,
    stdin: &mut ChildStdin,
    msg: &Value,
    method: &str,
    desk_mode: &mut String,
    hub: &AcpHub,
    chat_key: &str,
) -> Result<(), String> {
    let id = rpc_id(msg).ok_or_else(|| "server request missing id".to_string())?;

    match method {
        "session/request_permission" => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let title = params
                .pointer("/toolCall/title")
                .and_then(|v| v.as_str())
                .unwrap_or("Grok wants to run a tool");
            let opts = permission_opts_from(&params);
            // Question tool: auto-allow so the elicitation card is the only prompt.
            let status = if is_ask_user_perm(&params) {
                "Question from Grok…".to_string()
            } else {
                format!("Auto-allowed ({desk_mode}): {title}")
            };
            write_result(stdin, id, allow_once_result(&opts))?;
            send_event(on_event, "status", status);
            Ok(())
        }
        method if is_ask_user_method(method) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let questions = parse_questions(&params);
            if questions.is_empty() {
                write_result(stdin, id, skip_interview_json())?;
                send_event(on_event, "status", "Empty question — skipped.");
                return Ok(());
            }
            if is_side_chat(chat_key) {
                write_result(stdin, id, skip_interview_json())?;
                send_event(on_event, "status", "Side chat skipped a question.");
                return Ok(());
            }
            let (tx, rx) = mpsc::sync_channel::<String>(1);
            let gkey = perm_key(chat_key, id);
            {
                let mut g = gate.lock().map_err(|_| "permission gate lock".to_string())?;
                g.insert(gkey.clone(), tx);
            }
            let dto = QuestionRequestDto {
                id,
                chat_key: chat_key.to_string(),
                questions,
            };
            let _ = app.emit("grok-question", dto);
            send_event(on_event, "status", "Waiting for your answer…");
            let result = wait_user_payload(hub, gate, &gkey, &rx, skip_interview_json());
            write_result(stdin, id, result)?;
            send_event(on_event, "status", "Answer sent.");
            Ok(())
        }
        method if is_exit_plan_method(method) => {
            let params = msg.get("params").cloned().unwrap_or(Value::Null);
            let plan_content = params
                .get("planContent")
                .or_else(|| params.get("plan_content"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if is_side_chat(chat_key) {
                write_result(stdin, id, keep_planning_json())?;
                send_event(on_event, "status", "Side chat left the plan open.");
                return Ok(());
            }
            let (tx, rx) = mpsc::sync_channel::<String>(1);
            let gkey = perm_key(chat_key, id);
            {
                let mut g = gate.lock().map_err(|_| "permission gate lock".to_string())?;
                g.insert(gkey.clone(), tx);
            }
            let dto = PlanRequestDto {
                id,
                chat_key: chat_key.to_string(),
                plan_content,
            };
            let _ = app.emit("grok-plan", dto);
            send_event(on_event, "status", "Plan ready for review…");
            let result = wait_user_payload(hub, gate, &gkey, &rx, keep_planning_json());
            if result.get("outcome").and_then(|v| v.as_str()) == Some("approved") {
                *desk_mode = "auto".into();
                hub.set_mode("auto");
                let _ = app.emit(
                    "grok-mode",
                    ModeChangeDto {
                        chat_key: chat_key.to_string(),
                        mode: "auto".into(),
                    },
                );
            }
            write_result(stdin, id, result)?;
            send_event(on_event, "status", "Plan answer sent.");
            Ok(())
        }
        "fs/read_text_file" => auto_fs_read(stdin, msg),
        other => write_msg(
            stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Method not supported by Grotesque: {other}")
                }
            }),
        ),
    }
}

fn pick_allow_option(opts: &[PermissionOptionDto]) -> String {
    if let Some(o) = opts.iter().find(|o| {
        o.option_id == "allow-once" || o.kind == "allow_once" || o.option_id.contains("allow-once")
    }) {
        return o.option_id.clone();
    }
    if let Some(o) = opts.iter().find(|o| {
        o.option_id.contains("allow") && !o.option_id.contains("session") && !o.option_id.contains("always")
    }) {
        return o.option_id.clone();
    }
    "allow-once".into()
}

#[cfg(test)]
mod tests {
    use super::{is_this_session, session_update_id};
    use serde_json::json;

    #[test]
    fn paints_this_chat_and_skips_child_updates() {
        let sid = "sess-parent";
        let ours = json!({
            "method": "session/update",
            "params": {
                "sessionId": sid,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "Ask $5,500." }
                }
            }
        });
        let child = json!({
            "method": "session/update",
            "params": {
                "sessionId": "sess-child",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "{\"claims\":[]}" }
                }
            }
        });
        let legacy = json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": "Ask $5,500." }
                }
            }
        });
        assert!(is_this_session(&ours, sid));
        assert!(!is_this_session(&child, sid));
        assert!(is_this_session(&legacy, sid));
        assert_eq!(session_update_id(&ours), Some(sid));
        assert_eq!(session_update_id(&legacy), None);
    }
}
