//! Grok session metadata and chat history from disk (`~/.grok/sessions`).

use crate::mcp_target::{
    ask_header, clip_str, format_read_span, humanize_mcp_query, is_image_path, json_u64,
    nested_str, nested_target, urls_from, PATH_KEYS,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufRead, BufReader};
#[cfg(test)]
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPart {
    /// `text` | `tool` | `thought`
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<HistoryTodo>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub todos_merge: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTodo {
    pub id: String,
    pub content: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub used: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    /// `user` | `assistant`
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<HistoryPart>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<HistoryAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worked_secs: Option<u64>,
    /// Unix ms. From rewind points when the chat JSONL has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAttachment {
    pub name: String,
    pub mime: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

fn encode_cwd(cwd: &str) -> String {
    cwd.trim_end_matches('/').replace('/', "%2F")
}

fn sessions_dir_for_cwd(cwd: &str) -> Result<PathBuf, String> {
    Ok(sessions_root()?.join(encode_cwd(cwd)))
}

fn session_dir(cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    Ok(sessions_dir_for_cwd(cwd)?.join(session_id))
}

fn session_id_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return vec![];
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        if id.len() < 8 {
            continue;
        }
        out.push((id, path));
    }
    out
}

/// Newest first.
pub fn list_sessions(cwd: &str) -> Result<Vec<SessionInfo>, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Ok(vec![]);
    }
    let root = sessions_dir_for_cwd(cwd)?;
    if !root.is_dir() {
        return Ok(vec![]);
    }

    let mut items: Vec<SessionInfo> = Vec::new();
    for (id, path) in session_id_dirs(&root) {
        let hist_path = path.join("chat_history.jsonl");
        let updates_path = path.join("updates.jsonl");
        if !session_has_user_prompt_file(&hist_path)
            && !session_has_user_prompt_updates(&updates_path)
        {
            continue;
        }

        let summary_path = path.join("summary.json");
        if !summary_path.is_file() {
            items.push(SessionInfo {
                session_id: id,
                title: "Chat".into(),
                updated_at: String::new(),
            });
            continue;
        }

        let raw = fs::read_to_string(&summary_path).unwrap_or_default();
        let val: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        if val.get("session_kind").and_then(|v| v.as_str()) == Some("subagent") {
            continue;
        }
        let title = val
            .get("generated_title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Chat")
            .to_string();
        let updated_at = val
            .get("updated_at")
            .or_else(|| val.get("last_active_at"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        items.push(SessionInfo {
            session_id: id,
            title,
            updated_at,
        });
    }

    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

/// Latest context fill from `signals.json` (0/0 if the file is missing).
pub fn load_usage(cwd: &str, session_id: &str) -> Result<SessionUsage, String> {
    let path = session_dir(cwd, session_id)?.join("signals.json");
    if !path.is_file() {
        return Ok(SessionUsage { used: 0, size: 0 });
    }
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let val: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok(SessionUsage {
        used: json_u64(val.get("contextTokensUsed")).unwrap_or(0),
        size: json_u64(val.get("contextWindowTokens")).unwrap_or(0),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTokens {
    pub day: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    pub lifetime_tokens: u64,
    pub peak_tokens: u64,
    pub longest_chat_secs: u64,
    /// `YYYY-MM-DD` activity days (summary dates plus token days).
    pub days: Vec<String>,
    pub daily: Vec<DayTokens>,
}

fn sessions_root() -> Result<PathBuf, String> {
    crate::grok_adapter::grok_home()
        .map(|h| h.join("sessions"))
        .ok_or_else(|| "HOME is not set.".to_string())
}

fn turn_unix(val: &Value) -> Option<u64> {
    let n = json_u64(val.get("timestamp")).or_else(|| {
        json_u64(
            val.pointer("/params/update/_meta/agentTimestampMs")
                .or_else(|| val.pointer("/params/_meta/agentTimestampMs")),
        )
    })?;
    Some(if n > 10_000_000_000 { n / 1000 } else { n })
}

/// UTC Y-M-D from days since 1970-01-01 (no chrono).
fn civil_from_unix_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

fn day_from_unix(secs: u64) -> Option<String> {
    let (y, m, d) = civil_from_unix_days((secs / 86400) as i64);
    if !(1970..=2100).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn local_utc_offset_secs() -> i64 {
    static OFFSET: OnceLock<i64> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        parse_tz_offset(out.trim())
    })
}

fn parse_tz_offset(s: &str) -> i64 {
    if s.len() < 5 {
        return 0;
    }
    let sign = if s.starts_with('-') { -1 } else { 1 };
    let digits = s.trim_start_matches(['+', '-']);
    if digits.len() < 4 {
        return 0;
    }
    let h: i64 = digits[..2].parse().unwrap_or(0);
    let m: i64 = digits[2..4].parse().unwrap_or(0);
    sign * (h * 3600 + m * 60)
}

fn local_day_from_unix(secs: u64) -> Option<String> {
    let adjusted = (secs as i64).saturating_add(local_utc_offset_secs());
    if adjusted < 0 {
        return None;
    }
    day_from_unix(adjusted as u64)
}

/// Deltas of session-cumulative `turn_completed.usage.totalTokens`, by local day.
fn fold_session_updates(path: &Path, daily: &mut BTreeMap<String, u64>) -> Option<u64> {
    if !path.is_file() {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut prev = 0u64;
    let mut last = None;
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        if !line.contains("turn_completed") || !line.contains("totalTokens") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(upd) = val.get("params").and_then(|p| p.get("update")) else {
            continue;
        };
        if upd.get("sessionUpdate").and_then(|v| v.as_str()) != Some("turn_completed") {
            continue;
        }
        let Some(total) = json_u64(upd.get("usage").and_then(|u| u.get("totalTokens"))) else {
            continue;
        };
        let delta = total.saturating_sub(prev);
        prev = total;
        last = Some(total);
        if delta == 0 {
            continue;
        }
        if let Some(day) = turn_unix(&val).and_then(local_day_from_unix) {
            *daily.entry(day).or_insert(0) += delta;
        }
    }
    last
}

fn session_duration_secs(path: &Path) -> u64 {
    let Ok(raw) = fs::read_to_string(path) else {
        return 0;
    };
    let val: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    json_u64(val.get("sessionDurationSeconds")).unwrap_or(0)
}

fn day_prefix(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() < 10 {
        return None;
    }
    let day = &s[..10];
    if day.as_bytes()[4] != b'-' || day.as_bytes()[7] != b'-' {
        return None;
    }
    if !day.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return None;
    }
    Some(day.to_string())
}

fn session_day(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let val: Value = serde_json::from_str(&raw).ok()?;
    for key in ["last_active_at", "updated_at", "created_at"] {
        if let Some(raw) = val.get(key).and_then(|v| v.as_str()) {
            if let Some(day) = iso_to_unix(raw).and_then(local_day_from_unix) {
                return Some(day);
            }
            if let Some(day) = day_prefix(raw) {
                return Some(day);
            }
        }
    }
    None
}

fn empty_usage_stats() -> UsageStats {
    UsageStats {
        lifetime_tokens: 0,
        peak_tokens: 0,
        longest_chat_secs: 0,
        days: vec![],
        daily: vec![],
    }
}

pub fn load_usage_stats() -> Result<UsageStats, String> {
    let root = sessions_root()?;
    let mut lifetime = 0u64;
    let mut peak = 0u64;
    let mut longest = 0u64;
    let mut days = BTreeSet::new();
    let mut daily = BTreeMap::new();
    if !root.is_dir() {
        return Ok(empty_usage_stats());
    }
    let projects = fs::read_dir(&root).map_err(|e| format!("Cannot read sessions: {e}"))?;
    for proj in projects.flatten() {
        let proj = proj.path();
        if !proj.is_dir() {
            continue;
        }
        for (_id, p) in session_id_dirs(&proj) {
            if let Some(tok) = fold_session_updates(&p.join("updates.jsonl"), &mut daily) {
                lifetime = lifetime.saturating_add(tok);
                if tok > peak {
                    peak = tok;
                }
            }
            let secs = session_duration_secs(&p.join("signals.json"));
            if secs > longest {
                longest = secs;
            }
            if let Some(day) = session_day(&p.join("summary.json")) {
                days.insert(day);
            }
        }
    }
    for day in daily.keys() {
        days.insert(day.clone());
    }
    Ok(UsageStats {
        lifetime_tokens: lifetime,
        peak_tokens: peak,
        longest_chat_secs: longest,
        days: days.into_iter().collect(),
        daily: daily
            .into_iter()
            .map(|(day, tokens)| DayTokens { day, tokens })
            .collect(),
    })
}

/// Newest first. Skips empty and bash-mode lines.
pub fn load_recent_prompts(cwd: &str, limit: usize) -> Result<Vec<String>, String> {
    let path = sessions_dir_for_cwd(cwd)?.join("prompt_history.jsonl");
    if !path.is_file() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("Cannot read prompts: {e}"))?;
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if val.get("is_bash").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let prompt = val
            .get("prompt")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("");
        if prompt.is_empty() {
            continue;
        }
        if out.iter().any(|p| p == prompt) {
            continue;
        }
        out.push(prompt.to_string());
        if limit > 0 && out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// User and assistant turns for the transcript (system noise skipped).
/// Prefer `updates.jsonl` (full UI log). Compact rewrites `chat_history.jsonl`
/// to the model prompt, which drops earlier turns.
pub fn load_history(cwd: &str, session_id: &str) -> Result<Vec<HistoryMessage>, String> {
    let dir = session_dir(cwd, session_id)?;
    let mut msgs = load_history_from_updates(&dir);
    if !msgs.iter().any(|m| m.role == "user") {
        let path = dir.join("chat_history.jsonl");
        if path.is_file() {
            let file = fs::File::open(&path).map_err(|e| format!("Cannot read history: {e}"))?;
            msgs = parse_history_lines(BufReader::new(file).lines().flatten());
        }
    }
    recover_user_images(&dir, &mut msgs);
    apply_worked_secs(dir.clone(), &mut msgs);
    apply_turn_times(dir, &mut msgs);
    Ok(msgs)
}

fn load_history_from_updates(dir: &Path) -> Vec<HistoryMessage> {
    let path = dir.join("updates.jsonl");
    let Ok(file) = fs::File::open(path) else {
        return vec![];
    };
    parse_updates_lines(BufReader::new(file).lines().flatten())
}

fn image_mime_for_path(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png".into()
    } else if lower.ends_with(".gif") {
        "image/gif".into()
    } else if lower.ends_with(".webp") {
        "image/webp".into()
    } else if lower.ends_with(".bmp") {
        "image/bmp".into()
    } else {
        "image/jpeg".into()
    }
}

/// Absolute image paths from an `<image_files>` workspace block. Order kept.
fn image_file_refs(text: &str) -> Vec<String> {
    let Some(start) = text.find("<image_files>") else {
        return vec![];
    };
    let rest = &text[start + "<image_files>".len()..];
    let end = rest.find("</image_files>").unwrap_or(rest.len());
    let mut out = Vec::new();
    for token in rest[..end].split(|c: char| c.is_whitespace() || "()\"'".contains(c)) {
        let t = token.trim_end_matches([',', '.', ';']);
        if !t.starts_with('/') || !Path::new(t).is_file() {
            continue;
        }
        let lower = t.to_ascii_lowercase();
        let image = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]
            .iter()
            .any(|e| lower.ends_with(e));
        if image && !out.contains(&t.to_string()) {
            out.push(t.to_string());
        }
    }
    out
}

/// `updates.jsonl` keeps user text plus `[Image #N]` labels, but the CLI no
/// longer persists image parts there. Recover thumbnails from the asset
/// paths in `chat_history.jsonl`. Labels never reach the transcript.
fn recover_user_images(dir: &Path, msgs: &mut [HistoryMessage]) {
    if !msgs.iter().any(|m| {
        m.role == "user" && m.attachments.is_empty() && m.text.contains("[Image #")
    }) {
        return;
    }
    let mut donors: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(file) = fs::File::open(dir.join("chat_history.jsonl")) {
        for line in BufReader::new(file).lines().flatten() {
            let Ok(val) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if val.get("type").and_then(|v| v.as_str()) != Some("user") {
                continue;
            }
            let Some(arr) = val.get("content").and_then(|v| v.as_array()) else {
                continue;
            };
            for part in arr {
                let t = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let Some(q) = extract_user_query(t) else {
                    continue;
                };
                let key = strip_image_labels(&q).trim().to_string();
                let refs = image_file_refs(t);
                if !key.is_empty() && !refs.is_empty() {
                    donors.push((key, refs));
                }
            }
        }
    }
    for m in msgs.iter_mut() {
        if m.role != "user" || !m.attachments.is_empty() || !m.text.contains("[Image #") {
            continue;
        }
        let key = strip_image_labels(&m.text).trim().to_string();
        let mut refs = donors
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, r)| r);
        if refs.is_none() && donors.len() == 1 {
            let only = &donors[0].1;
            if only.len() == m.text.matches("[Image #").count() {
                refs = Some(only);
            }
        }
        if let Some(refs) = refs {
            for (i, p) in refs.iter().enumerate() {
                m.attachments.push(HistoryAttachment {
                    name: format!("Image #{}", i + 1),
                    mime: image_mime_for_path(p),
                    kind: "image".into(),
                    path: Some(p.clone()),
                    url: None,
                });
            }
        }
        m.text = strip_image_labels(&m.text).trim().to_string();
    }
}

fn resolve_subagent_id(cwd: &str, parent_id: &str, sub_id: &str, label: &str) -> String {
    if let Ok(dir) = session_dir(cwd, sub_id) {
        if dir.join("chat_history.jsonl").is_file() {
            return sub_id.to_string();
        }
    }
    let Ok(root) = sessions_dir_for_cwd(cwd) else {
        return sub_id.to_string();
    };
    let snap = root.join(parent_id).join("subagents");
    if snap.join(sub_id).is_dir() {
        return sub_id.to_string();
    }
    let want = label.trim().to_ascii_lowercase();
    if want.is_empty() {
        return sub_id.to_string();
    }
    let Ok(entries) = fs::read_dir(&snap) else {
        return sub_id.to_string();
    };
    for entry in entries.flatten() {
        let raw = fs::read_to_string(entry.path().join("meta.json")).unwrap_or_default();
        let val: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let desc = val
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if desc == want {
            if let Some(id) = entry.file_name().to_str() {
                return id.to_string();
            }
        }
    }
    sub_id.to_string()
}

/// Subagent transcript. Falls back to the parent snapshot if history is thin.
pub fn load_subagent_history(
    cwd: &str,
    parent_id: &str,
    sub_id: &str,
    label: Option<String>,
) -> Result<Vec<HistoryMessage>, String> {
    let resolved = resolve_subagent_id(cwd, parent_id, sub_id, label.as_deref().unwrap_or(""));
    let msgs = load_history(cwd, &resolved)?;
    let has_text = msgs.iter().any(|m| {
        m.role == "assistant" && (!m.text.trim().is_empty() || !m.parts.is_empty())
    });
    if has_text {
        return Ok(msgs);
    }
    let snap = sessions_dir_for_cwd(cwd)?
        .join(parent_id)
        .join("subagents")
        .join(&resolved);
    let meta: Value = fs::read_to_string(snap.join("meta.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let output: Value = fs::read_to_string(snap.join("output.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let prompt = meta
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let answer = output
        .get("output")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let mut out = Vec::new();
    if !prompt.is_empty() {
        out.push(HistoryMessage {
            role: "user".into(),
            text: prompt.to_string(),
            thought: None,
            parts: vec![],
            attachments: vec![],
            worked_secs: None,
            at: None,
        });
    }
    if !answer.is_empty() {
        out.push(make_assistant(None, answer, vec![], None));
    }
    if out.is_empty() {
        Ok(msgs)
    } else {
        Ok(out)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub id: String,
    pub description: String,
    pub subagent_type: String,
    pub status: String,
}

pub fn list_subagents(cwd: &str, parent_id: &str) -> Result<Vec<SubagentInfo>, String> {
    let root = sessions_dir_for_cwd(cwd)?.join(parent_id).join("subagents");
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("Cannot read subagents: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let fallback_id = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if fallback_id.is_empty() {
            continue;
        }
        let val: Value = fs::read_to_string(path.join("meta.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null);
        let id = val
            .get("child_session_id")
            .or_else(|| val.get("subagent_id"))
            .and_then(|v| v.as_str())
            .unwrap_or(&fallback_id)
            .trim()
            .to_string();
        out.push(SubagentInfo {
            id,
            description: val
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
            subagent_type: val
                .get("subagent_type")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
            status: val
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string(),
        });
    }
    Ok(out)
}

fn iso_to_unix(s: &str) -> Option<u64> {
    let s = s.trim().trim_end_matches('Z');
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-');
    let y: i32 = d.next()?.parse().ok()?;
    let m: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    let time = rest.split(['.', '+']).next()?;
    let mut t = time.split(':');
    let h: u64 = t.next()?.parse().ok()?;
    let min: u64 = t.next()?.parse().ok()?;
    let sec: u64 = t.next()?.parse().ok()?;
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + u64::from(doy);
    let days = era * 146097 + doe as i64 - 719468;
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86400 + h * 3600 + min * 60 + sec)
}

fn load_turn_secs(dir: &Path) -> Vec<u64> {
    let path = dir.join("events.jsonl");
    let Ok(file) = fs::File::open(path) else {
        return vec![];
    };
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut start: Option<u64> = None;
    let mut last: Option<u64> = None;
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        if start.is_none() {
            if !line.contains("turn_started") {
                continue;
            }
        } else if !line.contains("turn_ended") && !line.contains("\"ts\"") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let ts = val.get("ts").and_then(|v| v.as_str()).and_then(iso_to_unix);
        if kind == "turn_started" {
            if let (Some(s), Some(e)) = (start, last) {
                if e >= s {
                    out.push(e - s);
                }
            }
            start = ts;
            last = ts;
            continue;
        }
        if ts.is_some() {
            last = ts;
        }
        if kind == "turn_ended" {
            if let (Some(s), Some(e)) = (start, last) {
                if e >= s {
                    out.push(e - s);
                }
            }
            start = None;
            last = None;
        }
    }
    if let (Some(s), Some(e)) = (start, last) {
        if e >= s {
            out.push(e - s);
        }
    }
    out
}

fn apply_worked_secs(dir: PathBuf, msgs: &mut [HistoryMessage]) {
    let secs = load_turn_secs(&dir);
    if secs.is_empty() {
        return;
    }
    let mut i = 0;
    for msg in msgs {
        if msg.role != "assistant" {
            continue;
        }
        if let Some(&n) = secs.get(i) {
            if n > 0 {
                msg.worked_secs = Some(n);
            }
        }
        i += 1;
    }
}

fn load_prompt_times(dir: &Path) -> Vec<u64> {
    let path = dir.join("rewind_points.jsonl");
    let Ok(file) = fs::File::open(path) else {
        return vec![];
    };
    let mut by_index: BTreeMap<usize, u64> = BTreeMap::new();
    for line in BufReader::new(file).lines().flatten() {
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let idx = val.get("prompt_index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let Some(created) = val.get("created_at").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(secs) = iso_to_unix(created) else {
            continue;
        };
        by_index.insert(idx, secs.saturating_mul(1000));
    }
    if by_index.is_empty() {
        return vec![];
    }
    let max = *by_index.keys().max().unwrap_or(&0);
    (0..=max)
        .map(|i| by_index.get(&i).copied().unwrap_or(0))
        .collect()
}

fn apply_turn_times(dir: PathBuf, msgs: &mut [HistoryMessage]) {
    let times = load_prompt_times(&dir);
    if times.is_empty() {
        return;
    }
    let mut ui = 0usize;
    let mut last_user_at: Option<u64> = None;
    for msg in msgs {
        if msg.role == "user" {
            if let Some(&t) = times.get(ui) {
                if t > 0 {
                    msg.at = Some(t);
                    last_user_at = Some(t);
                }
            }
            ui += 1;
        } else if msg.role == "assistant" && msg.at.is_none() {
            msg.at = last_user_at;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub cwd: String,
    pub session_id: String,
    pub snippet: String,
}

struct CwdIndex {
    cwd: String,
    sessions: Vec<(String, Vec<String>)>,
}

fn search_index() -> &'static Mutex<Vec<CwdIndex>> {
    static INDEX: OnceLock<Mutex<Vec<CwdIndex>>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(Vec::new()))
}

fn lock_index() -> std::sync::MutexGuard<'static, Vec<CwdIndex>> {
    match search_index().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

pub fn build_search_index(cwds: &[String]) -> Result<(), String> {
    for cwd in cwds {
        let cwd = cwd.trim();
        if cwd.is_empty() {
            continue;
        }
        let sessions = index_cwd(cwd);
        let mut idx = lock_index();
        if let Some(slot) = idx.iter_mut().find(|f| f.cwd == cwd) {
            slot.sessions = sessions;
        } else {
            idx.push(CwdIndex {
                cwd: cwd.to_string(),
                sessions,
            });
        }
    }
    Ok(())
}

pub fn search_index_hits(cwds: &[String], query: &str) -> Vec<SessionSearchHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return vec![];
    }
    let idx = lock_index();
    let mut out = Vec::new();
    for cwd in cwds {
        let cwd = cwd.trim();
        if cwd.is_empty() {
            continue;
        }
        let Some(folder) = idx.iter().find(|f| f.cwd == cwd) else {
            continue;
        };
        for (session_id, lines) in &folder.sessions {
            if let Some(snippet) = first_snippet(lines, &needle) {
                out.push(SessionSearchHit {
                    cwd: cwd.to_string(),
                    session_id: session_id.clone(),
                    snippet,
                });
            }
        }
    }
    out
}

fn index_cwd(cwd: &str) -> Vec<(String, Vec<String>)> {
    let mut out = Vec::new();
    let Ok(root) = sessions_dir_for_cwd(cwd) else {
        return out;
    };
    if !root.is_dir() {
        return out;
    }
    for (id, path) in session_id_dirs(&root) {
        let updates = path.join("updates.jsonl");
        let hist = path.join("chat_history.jsonl");
        let mut texts = if updates.is_file() {
            fs::File::open(&updates)
                .map(|file| parse_search_texts_updates(BufReader::new(file).lines().flatten()))
                .unwrap_or_default()
        } else {
            vec![]
        };
        if texts.is_empty() && hist.is_file() {
            let raw = fs::read_to_string(&hist).unwrap_or_default();
            texts = parse_search_texts(&raw);
        }
        if !texts.is_empty() {
            out.push((id, texts));
        }
    }
    out
}

fn session_line_has_user_prompt(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() || !is_user_or_assistant_line(line) {
        return false;
    }
    let Ok(val) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    val.get("type").and_then(|t| t.as_str()) == Some("user") && extract_user_text(&val).is_some()
}

fn session_has_user_prompt_file(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    BufReader::new(file)
        .lines()
        .flatten()
        .any(|line| session_line_has_user_prompt(&line))
}

fn session_has_user_prompt_updates(path: &Path) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    for line in BufReader::new(file).lines().flatten() {
        if !line.contains("user_message_chunk") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some((kind, update)) = session_update(&val) else {
            continue;
        };
        if kind != "user_message_chunk" {
            continue;
        }
        let Some(t) = update
            .pointer("/content/text")
            .and_then(|v| v.as_str())
            .map(str::trim)
        else {
            continue;
        };
        if !t.is_empty() && !is_filler_user_text(t) {
            return true;
        }
    }
    false
}

#[cfg(test)]
fn session_has_user_prompt(raw: &str) -> bool {
    raw.lines().any(session_line_has_user_prompt)
}

fn is_user_or_assistant_line(line: &str) -> bool {
    line.contains(r#""type":"user""#)
        || line.contains(r#""type": "user""#)
        || line.contains(r#""type":"assistant""#)
        || line.contains(r#""type": "assistant""#)
}

fn parse_search_texts(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        // Skip tool/thought JSON. Those lines can be huge.
        if line.is_empty() || !is_user_or_assistant_line(line) {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match val.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => {
                if let Some(t) = extract_user_text(&val) {
                    let t = strip_image_labels(&t);
                    if !t.trim().is_empty() {
                        out.push(t);
                    }
                }
            }
            "assistant" => {
                if let Some(t) = extract_assistant_text(&val) {
                    if !t.trim().is_empty() {
                        out.push(t);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

fn parse_search_texts_updates<I, S>(lines: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = Vec::new();
    let mut user_buf = String::new();
    let mut asst_buf = String::new();
    let flush_user = |buf: &mut String, out: &mut Vec<String>| {
        let t = strip_image_labels(buf);
        buf.clear();
        if !t.trim().is_empty() {
            out.push(t);
        }
    };
    let flush_asst = |buf: &mut String, out: &mut Vec<String>| {
        let t = buf.trim().to_string();
        buf.clear();
        if !t.is_empty() {
            out.push(t);
        }
    };
    for line in lines {
        let line = line.as_ref().trim();
        if line.is_empty() || !line.contains("sessionUpdate") {
            continue;
        }
        if line.contains(r#""type":"image""#) && line.contains("user_message_chunk") {
            continue;
        }
        if !(line.contains("user_message_chunk") || line.contains("agent_message_chunk")) {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some((kind, update)) = session_update(&val) else {
            continue;
        };
        match kind {
            "user_message_chunk" => {
                flush_asst(&mut asst_buf, &mut out);
                let Some(t) = update
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                else {
                    continue;
                };
                if is_filler_user_text(t) {
                    continue;
                }
                user_buf.push_str(t);
            }
            "agent_message_chunk" => {
                flush_user(&mut user_buf, &mut out);
                if let Some(t) = update.pointer("/content/text").and_then(|v| v.as_str()) {
                    asst_buf.push_str(t);
                }
            }
            _ => {
                flush_user(&mut user_buf, &mut out);
                flush_asst(&mut asst_buf, &mut out);
            }
        }
    }
    flush_user(&mut user_buf, &mut out);
    flush_asst(&mut asst_buf, &mut out);
    out
}

fn first_snippet(lines: &[String], needle: &str) -> Option<String> {
    for text in lines {
        for raw in text.split('\n') {
            let line = collapse_ws(raw);
            if line.is_empty() {
                continue;
            }
            let lower = line.to_lowercase();
            if let Some(i) = lower.find(needle) {
                let src = if lower.len() == line.len() {
                    line.as_str()
                } else {
                    lower.as_str()
                };
                return Some(clip_around(src, i, needle.len(), 72));
            }
        }
    }
    None
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip_around(s: &str, index: usize, nlen: usize, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let extra = max.saturating_sub(nlen);
    let left = extra / 2;
    let mut start = index.min(s.len()).saturating_sub(left);
    let mut end = (start + max).min(s.len());
    if end < start {
        start = end;
    } else if end - start < max {
        start = end.saturating_sub(max);
    }
    while start > 0 && !s.is_char_boundary(start) {
        start -= 1;
    }
    while end < s.len() && !s.is_char_boundary(end) {
        end += 1;
    }
    let slice = s[start..end].trim();
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(slice);
    if end < s.len() {
        out.push('…');
    }
    out
}

fn is_history_line(line: &str) -> bool {
    is_user_or_assistant_line(line)
        || line.contains(r#""type":"reasoning""#)
        || line.contains(r#""type": "reasoning""#)
        || line.contains(r#""type":"tool_result""#)
        || line.contains(r#""type": "tool_result""#)
        || line.contains(r#""type":"backend_tool_call""#)
        || line.contains(r#""type": "backend_tool_call""#)
}

#[cfg(test)]
fn parse_history(raw: &str) -> Vec<HistoryMessage> {
    parse_history_lines(Cursor::new(raw).lines().flatten())
}

fn parse_history_lines<I, S>(lines: I) -> Vec<HistoryMessage>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out: Vec<HistoryMessage> = Vec::new();
    let mut pending_thought = String::new();

    for line in lines {
        let line = line.as_ref().trim();
        if line.is_empty() || !is_history_line(line) {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match val.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => {
                if let Some(msg) = user_history(&val) {
                    out.push(msg);
                }
            }
            "reasoning" => {
                if let Some(t) = extract_reasoning(&val) {
                    if let Some(last) = out.last_mut() {
                        if last.role == "assistant" {
                            last.parts.push(thought_part(&t));
                            append_thought(last, t);
                            continue;
                        }
                    }
                    if !pending_thought.is_empty() {
                        pending_thought.push_str("\n\n");
                    }
                    pending_thought.push_str(&t);
                }
            }
            "assistant" => {
                let text = extract_assistant_text(&val).unwrap_or_default();
                let tools = extract_tool_calls(&val);
                let thought = take_thought(&mut pending_thought);
                if let Some(last) = out.last_mut() {
                    if last.role == "assistant" {
                        merge_assistant(last, thought, &text, tools);
                        continue;
                    }
                }
                if text.trim().is_empty() && tools.is_empty() && thought.is_none() {
                    continue;
                }
                out.push(make_assistant(
                    thought,
                    &text,
                    tools,
                    turn_unix(&val).map(|s| s.saturating_mul(1000)),
                ));
            }
            "tool_result" => {
                if let Some(last) = out.last_mut() {
                    if last.role == "assistant" {
                        ensure_tool_from_result(last, &val);
                    }
                }
            }
            "backend_tool_call" => {
                if let Some(part) = extract_backend_tool(&val) {
                    let thought = take_thought(&mut pending_thought);
                    if let Some(last) = out.last_mut() {
                        if last.role == "assistant" {
                            if let Some(thought) = thought {
                                last.parts.push(thought_part(&thought));
                                append_thought(last, thought);
                            }
                            merge_backend_tool(last, part);
                            continue;
                        }
                    }
                    out.push(make_assistant(
                        thought,
                        "",
                        vec![part],
                        turn_unix(&val).map(|s| s.saturating_mul(1000)),
                    ));
                }
            }
            _ => {}
        }
    }

    if let Some(thought) = take_thought(&mut pending_thought) {
        if let Some(last) = out.last_mut() {
            if last.role == "assistant" {
                append_thought(last, thought);
            }
        }
    }
    out
}

fn session_update(val: &Value) -> Option<(&str, &Value)> {
    let params = val.get("params")?;
    if let Some(kind) = params.get("sessionUpdate").and_then(|v| v.as_str()) {
        return Some((kind, params));
    }
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate").and_then(|v| v.as_str())?;
    Some((kind, update))
}

fn is_compact_prompt(t: &str) -> bool {
    let t = t.trim();
    t == "/compact"
        || t
            .strip_prefix("/compact")
            .is_some_and(|rest| rest.starts_with(char::is_whitespace))
}

fn is_filler_user_text(t: &str) -> bool {
    let t = t.trim();
    t.starts_with("<user_info>")
        || t.starts_with("<system-reminder>")
        || t.starts_with("<git_status>")
        || t.starts_with("This session is being continued")
        || is_compact_prompt(t)
}

fn update_at_ms(val: &Value) -> Option<u64> {
    let n = json_u64(val.get("timestamp"))?;
    Some(if n > 10_000_000_000 { n } else { n.saturating_mul(1000) })
}

fn flush_user_msg(out: &mut Vec<HistoryMessage>, pending: &mut Option<HistoryMessage>) {
    let Some(mut msg) = pending.take() else {
        return;
    };
    if !msg.attachments.is_empty() {
        msg.text = strip_image_labels(&msg.text);
    } else {
        msg.text = msg.text.trim().to_string();
    }
    if msg.text.is_empty() && msg.attachments.is_empty() {
        return;
    }
    out.push(msg);
}

fn flush_asst_msg(
    out: &mut Vec<HistoryMessage>,
    pending: &mut Option<HistoryMessage>,
    thought: &mut String,
) {
    if let Some(t) = take_thought(thought) {
        if let Some(last) = pending.as_mut() {
            last.parts.push(thought_part(&t));
            append_thought(last, t);
        } else {
            *pending = Some(make_assistant(Some(t), "", vec![], None));
        }
    }
    let Some(msg) = pending.take() else {
        return;
    };
    if msg.thought.is_none() && msg.text.trim().is_empty() && msg.parts.is_empty() {
        return;
    }
    out.push(msg);
}

fn ensure_user_msg(pending: &mut Option<HistoryMessage>, at: Option<u64>) -> &mut HistoryMessage {
    pending.get_or_insert_with(|| HistoryMessage {
        role: "user".into(),
        text: String::new(),
        thought: None,
        parts: vec![],
        attachments: vec![],
        worked_secs: None,
        at,
    })
}

fn ensure_asst_msg(pending: &mut Option<HistoryMessage>, at: Option<u64>) -> &mut HistoryMessage {
    pending.get_or_insert_with(|| make_assistant(None, "", vec![], at))
}

fn image_from_update_content(content: &Value, n: u32) -> Option<HistoryAttachment> {
    if content.get("type").and_then(|t| t.as_str()) != Some("image") {
        return None;
    }
    let url = content
        .get("uri")
        .or_else(|| content.get("url"))
        .and_then(|v| v.as_str());
    let mime = content
        .get("mimeType")
        .or_else(|| content.get("mime"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| url.and_then(mime_from_data_url))
        .unwrap_or_else(|| "image/png".into());
    let path = url.and_then(path_from_file_uri);
    let preview = if path.is_some() {
        None
    } else {
        url.filter(|u| u.starts_with("data:") && u.len() < 200_000)
            .map(|s| s.to_string())
    };
    if path.is_none() && preview.is_none() {
        return None;
    }
    Some(HistoryAttachment {
        name: format!("Image #{n}"),
        mime,
        kind: "image".into(),
        path,
        url: preview,
    })
}

fn tool_part_from_acp(update: &Value) -> Option<HistoryPart> {
    let id = update
        .get("toolCallId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let name = update
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| update.get("kind").and_then(|v| v.as_str()))
        .unwrap_or("tool");
    let args = update.get("rawInput").cloned().unwrap_or(Value::Null);
    let fake = serde_json::json!({
        "tool_calls": [{ "id": id, "name": name, "arguments": args }]
    });
    extract_tool_calls(&fake).into_iter().next()
}

#[cfg(test)]
fn parse_updates(raw: &str) -> Vec<HistoryMessage> {
    parse_updates_lines(Cursor::new(raw).lines().flatten())
}

fn parse_updates_lines<I, S>(lines: I) -> Vec<HistoryMessage>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out: Vec<HistoryMessage> = Vec::new();
    let mut pending_user: Option<HistoryMessage> = None;
    let mut pending_asst: Option<HistoryMessage> = None;
    let mut pending_thought = String::new();
    let mut image_n = 0u32;

    for line in lines {
        let line = line.as_ref().trim();
        if line.is_empty() || !line.contains("sessionUpdate") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some((kind, update)) = session_update(&val) else {
            continue;
        };
        let at = update_at_ms(&val);
        match kind {
            "user_message_chunk" => {
                flush_asst_msg(&mut out, &mut pending_asst, &mut pending_thought);
                let content = update.get("content").unwrap_or(&Value::Null);
                if let Some(t) = content.get("text").and_then(|v| v.as_str()) {
                    if is_filler_user_text(t) {
                        continue;
                    }
                    let user = ensure_user_msg(&mut pending_user, at);
                    user.text.push_str(t);
                }
                if let Some(att) = image_from_update_content(content, image_n + 1) {
                    image_n += 1;
                    ensure_user_msg(&mut pending_user, at)
                        .attachments
                        .push(att);
                }
            }
            "agent_thought_chunk" => {
                flush_user_msg(&mut out, &mut pending_user);
                if let Some(t) = update.pointer("/content/text").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        pending_thought.push_str(t);
                    }
                }
            }
            "agent_message_chunk" => {
                flush_user_msg(&mut out, &mut pending_user);
                let text = update
                    .pointer("/content/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                let thought = take_thought(&mut pending_thought);
                if let Some(last) = pending_asst.as_mut() {
                    merge_assistant(last, thought, text, vec![]);
                } else {
                    pending_asst = Some(make_assistant(thought, text, vec![], at));
                }
            }
            "tool_call" | "tool_call_update" => {
                flush_user_msg(&mut out, &mut pending_user);
                let Some(part) = tool_part_from_acp(update) else {
                    continue;
                };
                let thought = take_thought(&mut pending_thought);
                if thought.is_some() || pending_asst.is_none() {
                    let asst = ensure_asst_msg(&mut pending_asst, at);
                    if let Some(thought) = thought {
                        asst.parts.push(thought_part(&thought));
                        append_thought(asst, thought);
                    }
                }
                let asst = ensure_asst_msg(&mut pending_asst, at);
                merge_backend_tool(asst, part);
            }
            "turn_completed" => {
                flush_user_msg(&mut out, &mut pending_user);
                flush_asst_msg(&mut out, &mut pending_asst, &mut pending_thought);
            }
            _ => {}
        }
    }
    flush_user_msg(&mut out, &mut pending_user);
    flush_asst_msg(&mut out, &mut pending_asst, &mut pending_thought);
    out
}

fn take_thought(pending: &mut String) -> Option<String> {
    let t = pending.trim().to_string();
    pending.clear();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn text_part(text: &str) -> HistoryPart {
    HistoryPart {
        kind: "text".into(),
        text: text.to_string(),
        tool_id: None,
        tool_name: None,
        query: None,
        path: None,
        span: None,
        old: None,
        new: None,
        urls: vec![],
        todos: vec![],
        todos_merge: false,
    }
}

fn thought_part(text: &str) -> HistoryPart {
    HistoryPart {
        kind: "thought".into(),
        text: text.to_string(),
        tool_id: None,
        tool_name: None,
        query: None,
        path: None,
        span: None,
        old: None,
        new: None,
        urls: vec![],
        todos: vec![],
        todos_merge: false,
    }
}

fn make_assistant(
    thought: Option<String>,
    text: &str,
    tools: Vec<HistoryPart>,
    at: Option<u64>,
) -> HistoryMessage {
    let mut parts = Vec::new();
    if let Some(ref t) = thought {
        if !t.trim().is_empty() {
            parts.push(thought_part(t));
        }
    }
    if !text.trim().is_empty() {
        parts.push(text_part(text));
    }
    parts.extend(tools);
    HistoryMessage {
        role: "assistant".into(),
        text: text.to_string(),
        thought,
        parts,
        attachments: vec![],
        worked_secs: None,
        at,
    }
}

fn merge_assistant(
    last: &mut HistoryMessage,
    thought: Option<String>,
    text: &str,
    tools: Vec<HistoryPart>,
) {
    if let Some(thought) = thought {
        if !thought.trim().is_empty() {
            last.parts.push(thought_part(&thought));
        }
        append_thought(last, thought);
    }
    if !text.trim().is_empty() {
        last.parts.push(text_part(text));
        if !last.text.is_empty() {
            last.text.push('\n');
        }
        last.text.push_str(text);
    }
    last.parts.extend(tools);
}

fn append_thought(last: &mut HistoryMessage, thought: String) {
    match &mut last.thought {
        Some(existing) => {
            existing.push_str("\n\n");
            existing.push_str(&thought);
        }
        None => last.thought = Some(thought),
    }
}

fn ensure_tool_from_result(last: &mut HistoryMessage, val: &Value) {
    let Some(id) = val.get("tool_call_id").and_then(|v| v.as_str()) else {
        return;
    };
    if last.parts.iter().any(|p| p.tool_id.as_deref() == Some(id)) {
        return;
    }
    last.parts.push(HistoryPart {
        kind: "tool".into(),
        text: "Tool".into(),
        tool_id: Some(id.to_string()),
        tool_name: None,
        query: None,
        path: None,
        span: None,
        old: None,
        new: None,
        urls: vec![],
        todos: vec![],
        todos_merge: false,
    });
}

fn merge_backend_tool(last: &mut HistoryMessage, part: HistoryPart) {
    if let Some(id) = part.tool_id.as_deref() {
        if let Some(existing) = last.parts.iter_mut().find(|p| p.tool_id.as_deref() == Some(id)) {
            if existing.query.is_none() {
                existing.query = part.query.clone();
            }
            if existing.path.is_none() {
                existing.path = part.path.clone();
            }
            if existing.span.is_none() {
                existing.span = part.span.clone();
            }
            if existing.old.is_none() {
                existing.old = part.old.clone();
            }
            if existing.new.is_none() {
                existing.new = part.new.clone();
            }
            if existing.urls.is_empty() {
                existing.urls = part.urls.clone();
            }
            if existing.todos.is_empty() && !part.todos.is_empty() {
                existing.todos = part.todos.clone();
                existing.todos_merge = part.todos_merge;
            }
            if existing.text == "Tool" || existing.text == "Web" {
                existing.text = part.text.clone();
            }
            if existing.tool_name.is_none() {
                existing.tool_name = part.tool_name.clone();
            }
            return;
        }
    }
    last.parts.push(part);
}

fn extract_backend_tool(val: &Value) -> Option<HistoryPart> {
    let kind = val.get("kind")?;
    let tool_type = kind.get("tool_type").and_then(|v| v.as_str())?;
    if tool_type != "web_search" {
        return None;
    }
    let id = kind
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let action = kind.get("action");
    let act_type = action
        .and_then(|a| a.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let query = action
        .and_then(|a| a.get("query"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let urls = action.map(urls_from).unwrap_or_default();
    let text = if let Some(q) = query.as_deref() {
        format!("Web search: {q}")
    } else if act_type == "open_page" {
        "Opened page".into()
    } else {
        "Web search".into()
    };
    Some(HistoryPart {
        kind: "tool".into(),
        text,
        tool_id: id,
        tool_name: Some("web_search".into()),
        query,
        path: None,
        span: None,
        old: None,
        new: None,
        urls,
        todos: vec![],
        todos_merge: false,
    })
}

fn extract_user_text(val: &Value) -> Option<String> {
    if val.get("synthetic_reason").is_some() {
        return None;
    }
    let content = val.get("content")?;
    if let Some(arr) = content.as_array() {
        for part in arr {
            let t = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(q) = extract_user_query(t) {
                return Some(q);
            }
        }
        for part in arr {
            let t = part.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            if t.is_empty() {
                continue;
            }
            if t.starts_with("<user_info>")
                || t.starts_with("<system-reminder>")
                || t.starts_with("<git_status>")
                || t.starts_with("This session is being continued")
            {
                continue;
            }
            if t.len() > 8 {
                return Some(t.to_string());
            }
        }
        return None;
    }
    content
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn extract_user_query(raw: &str) -> Option<String> {
    let start = raw.find("<user_query>")?;
    let rest = &raw[start + "<user_query>".len()..];
    let end = rest.find("</user_query>")?;
    let q = rest[..end].trim();
    if q.is_empty() {
        None
    } else {
        Some(q.to_string())
    }
}

fn user_history(val: &Value) -> Option<HistoryMessage> {
    if val.get("synthetic_reason").is_some() {
        return None;
    }
    let attachments = extract_user_attachments(val);
    let text = extract_user_text(val).unwrap_or_default();
    let text = strip_image_labels(&text);
    if is_compact_prompt(&text) {
        return None;
    }
    if text.is_empty() && attachments.is_empty() {
        return None;
    }
    Some(HistoryMessage {
        role: "user".into(),
        text,
        thought: None,
        parts: vec![],
        attachments,
        worked_secs: None,
        at: turn_unix(val).map(|s| s.saturating_mul(1000)),
    })
}

fn extract_user_attachments(val: &Value) -> Vec<HistoryAttachment> {
    let Some(arr) = val.get("content").and_then(|c| c.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    let mut n = 0u32;
    for part in arr {
        if part.get("type").and_then(|t| t.as_str()) != Some("image") {
            continue;
        }
        n += 1;
        let url = part
            .get("url")
            .or_else(|| part.get("uri"))
            .and_then(|v| v.as_str());
        let mime = part
            .get("mimeType")
            .or_else(|| part.get("mime"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| url.and_then(mime_from_data_url))
            .unwrap_or_else(|| "image/png".into());
        let path = url.and_then(path_from_file_uri);
        let preview = url.map(|s| s.to_string()).or_else(|| {
            part.get("data").and_then(|v| v.as_str()).map(|d| {
                format!("data:{mime};base64,{d}")
            })
        });
        out.push(HistoryAttachment {
            name: format!("Image #{n}"),
            mime,
            kind: "image".into(),
            path,
            url: preview,
        });
    }
    out
}

fn mime_from_data_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("data:")?;
    let mime = rest.split(';').next()?.trim();
    if mime.is_empty() || !mime.starts_with("image/") {
        None
    } else {
        Some(mime.to_string())
    }
}

fn path_from_file_uri(url: &str) -> Option<String> {
    let p = url.strip_prefix("file://")?;
    let p = p.trim();
    if p.is_empty() {
        None
    } else {
        Some(p.to_string())
    }
}

fn strip_image_labels(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let cleaned = strip_inline_image_labels(line);
        if cleaned.trim().is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(cleaned.trim_end());
    }
    out.trim().to_string()
}

fn strip_inline_image_labels(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("[Image #") {
        out.push_str(&rest[..start]);
        match rest[start..].find(']') {
            Some(end) => {
                rest = &rest[start + end + 1..];
                if rest.starts_with(' ') {
                    rest = &rest[1..];
                }
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
    out.push_str(rest);
    out
}

fn extract_assistant_text(val: &Value) -> Option<String> {
    let content = val.get("content")?;
    if let Some(s) = content.as_str() {
        let t = s.trim();
        return if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
    }
    if let Some(arr) = content.as_array() {
        let mut buf = String::new();
        for part in arr {
            if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                buf.push_str(t);
            }
        }
        let t = buf.trim();
        return if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
    }
    None
}

fn extract_reasoning(val: &Value) -> Option<String> {
    let summary = val.get("summary")?.as_array()?;
    let mut buf = String::new();
    for part in summary {
        let t = part.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
        if t.is_empty() {
            continue;
        }
        if !buf.is_empty() {
            buf.push_str("\n\n");
        }
        buf.push_str(t);
    }
    if buf.is_empty() {
        None
    } else {
        Some(buf)
    }
}

fn extract_tool_calls(val: &Value) -> Vec<HistoryPart> {
    let Some(arr) = val.get("tool_calls").and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for call in arr {
        let id = call
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = call
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("tool")
            .to_string();
        let parsed_args: Option<Value>;
        let args = match call.get("arguments") {
            Some(Value::String(s)) => {
                parsed_args = serde_json::from_str(s).ok();
                parsed_args.as_ref().unwrap_or(&Value::Null)
            }
            Some(other) => other,
            None => &Value::Null,
        };
        let path = first_arg_path(args);
        let name_l = name.to_ascii_lowercase();
        let inner = if name_l.contains("use_tool") || name_l.contains("usetool") || name_l == "use"
        {
            nested_str(args, &["toolName", "tool_name", "tool"])
        } else {
            None
        };
        let shown = inner.clone().unwrap_or_else(|| name.clone());
        let mut query = first_arg_query(args);
        if query.is_none()
            && (name_l.contains("exec")
                || name_l == "bash"
                || name_l == "shell"
                || name_l.contains("command"))
        {
            query = first_arg_command(args);
        }
        if query.is_none() && name_l.contains("ask") {
            query = ask_header(args);
        }
        query = humanize_mcp_query(&shown, query);
        let is_edit = name.contains("replace") || name == "edit" || name == "write";
        let (old, new) = if is_edit {
            edit_texts(args)
        } else {
            (None, None)
        };
        let span = if name.contains("read") {
            if path.as_deref().is_some_and(is_image_path) {
                None
            } else {
                Some(read_span(args))
            }
        } else if is_edit {
            edit_span_from(&old, &new)
        } else {
            None
        };
        let (todos, todos_merge) = parse_todos(args);
        let urls = if name_l.contains("web") || name_l.contains("fetch") {
            first_arg_urls(args)
        } else {
            vec![]
        };
        out.push(HistoryPart {
            kind: "tool".into(),
            text: tool_title(&shown, args),
            tool_id: if id.is_empty() { None } else { Some(id) },
            tool_name: Some(shown),
            query,
            path,
            span,
            old,
            new,
            urls,
            todos,
            todos_merge,
        });
    }
    out
}

fn human_tool_name(name: &str) -> String {
    let first = name.split('_').next().unwrap_or(name);
    let mut chars = first.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Tool".into(),
    }
}

fn first_arg_path(args: &Value) -> Option<String> {
    nested_str(args, PATH_KEYS)
}

fn first_arg_command(args: &Value) -> Option<String> {
    nested_str(args, &["command", "cmd"])
}

fn parse_todos(args: &Value) -> (Vec<HistoryTodo>, bool) {
    let Some(arr) = args.get("todos").and_then(|x| x.as_array()) else {
        return (vec![], false);
    };
    let merge = args.get("merge").and_then(|x| x.as_bool()).unwrap_or(true);
    let mut out = Vec::new();
    for item in arr {
        let content = item
            .get("content")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let id = item
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let status = item
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("pending")
            .trim()
            .to_string();
        if content.is_empty() && id.is_empty() {
            continue;
        }
        out.push(HistoryTodo {
            id: if id.is_empty() {
                format!("t{}", out.len() + 1)
            } else {
                id
            },
            content,
            status,
        });
    }
    (out, merge)
}

fn first_arg_query(args: &Value) -> Option<String> {
    nested_target(args)
}

fn first_arg_urls(args: &Value) -> Vec<String> {
    urls_from(args)
}

fn read_span(args: &Value) -> String {
    format_read_span(json_u64(args.get("offset")), json_u64(args.get("limit")))
}

fn edit_texts(args: &Value) -> (Option<String>, Option<String>) {
    let old = args
        .get("old_string")
        .or_else(|| args.get("oldText"))
        .and_then(|x| x.as_str())
        .map(|s| clip_str(s, 12_000));
    let new = args
        .get("new_string")
        .or_else(|| args.get("newText"))
        .and_then(|x| x.as_str())
        .map(|s| clip_str(s, 12_000));
    (old, new)
}

fn edit_span_from(old: &Option<String>, new: &Option<String>) -> Option<String> {
    let old = old.as_deref()?;
    let new = new.as_deref().unwrap_or("");
    let del = if old.is_empty() { 0 } else { old.lines().count() };
    let add = if new.is_empty() { 0 } else { new.lines().count() };
    if add == 0 && del == 0 {
        return None;
    }
    Some(format!("+{add} −{del}"))
}

fn first_arg_value(args: &Value) -> Option<String> {
    first_arg_query(args).or_else(|| first_arg_path(args))
}

fn tool_title(name: &str, args: &Value) -> String {
    let human = human_tool_name(name);
    match first_arg_value(args) {
        Some(p) => format!("{human} `{p}`"),
        None => human,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_history, parse_search_texts_updates, parse_updates};

    #[test]
    fn replays_thought_and_tools() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>List files</user_query>"}]}
{"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"I will read TREE.md first."}],"status":"completed"}
{"type":"assistant","content":"Reading TREE.md.","tool_calls":[{"id":"call-1","name":"read_file","arguments":"{\"target_file\":\"/tmp/TREE.md\"}"}]}
{"type":"tool_result","tool_call_id":"call-1","content":"Tree file"}
{"type":"assistant","content":"Done."}
"##;
        let msgs = parse_history(raw);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "List files");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(
            msgs[1].thought.as_deref(),
            Some("I will read TREE.md first.")
        );
        assert_eq!(msgs[1].parts.len(), 4);
        assert_eq!(msgs[1].parts[0].kind, "thought");
        assert_eq!(msgs[1].parts[0].text, "I will read TREE.md first.");
        assert_eq!(msgs[1].parts[1].kind, "text");
        assert_eq!(msgs[1].parts[1].text, "Reading TREE.md.");
        assert_eq!(msgs[1].parts[2].kind, "tool");
        assert_eq!(msgs[1].parts[2].text, "Read `/tmp/TREE.md`");
        assert_eq!(msgs[1].parts[3].kind, "text");
        assert_eq!(msgs[1].parts[3].text, "Done.");
    }

    #[test]
    fn replays_user_images_and_strips_labels() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>/weekly-report\n[Image #1]\n[Image #2]</user_query>"},{"type":"image","url":"data:image/png;base64,aaa"},{"type":"image","uri":"file:///tmp/shot.png","mimeType":"image/png"}]}
{"type":"assistant","content":"ok"}
"##;
        let msgs = parse_history(raw);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "/weekly-report");
        assert_eq!(msgs[0].attachments.len(), 2);
        assert_eq!(msgs[0].attachments[0].kind, "image");
        assert_eq!(
            msgs[0].attachments[0].url.as_deref(),
            Some("data:image/png;base64,aaa")
        );
        assert_eq!(
            msgs[0].attachments[1].path.as_deref(),
            Some("/tmp/shot.png")
        );
    }

    #[test]
    fn orphan_image_labels_recover_from_history_assets() {
        let dir = std::env::temp_dir().join(format!(
            "grotesque-img-recover-{}",
            std::process::id()
        ));
        let assets = dir.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let pic = assets.join("shot.jpg");
        std::fs::write(&pic, [0xFF, 0xD8, 0xFF]).unwrap();
        let hist = format!(
            "{{\"type\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"<image_files>\\n1. {}\\n</image_files>\\n\\n<user_query>\\nLook at this\\n[Image #1]\\n</user_query>\"}}]}}",
            pic.to_string_lossy().replace('\\', "\\\\")
        );
        std::fs::write(dir.join("chat_history.jsonl"), format!("{hist}\n")).unwrap();
        let updates = r##"
{"timestamp":1788516774,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Look at this\n[Image #1]"}}}} 
"##;
        let mut msgs = parse_updates(updates);
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].text.contains("[Image #1]"));
        super::recover_user_images(&dir, &mut msgs);
        assert_eq!(msgs[0].text, "Look at this");
        assert_eq!(msgs[0].attachments.len(), 1);
        assert_eq!(msgs[0].attachments[0].kind, "image");
        assert_eq!(
            msgs[0].attachments[0].path.as_deref(),
            Some(pic.to_string_lossy().as_ref())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn orphan_image_labels_strip_without_donor() {
        let dir = std::env::temp_dir().join(format!(
            "grotesque-img-orphan-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let updates = r##"
{"timestamp":1788516774,"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Look at this\n[Image #1]"}}}} 
"##;
        let mut msgs = parse_updates(updates);
        super::recover_user_images(&dir, &mut msgs);
        assert_eq!(msgs[0].text, "Look at this");
        assert!(msgs[0].attachments.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replays_image_only_user() {
        let raw = r##"
{"type":"user","content":[{"type":"image","url":"data:image/png;base64,aaa"}]}
{"type":"assistant","content":"ok"}
"##;
        let msgs = parse_history(raw);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "");
        assert_eq!(msgs[0].attachments.len(), 1);
        assert_eq!(
            msgs[0].attachments[0].url.as_deref(),
            Some("data:image/png;base64,aaa")
        );
    }

    #[test]
    fn splits_thought_around_tools() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>List files</user_query>"}]}
{"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"First I read TREE."}],"status":"completed"}
{"type":"assistant","content":"","tool_calls":[{"id":"call-1","name":"read_file","arguments":"{\"target_file\":\"/tmp/TREE.md\"}"}]}
{"type":"tool_result","tool_call_id":"call-1","content":"Tree"}
{"type":"reasoning","id":"r2","summary":[{"type":"summary_text","text":"Now list the folder."}],"status":"completed"}
{"type":"assistant","content":"","tool_calls":[{"id":"call-2","name":"list_dir","arguments":"{\"target_directory\":\"/tmp\"}"}]}
{"type":"assistant","content":"No README."}
"##;
        let msgs = parse_history(raw);
        assert_eq!(msgs.len(), 2);
        let kinds: Vec<&str> = msgs[1].parts.iter().map(|p| p.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["thought", "tool", "thought", "tool", "text"]
        );
        assert_eq!(msgs[1].parts[0].text, "First I read TREE.");
        assert_eq!(msgs[1].parts[2].text, "Now list the folder.");
        assert_eq!(msgs[1].parts[4].text, "No README.");
        assert_eq!(
            msgs[1].thought.as_deref(),
            Some("First I read TREE.\n\nNow list the folder.")
        );
    }

    #[test]
    fn replays_backend_web_search() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Find cones</user_query>"}]}
{"type":"backend_tool_call","kind":{"tool_type":"web_search","action":{"type":"search","query":"best waffle cone","sources":[{"type":"url","url":"https://joycone.com"},{"type":"url","url":"https://example.com/a"}]},"id":"ws_1","status":"completed"}}
{"type":"assistant","content":"Joy Cone."}
"##;
        let msgs = parse_history(raw);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].parts[0].kind, "tool");
        assert_eq!(msgs[1].parts[0].tool_name.as_deref(), Some("web_search"));
        assert_eq!(msgs[1].parts[0].query.as_deref(), Some("best waffle cone"));
        assert_eq!(
            msgs[1].parts[0].urls,
            vec!["https://joycone.com", "https://example.com/a"]
        );
        assert_eq!(msgs[1].parts[1].kind, "text");
    }

    #[test]
    fn search_texts_skip_thought_and_tools() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>List files</user_query>"}]}
{"type":"reasoning","id":"r1","summary":[{"type":"summary_text","text":"I will read TREE.md first."}],"status":"completed"}
{"type":"assistant","content":"Reading TREE.md.","tool_calls":[{"id":"call-1","name":"read_file","arguments":"{\"target_file\":\"/tmp/TREE.md\"}"}]}
{"type":"tool_result","tool_call_id":"call-1","content":"Huge tool dump TREE.md"}
{"type":"assistant","content":"Done."}
"##;
        let texts = super::parse_search_texts(raw);
        assert_eq!(
            texts,
            vec![
                "List files".to_string(),
                "Reading TREE.md.".to_string(),
                "Done.".to_string()
            ]
        );
        assert!(!texts.iter().any(|t| t.contains("I will read")));
        assert!(!texts.iter().any(|t| t.contains("Huge tool dump")));
        assert_eq!(
            super::first_snippet(&texts, "tree.md").as_deref(),
            Some("Reading TREE.md.")
        );
        assert!(super::first_snippet(&texts, "i will read").is_none());
    }

    #[test]
    fn empty_session_has_no_user_prompt() {
        let stub = r##"
{"type":"system","content":"You are Grok."}
{"type":"user","content":[{"type":"text","text":"<system-reminder>\nSkills here.\n</system-reminder>"}]}
"##;
        assert!(!super::session_has_user_prompt(stub));
        assert!(!super::session_has_user_prompt(""));
        let real = r##"
{"type":"user","content":[{"type":"text","text":"<system-reminder>\nSkills\n</system-reminder>"}]}
{"type":"user","content":[{"type":"text","text":"<user_query>List files</user_query>"}]}
"##;
        assert!(super::session_has_user_prompt(real));
    }

    #[test]
    fn tool_rows_keep_list_path_and_search_query() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Look</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"a","name":"list_dir","arguments":"{\"target_directory\":\"/tmp/skills/edit\"}"},{"id":"b","name":"grep","arguments":"{\"pattern\":\"granola\",\"path\":\"TAX.md\"}"},{"id":"c","name":"read_file","arguments":"{\"target_file\":\"/tmp/skills/plumb/SKILL.md\"}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].path.as_deref(), Some("/tmp/skills/edit"));
        assert_eq!(tools[1].query.as_deref(), Some("granola"));
        assert_eq!(tools[1].path.as_deref(), Some("TAX.md"));
        assert_eq!(
            tools[2].path.as_deref(),
            Some("/tmp/skills/plumb/SKILL.md")
        );
    }

    #[test]
    fn mcp_use_tool_keeps_nested_search_query() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Paula</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"m1","name":"use_tool","arguments":"{\"toolName\":\"search_chats\",\"arguments\":{\"query\":\"Paula Telegram\"}}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].query.as_deref(), Some("Paula Telegram"));
        assert_ne!(tools[0].query.as_deref(), Some("search_chats"));
    }

    #[test]
    fn mcp_use_tool_keeps_create_title_and_send_to() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Draft</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"c1","name":"use_tool","arguments":"{\"toolName\":\"create_draft\",\"arguments\":{\"title\":\"Friday report\"}}"},{"id":"s1","name":"use_tool","arguments":"{\"toolName\":\"send_message\",\"arguments\":{\"to\":\"Paula\",\"text\":\"on it\"}}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].query.as_deref(), Some("Friday report"));
        assert_eq!(tools[1].query.as_deref(), Some("Paula"));
        assert_eq!(tools[0].tool_name.as_deref(), Some("create_draft"));
        assert_eq!(tools[1].tool_name.as_deref(), Some("send_message"));
    }

    #[test]
    fn mcp_use_tool_reads_tool_input_q() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Find</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"m1","name":"use_tool","arguments":"{\"tool_name\":\"mymind__search\",\"tool_input\":{\"q\":\"daily analysis\",\"limit\":20}}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].query.as_deref(), Some("daily analysis"));
        assert_eq!(tools[0].tool_name.as_deref(), Some("mymind__search"));
        assert_ne!(tools[0].query.as_deref(), Some("mymind__search"));
    }

    #[test]
    fn read_span_all_or_range() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Read</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"a","name":"read_file","arguments":"{\"target_file\":\"TAX.md\"}"},{"id":"b","name":"read_file","arguments":"{\"target_file\":\"TAX.md\",\"offset\":40,\"limit\":20}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools[0].span.as_deref(), Some("all"));
        assert_eq!(tools[1].span.as_deref(), Some("lines 40–59"));
    }

    #[test]
    fn edit_keeps_old_and_new() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Fix</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"e","name":"search_replace","arguments":"{\"file_path\":\"TAX.md\",\"old_string\":\"open\",\"new_string\":\"closed\"}"}]}
"##;
        let msgs = parse_history(raw);
        let tool = msgs[1]
            .parts
            .iter()
            .find(|p| p.kind == "tool")
            .expect("tool");
        assert_eq!(tool.path.as_deref(), Some("TAX.md"));
        assert_eq!(tool.old.as_deref(), Some("open"));
        assert_eq!(tool.new.as_deref(), Some("closed"));
        assert_eq!(tool.span.as_deref(), Some("+1 −1"));
    }

    #[test]
    fn mcp_read_uses_kind_not_host_id() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Slack</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"c","name":"use_tool","arguments":"{\"toolName\":\"slack_read_channel\",\"arguments\":{\"channel_id\":\"C0ABC12345\"}}"},{"id":"f","name":"use_tool","arguments":"{\"tool_name\":\"slack_read_file\",\"tool_input\":{\"file_id\":\"F0BSF5AMUBF\"}}"},{"id":"t","name":"slack_read_thread","arguments":"{\"channel_id\":\"C0ABC12345\",\"message_ts\":\"1234567890.123456\"}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0].query.as_deref(), Some("channel"));
        assert_eq!(tools[1].query.as_deref(), Some("file"));
        assert_eq!(tools[2].query.as_deref(), Some("thread"));
        assert_ne!(tools[1].query.as_deref(), Some("F0BSF5AMUBF"));
    }

    #[test]
    fn mcp_create_and_fetch_show_title_or_kind() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Post</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"d","name":"use_tool","arguments":"{\"toolName\":\"typefully_create_draft\",\"tool_input\":{\"social_set_id\":1,\"requestBody\":{\"draft_title\":\"Friday post\",\"platforms\":{\"x\":{\"enabled\":true,\"posts\":[{\"text\":\"Hello world\"}]}}}}}"},{"id":"t","name":"use_tool","arguments":"{\"toolName\":\"typefully_edit_draft\",\"tool_input\":{\"requestBody\":{\"platforms\":{\"x\":{\"enabled\":true,\"posts\":[{\"text\":\"Staging now:\\nmore\"}]}}}}}"},{"id":"p","name":"use_tool","arguments":"{\"toolName\":\"notion-create-pages\",\"arguments\":{\"pages\":[{\"properties\":{\"title\":\"Staging notes\"}}]}}"},{"id":"f","name":"use_tool","arguments":"{\"toolName\":\"notion-fetch\",\"tool_input\":{\"id\":\"195de9221179449fab8075a27c979105\"}}"},{"id":"u","name":"notion-fetch","arguments":"{\"id\":\"https://www.notion.so/workspace/Staging-notes-195de9221179449fab8075a27c979105\"}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools.len(), 5);
        assert_eq!(tools[0].query.as_deref(), Some("Friday post"));
        assert_eq!(tools[1].query.as_deref(), Some("Staging now:"));
        assert_eq!(tools[2].query.as_deref(), Some("Staging notes"));
        assert_eq!(tools[3].query.as_deref(), Some("page"));
        assert_eq!(tools[4].query.as_deref(), Some("Staging notes"));
    }

    #[test]
    fn mcp_query_keywords_and_ids_stay_human() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Look</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"q","name":"use_tool","arguments":"{\"toolName\":\"query_granola_meetings\",\"tool_input\":{\"query\":\"launch recap\"}}"},{"id":"k","name":"use_tool","arguments":"{\"toolName\":\"slack_search_public\",\"arguments\":{\"keywords\":[\"launch\",\"terminal\"]}}"},{"id":"g","name":"use_tool","arguments":"{\"toolName\":\"get_meeting_transcript\",\"tool_input\":{\"meeting_id\":\"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\"}}"},{"id":"s","name":"use_tool","arguments":"{\"toolName\":\"telegram_send_message\",\"arguments\":{\"chat_id\":123456789,\"message\":\"shipped\"}}"},{"id":"n","name":"use_tool","arguments":"{\"toolName\":\"telegram_send_message\",\"arguments\":{\"chat_id\":123456789}}"}]}
"##;
        let msgs = parse_history(raw);
        let tools: Vec<_> = msgs[1]
            .parts
            .iter()
            .filter(|p| p.kind == "tool")
            .collect();
        assert_eq!(tools[0].query.as_deref(), Some("launch recap"));
        assert_eq!(tools[1].query.as_deref(), Some("launch terminal"));
        assert_eq!(tools[2].query.as_deref(), Some("meeting transcript"));
        assert_eq!(tools[3].query.as_deref(), Some("shipped"));
        assert_eq!(tools[4].query.as_deref(), Some("message"));
        assert_ne!(tools[4].query.as_deref(), Some("123456789"));
    }

    #[test]
    fn core_read_file_keeps_path_not_kind() {
        let raw = r##"
{"type":"user","content":[{"type":"text","text":"<user_query>Read</user_query>"}]}
{"type":"assistant","content":"ok","tool_calls":[{"id":"a","name":"read_file","arguments":"{\"target_file\":\"TAX.md\"}"}]}
"##;
        let msgs = parse_history(raw);
        let tool = msgs[1]
            .parts
            .iter()
            .find(|p| p.kind == "tool")
            .expect("tool");
        assert_eq!(tool.path.as_deref(), Some("TAX.md"));
        assert_ne!(tool.query.as_deref(), Some("file"));
    }

    #[test]
    fn updates_keep_turns_compact_would_drop() {
        let raw = r##"
{"timestamp":100,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"First prompt"}}}
{"timestamp":101,"method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"First answer"}}}
{"timestamp":102,"method":"session/update","params":{"sessionUpdate":"turn_completed"}}
{"timestamp":200,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"This session is being continued from a previous conversation."}}}
{"timestamp":201,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Later prompt"}}}
{"timestamp":202,"method":"session/update","params":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"I will read TAX.md."}}}
{"timestamp":203,"method":"session/update","params":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"read_file","rawInput":{"target_file":"/tmp/TAX.md"}}}
{"timestamp":204,"method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Later answer"}}}
{"timestamp":205,"method":"session/update","params":{"sessionUpdate":"turn_completed"}}
"##;
        let msgs = parse_updates(raw);
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "First prompt");
        assert_eq!(msgs[1].role, "assistant");
        assert_eq!(msgs[1].text, "First answer");
        assert_eq!(msgs[2].role, "user");
        assert_eq!(msgs[2].text, "Later prompt");
        assert_eq!(msgs[3].role, "assistant");
        assert_eq!(msgs[3].text, "Later answer");
        assert_eq!(
            msgs[3].thought.as_deref(),
            Some("I will read TAX.md.")
        );
        let tool = msgs[3]
            .parts
            .iter()
            .find(|p| p.kind == "tool")
            .expect("tool");
        assert_eq!(tool.path.as_deref(), Some("/tmp/TAX.md"));
    }

    #[test]
    fn updates_user_image_uses_file_uri() {
        let raw = r##"
{"timestamp":1,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"See this [Image #1]"}}}
{"timestamp":1,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"image","mimeType":"image/png","uri":"file:///tmp/shot.png","data":"aaa"}}}
{"timestamp":2,"method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}
"##;
        let msgs = parse_updates(raw);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].text, "See this");
        assert_eq!(msgs[0].attachments.len(), 1);
        assert_eq!(
            msgs[0].attachments[0].path.as_deref(),
            Some("/tmp/shot.png")
        );
        assert!(msgs[0].attachments[0].url.is_none());
    }

    #[test]
    fn updates_search_texts_skip_compact_filler() {
        let raw = r##"
{"params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Old prompt"}}}
{"params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Old "}}}
{"params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer"}}}
{"params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"This session is being continued from a previous conversation."}}}
{"params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"New prompt"}}}
"##;
        let texts = parse_search_texts_updates(raw.lines());
        assert_eq!(
            texts,
            vec![
                "Old prompt".to_string(),
                "Old answer".to_string(),
                "New prompt".to_string()
            ]
        );
    }

    #[test]
    fn updates_skip_compact_prompt() {
        let raw = r##"
{"timestamp":1,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"/compact"}}}
{"timestamp":2,"method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Compacted."}}}
{"timestamp":3,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"/compact keep the auth path"}}}
{"timestamp":4,"method":"session/update","params":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Real prompt"}}}
{"timestamp":5,"method":"session/update","params":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Ok"}}}
"##;
        let msgs = parse_updates(raw);
        let users: Vec<&str> = msgs
            .iter()
            .filter(|m| m.role == "user")
            .map(|m| m.text.as_str())
            .collect();
        assert_eq!(users, vec!["Real prompt"]);
        assert!(!users.iter().any(|t| t.contains("/compact")));
    }
}


