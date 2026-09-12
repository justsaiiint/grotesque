//! Shared Grok types, binary lookup, and login check. Process I/O lives in `acp`.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const GROK_RELATIVE: &str = ".grok/bin/grok";
const AUTH_RELATIVE: &str = ".grok/auth.json";
const MODELS_CACHE_RELATIVE: &str = ".grok/models_cache.json";
pub const DEFAULT_MODEL_ID: &str = "grok-4.6";
const DEFAULT_MODEL_NAME: &str = "Grok 4.6";
const GROK_45_ID: &str = "grok-4.5";
const GROK_45_NAME: &str = "Grok 4.5";

const ERR_NO_CLI: &str =
    "Grok Build CLI not found. Install Grok Build, then in Terminal run: grok login. Expected ~/.grok/bin/grok.";
const ERR_NO_LOGIN: &str = "Not logged in to Grok. In Terminal run: grok login";

fn command_output_timeout(cmd: &mut Command, secs: u64) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_end(&mut stdout);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_end(&mut stderr);
                }
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                if start.elapsed().as_secs() >= secs {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Timed out.".into());
                }
                thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GrokRunResult {
    pub ok: bool,
    pub text: String,
    pub error: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct StreamEvent {
    /// `text` | `thought` | `status` | `error` | `done` | `tool` | `compact`
    pub kind: String,
    pub data: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortOption {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    /// Effort menu from models_cache; empty means use Grotesque fallbacks.
    pub efforts: Vec<EffortOption>,
    /// Tokens; from models_cache `context_window`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Percent; from models_cache `auto_compact_threshold_percent`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_compact_percent: Option<u64>,
}

/// Binary present and account login on disk (`~/.grok/auth.json`).
pub fn ensure_grok_ready() -> Result<PathBuf, String> {
    let binary = find_grok_binary()?;
    ensure_logged_in()?;
    Ok(binary)
}

pub fn find_grok_binary() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(GROK_RELATIVE);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    if let Ok(output) = Command::new("/usr/bin/which").arg("grok").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                let p = PathBuf::from(&path);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
    }

    Err(ERR_NO_CLI.into())
}

fn ensure_logged_in() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| ERR_NO_LOGIN.to_string())?;
    let path = PathBuf::from(home).join(AUTH_RELATIVE);
    if !path.is_file() {
        return Err(ERR_NO_LOGIN.into());
    }
    let raw = fs::read_to_string(&path).map_err(|_| ERR_NO_LOGIN.to_string())?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "{}" || trimmed == "null" {
        return Err(ERR_NO_LOGIN.into());
    }
    let val: Value = serde_json::from_str(trimmed).map_err(|_| ERR_NO_LOGIN.to_string())?;
    match val.as_object() {
        Some(map) if !map.is_empty() => Ok(()),
        _ => Err(ERR_NO_LOGIN.into()),
    }
}

/// Map spawn/runtime strings that mean missing CLI or login into fixed copy.
pub fn clarify_grok_error(err: &str) -> String {
    let lower = err.to_lowercase();
    if lower.contains("not found") && (lower.contains("grok") || lower.contains("no such file")) {
        return ERR_NO_CLI.into();
    }
    if lower.contains("not logged")
        || lower.contains("please log in")
        || lower.contains("please login")
        || (lower.contains("grok")
            && (lower.contains("unauthorized") || lower.contains("unauthenticated")))
    {
        return ERR_NO_LOGIN.into();
    }
    err.to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    pub current: String,
    pub latest: String,
    pub available: bool,
}

/// CLI prints `grok 1.0.4 (hash) [stable]`; keep the version token.
pub fn cli_version() -> Option<String> {
    let binary = find_grok_binary().ok()?;
    let output = Command::new(&binary).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_cli_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_cli_version(raw: &str) -> Option<String> {
    let line = raw.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    let rest = line
        .strip_prefix("grok ")
        .or_else(|| line.strip_prefix("Grok "))
        .unwrap_or(line);
    let ver = rest.split_whitespace().next()?.trim();
    if ver.is_empty() {
        None
    } else {
        Some(ver.to_string())
    }
}

/// `grok update --check --json`. None = quiet (no binary, parse fail, or CLI error).
pub fn check_cli_update() -> Option<CliUpdate> {
    let binary = find_grok_binary().ok()?;
    let mut cmd = Command::new(&binary);
    cmd.args(["update", "--check", "--json"]);
    let output = command_output_timeout(&mut cmd, 20).ok()?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let val: Value = serde_json::from_str(raw.trim()).ok()?;
    let err_ok = val.get("error").map(|e| e.is_null()).unwrap_or(true);
    if !err_ok {
        return None;
    }
    let current = val.get("currentVersion")?.as_str()?.trim().to_string();
    let latest = val.get("latestVersion")?.as_str()?.trim().to_string();
    if current.is_empty() || latest.is_empty() {
        return None;
    }
    let available = val
        .get("updateAvailable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Some(CliUpdate {
        current,
        latest,
        available,
    })
}

/// Install the latest CLI. Then re-check.
pub fn install_cli_update() -> Result<CliUpdate, String> {
    let before = check_cli_update();
    let want = before
        .as_ref()
        .map(|u| u.latest.clone())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Could not update Grok CLI.".to_string())?;
    let binary = find_grok_binary()?;
    let mut cmd = Command::new(&binary);
    cmd.arg("update").stdin(Stdio::null());
    let output = command_output_timeout(&mut cmd, 180)
        .map_err(|_| "Could not update Grok CLI.".to_string())?;
    if !output.status.success() {
        return Err(cli_fail_msg(&output, "Could not update Grok CLI."));
    }
    Ok(check_cli_update().unwrap_or(CliUpdate {
        current: want.clone(),
        latest: want,
        available: false,
    }))
}

/// Account models from `~/.grok/models_cache.json`. At least default model and grok-4.5.
pub fn list_models() -> Vec<ModelInfo> {
    finish_model_list(read_models_cache())
}

fn finish_model_list(mut models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    if models.is_empty() {
        return vec![default_model(), grok_45_model()];
    }
    if !models.iter().any(|m| m.id == DEFAULT_MODEL_ID) {
        models.push(default_model());
    }
    // 4.6 is default; cache may omit or hide 4.5. Keep it on the menu.
    if !models.iter().any(|m| m.id == GROK_45_ID) {
        models.push(grok_45_model());
    }
    for m in &mut models {
        m.is_default = m.id == DEFAULT_MODEL_ID;
        if m.efforts.is_empty() {
            m.efforts = fallback_efforts();
        }
    }
    if !models.iter().any(|m| m.is_default) {
        models[0].is_default = true;
    }
    models.sort_by(|a, b| match (a.is_default, b.is_default) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    models
}

fn default_model() -> ModelInfo {
    ModelInfo {
        id: DEFAULT_MODEL_ID.into(),
        name: DEFAULT_MODEL_NAME.into(),
        is_default: true,
        // Grok 4.6 menu when cache is missing.
        efforts: vec![
            EffortOption {
                id: "xhigh".into(),
                label: "Extra high".into(),
                is_default: true,
            },
            EffortOption {
                id: "high".into(),
                label: "High".into(),
                is_default: false,
            },
            EffortOption {
                id: "medium".into(),
                label: "Medium".into(),
                is_default: false,
            },
            EffortOption {
                id: "low".into(),
                label: "Low".into(),
                is_default: false,
            },
        ],
        context_window: Some(500_000),
        auto_compact_percent: Some(80),
    }
}

fn grok_45_model() -> ModelInfo {
    ModelInfo {
        id: GROK_45_ID.into(),
        name: GROK_45_NAME.into(),
        is_default: false,
        efforts: fallback_efforts(),
        context_window: Some(500_000),
        auto_compact_percent: Some(80),
    }
}

fn fallback_efforts() -> Vec<EffortOption> {
    vec![
        EffortOption {
            id: "high".into(),
            label: "High".into(),
            is_default: true,
        },
        EffortOption {
            id: "medium".into(),
            label: "Medium".into(),
            is_default: false,
        },
        EffortOption {
            id: "low".into(),
            label: "Low".into(),
            is_default: false,
        },
    ]
}

fn parse_efforts(info: &Value) -> Vec<EffortOption> {
    let Some(arr) = info.get("reasoning_efforts").and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for item in arr {
        let id = item
            .get("value")
            .or_else(|| item.get("id"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let raw_label = item
            .get("label")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id.as_str());
        let label = short_effort_label(raw_label, &id);
        let is_default = item.get("default").and_then(|v| v.as_bool()) == Some(true);
        out.push(EffortOption {
            id,
            label,
            is_default,
        });
    }
    // Keep only the first cache default.
    if let Some(i) = out.iter().position(|e| e.is_default) {
        for (j, e) in out.iter_mut().enumerate() {
            e.is_default = j == i;
        }
    }
    out
}

fn short_effort_label(raw: &str, id: &str) -> String {
    let trimmed = raw
        .trim()
        .trim_end_matches(" Effort")
        .trim_end_matches(" effort")
        .trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    match id {
        "xhigh" => "Extra high".into(),
        "high" => "High".into(),
        "medium" => "Medium".into(),
        "low" => "Low".into(),
        other => other.to_string(),
    }
}

fn read_models_cache() -> Vec<ModelInfo> {
    let Ok(home) = std::env::var("HOME") else {
        return vec![];
    };
    let path = PathBuf::from(home).join(MODELS_CACHE_RELATIVE);
    let Ok(raw) = fs::read_to_string(path) else {
        return vec![];
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return vec![];
    };
    let Some(map) = val.get("models").and_then(|m| m.as_object()) else {
        return vec![];
    };

    let mut out = Vec::new();
    for (key, entry) in map {
        let info = entry.get("info").unwrap_or(entry);
        let id = info
            .get("id")
            .or_else(|| info.get("model"))
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        if info.get("hidden").and_then(|h| h.as_bool()) == Some(true) && id != GROK_45_ID {
            continue;
        }
        let name = info
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id.as_str())
            .to_string();
        out.push(ModelInfo {
            id,
            name,
            is_default: false,
            efforts: parse_efforts(info),
            context_window: info.get("context_window").and_then(|v| v.as_u64()),
            auto_compact_percent: info
                .get("auto_compact_threshold_percent")
                .and_then(|v| v.as_u64()),
        });
    }
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSlash {
    pub name: String,
    pub description: String,
    pub source: String,
}

/// User-invocable skills from the same folders Grok scans.
pub fn list_skill_commands(cwd: &str) -> Vec<SkillSlash> {
    let mut hits: Vec<(String, String, String)> = Vec::new();
    if let Some(home) = grok_home() {
        collect_skills_in(&home.join("skills"), "personal", &mut hits);
    }
    if let Ok(home) = env::var("HOME") {
        collect_skills_in(
            &PathBuf::from(home).join(".agents/skills"),
            "personal",
            &mut hits,
        );
    }
    let mut dir = PathBuf::from(cwd);
    for _ in 0..8 {
        collect_skills_in(&dir.join(".grok/skills"), "project", &mut hits);
        collect_skills_in(&dir.join(".agents/skills"), "project", &mut hits);
        collect_skills_in(&dir.join(".claude/skills"), "project", &mut hits);
        let parent = match dir.parent() {
            Some(p) if p != dir => p.to_path_buf(),
            _ => break,
        };
        dir = parent;
    }
    if let Some(home) = grok_home() {
        let off = disabled_plugin_keys(cwd);
        collect_plugin_skills(&home.join("installed-plugins"), &off, &mut hits);
        collect_plugin_skills(&home.join("plugins"), &off, &mut hits);
        collect_skills_in(&home.join("bundled/skills"), "bundled", &mut hits);
    }
    let disabled = disabled_skill_names();
    hits.into_iter()
        .filter(|(name, _, _)| !disabled.contains(&name.to_ascii_lowercase()))
        .map(|(name, description, source)| SkillSlash {
            name,
            description,
            source,
        })
        .collect()
}

fn disabled_skill_names() -> HashSet<String> {
    let Ok(path) = user_config_path() else {
        return HashSet::new();
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Some(range) = skills_section_range(&raw) else {
        return HashSet::new();
    };
    let section = &raw[range];
    let Some(at) = section.find("disabled") else {
        return HashSet::new();
    };
    let rest = &section[at..];
    let end = rest.find(']').map(|i| i + 1).unwrap_or(rest.len());
    parse_toml_string_array(&rest[..end])
        .into_iter()
        .map(|s| s.to_ascii_lowercase())
        .collect()
}

pub(crate) fn grok_home() -> Option<PathBuf> {
    if let Ok(h) = env::var("GROK_HOME") {
        let p = PathBuf::from(h);
        if !p.as_os_str().is_empty() {
            return Some(p);
        }
    }
    env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".grok"))
}

fn collect_plugin_skills(
    root: &Path,
    off: &HashSet<String>,
    out: &mut Vec<(String, String, String)>,
) {
    let registry = load_plugin_registry(root);
    let Ok(rd) = fs::read_dir(root) else {
        return;
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if p.is_dir() {
            let folder = ent.file_name().to_string_lossy().to_string();
            if folder.is_empty() || folder.starts_with('.') {
                continue;
            }
            let id = plugin_id_from_registry(&registry, &folder).unwrap_or_else(|| folder.clone());
            if plugin_key_blocked(&id, off) || plugin_key_blocked(&folder, off) {
                continue;
            }
            collect_skills_in(&p.join("skills"), &format!("plugin:{id}"), out);
        }
    }
}

fn load_plugin_registry(root: &Path) -> Value {
    fs::read_to_string(root.join("registry.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

fn plugin_id_from_registry(registry: &Value, folder: &str) -> Option<String> {
    let repo = registry.get("repos")?.get(folder)?;
    if let Some(sub) = repo
        .get("marketplace")
        .and_then(|m| m.get("plugin_subdir"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(sub.to_string());
    }
    let plugins = repo.get("plugins")?.as_object()?;
    plugins
        .keys()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn disabled_plugin_keys(cwd: &str) -> HashSet<String> {
    let mut keys = HashSet::new();
    let listed = grok_json(&["mcp", "list", "--json"], cwd).ok();
    let mut rows = listed.as_ref().map(parse_mcp_list).unwrap_or_default();
    if let Ok(inspect) = grok_json(&["inspect", "--json"], cwd) {
        merge_inspect_mcp(&mut rows, &inspect);
        if let Some(arr) = inspect.get("mcpServers").and_then(|v| v.as_array()) {
            for item in arr {
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if name.is_empty() {
                    continue;
                }
                let enabled = rows
                    .iter()
                    .find(|r| r.name == name)
                    .map(|r| r.enabled)
                    .unwrap_or(true);
                if enabled {
                    continue;
                }
                keys.insert(name.to_ascii_lowercase());
                if let Some(plugin) = item
                    .get("source")
                    .and_then(|s| s.get("plugin_name"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    keys.insert(plugin.to_ascii_lowercase());
                }
            }
        }
    }
    for row in &rows {
        if row.enabled {
            continue;
        }
        keys.insert(row.name.to_ascii_lowercase());
        if let Some(plugin) = row.scope.strip_prefix("plugin:") {
            if !plugin.is_empty() {
                keys.insert(plugin.to_ascii_lowercase());
            }
        }
    }
    keys
}

fn plugin_key_blocked(folder: &str, off: &HashSet<String>) -> bool {
    let key = folder.trim().to_ascii_lowercase();
    if key.is_empty() {
        return false;
    }
    off.iter().any(|n| key.eq_ignore_ascii_case(n))
}

fn collect_skills_in(dir: &Path, source: &str, out: &mut Vec<(String, String, String)>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let folder = ent.path();
        if !folder.is_dir() {
            continue;
        }
        let skill = folder.join("SKILL.md");
        if !skill.is_file() {
            continue;
        }
        let folder_name = ent.file_name().to_string_lossy().to_string();
        let Some((name, desc, invocable)) = read_skill(&skill, &folder_name) else {
            continue;
        };
        if !invocable {
            continue;
        }
        if out.iter().any(|(n, _, _)| n.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let src = if source == "project" {
            let folder = project_folder_from_skill_path(&skill.to_string_lossy());
            if folder.is_empty() {
                "project".to_string()
            } else {
                format!("project:{folder}")
            }
        } else {
            source.to_string()
        };
        out.push((name, desc, src));
    }
}

fn read_skill(path: &Path, folder_name: &str) -> Option<(String, String, bool)> {
    let raw = fs::read_to_string(path).ok()?;
    let (name, desc, invocable) = parse_skill_frontmatter(&raw);
    let name = name
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| folder_name.to_string());
    let desc = desc.unwrap_or_default();
    Some((name, first_skill_line(&desc), invocable))
}

fn parse_skill_frontmatter(raw: &str) -> (Option<String>, Option<String>, bool) {
    let body = raw.strip_prefix("---").unwrap_or(raw);
    let Some(end) = body.find("\n---") else {
        return (None, None, true);
    };
    let fm = &body[..end];
    let mut name = None;
    let mut desc = None;
    let mut invocable = true;
    let mut take_desc = false;
    for line in fm.lines() {
        if let Some(rest) = line.strip_prefix("name:") {
            name = Some(rest.trim().trim_matches('"').to_string());
            take_desc = false;
            continue;
        }
        if let Some(rest) = line.strip_prefix("user-invocable:") {
            invocable = rest.trim() == "true";
            take_desc = false;
            continue;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            let r = rest.trim();
            if r.is_empty() || r == ">" || r == ">-" || r == "|" || r == "|-" {
                desc = Some(String::new());
                take_desc = true;
            } else {
                desc = Some(r.trim_matches('"').to_string());
                take_desc = false;
            }
            continue;
        }
        if take_desc && (line.starts_with(' ') || line.starts_with('\t')) {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            if let Some(d) = desc.as_mut() {
                if !d.is_empty() {
                    d.push(' ');
                }
                d.push_str(t);
            }
        } else if take_desc && !line.is_empty() {
            take_desc = false;
        }
    }
    (name, desc, invocable)
}

fn first_skill_line(desc: &str) -> String {
    let t = desc.trim();
    let cut = t.find(". ").map(|i| i + 1).unwrap_or(t.len());
    let s = t[..cut].trim();
    if s.chars().count() <= 90 {
        return s.to_string();
    }
    format!("{}…", s.chars().take(88).collect::<String>())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRow {
    pub name: String,
    pub enabled: bool,
    pub scope: String,
    pub transport: String,
    pub url: String,
    pub can_sign_in: bool,
    pub signed_in: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    pub name: String,
    pub description: String,
    pub marketplace: String,
    pub source: String,
    pub homepage: String,
    pub installed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: String,
    pub has_extras: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsSnapshot {
    pub mcp: Vec<McpRow>,
    pub skills: Vec<SkillRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_error: Option<String>,
}

pub(crate) fn valid_mcp_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n.len() <= 80
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Names that already have an MCP OAuth token. Keys are `name:url`; values are never read.
fn signed_in_mcp_names() -> HashSet<String> {
    let Some(home) = grok_home() else {
        return HashSet::new();
    };
    let raw = fs::read_to_string(home.join("mcp_credentials.json")).unwrap_or_default();
    let Ok(val) = serde_json::from_str::<Value>(raw.trim()) else {
        return HashSet::new();
    };
    let Some(map) = val.as_object() else {
        return HashSet::new();
    };
    map.keys()
        .filter_map(|k| {
            let name = k.split_once(':').map(|(n, _)| n).unwrap_or(k).trim();
            if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            }
        })
        .collect()
}

fn headers_have_auth(item: &Value) -> bool {
    let Some(headers) = item.get("headers") else {
        return false;
    };
    headers.get("Authorization").is_some() || headers.get("authorization").is_some()
}

fn url_looks_static_secret(url: &str) -> bool {
    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    let q = query.to_ascii_lowercase();
    q.contains("api_key")
        || q.contains("access_token")
        || q.contains("token=")
        || q.contains("secret")
}

fn url_is_loopback(url: &str) -> bool {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
}

fn mcp_can_sign_in(transport: &str, url: &str, has_auth_header: bool) -> bool {
    if has_auth_header || url_looks_static_secret(url) || url_is_loopback(url) {
        return false;
    }
    transport == "http" || transport == "sse" || url.starts_with("http")
}

fn apply_mcp_auth(rows: &mut [McpRow]) {
    let signed = signed_in_mcp_names();
    for row in rows {
        row.signed_in = signed.contains(&row.name);
        if row.signed_in {
            row.can_sign_in = true;
        }
    }
}

fn grok_output(args: &[&str], cwd: &str) -> Result<std::process::Output, String> {
    let binary = find_grok_binary()?;
    let mut cmd = Command::new(&binary);
    cmd.args(args);
    cmd.stdin(std::process::Stdio::null());
    if !cwd.is_empty() && Path::new(cwd).is_dir() {
        cmd.current_dir(cwd);
    }
    cmd.output()
        .map_err(|_| "Could not run Grok CLI.".to_string())
}

fn cli_fail_msg(out: &std::process::Output, fallback: &str) -> String {
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = err.trim();
    if !msg.is_empty() {
        return msg.to_string();
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let msg = stdout.trim();
    if msg.is_empty() {
        fallback.into()
    } else {
        msg.to_string()
    }
}

fn grok_json(args: &[&str], cwd: &str) -> Result<Value, String> {
    let out = grok_output(args, cwd)?;
    if !out.status.success() {
        return Err(clarify_grok_error(&cli_fail_msg(&out, "Grok CLI failed.")));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).map_err(|_| "Could not read Grok output.".to_string())
}

fn grok_ok(args: &[&str], cwd: &str) -> Result<(), String> {
    let out = grok_output(args, cwd)?;
    if out.status.success() {
        return Ok(());
    }
    Err(clarify_grok_error(&cli_fail_msg(&out, "Grok CLI failed.")))
}

fn project_folder_from_skill_path(path: &str) -> String {
    let parts: Vec<&str> = Path::new(path).iter().filter_map(|s| s.to_str()).collect();
    for i in 1..parts.len() {
        let nest = parts[i] == ".agents"
            || parts[i] == ".grok"
            || parts[i] == ".claude"
            || parts[i] == ".cursor";
        if nest && parts.get(i + 1) == Some(&"skills") {
            let name = parts[i - 1];
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    Path::new(path)
        .parent()
        .and_then(|d| d.parent())
        .and_then(|d| d.parent())
        .and_then(|d| d.file_name())
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Project")
        .to_string()
}

fn skill_source_label(src: &Value) -> String {
    let kind = src.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "project" => {
            let folder = src
                .get("path")
                .and_then(|v| v.as_str())
                .map(project_folder_from_skill_path)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Project".into());
            format!("project:{folder}")
        }
        "user" => "personal".into(),
        "bundled" => "bundled".into(),
        "plugin" => src
            .get("plugin_name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| format!("plugin:{s}"))
            .unwrap_or_else(|| "plugin".into()),
        other if !other.is_empty() => other.to_string(),
        _ => "personal".into(),
    }
}

fn parse_mcp_list(val: &Value) -> Vec<McpRow> {
    let Some(arr) = val.as_array() else {
        return vec![];
    };
    let mut out = Vec::new();
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let enabled = item
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let scope = item
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or("user")
            .to_string();
        let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let transport = if !url.is_empty() {
            "http"
        } else if item.get("command").and_then(|v| v.as_str()).is_some() {
            "stdio"
        } else {
            ""
        };
        out.push(McpRow {
            can_sign_in: mcp_can_sign_in(transport, url, headers_have_auth(item)),
            signed_in: false,
            name,
            enabled,
            scope,
            transport: transport.into(),
            url: url.to_string(),
        });
    }
    out
}

fn merge_inspect_mcp(rows: &mut Vec<McpRow>, inspect: &Value) {
    let Some(arr) = inspect.get("mcpServers").and_then(|v| v.as_array()) else {
        return;
    };
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let transport = item
            .get("transport")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let src = item.get("source");
        let scope = match src.and_then(|s| s.get("type")).and_then(|v| v.as_str()) {
            Some("plugin") => src
                .and_then(|s| s.get("plugin_name"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| format!("plugin:{s}"))
                .unwrap_or_else(|| "plugin".into()),
            Some("configToml") => String::new(),
            other => other.unwrap_or("").to_string(),
        };
        let target = item.get("target").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(row) = rows.iter_mut().find(|r| r.name == name) {
            if row.transport.is_empty() && !transport.is_empty() {
                row.can_sign_in = mcp_can_sign_in(&transport, target, false);
                row.transport = transport;
            }
            if row.url.is_empty() && target.starts_with("http") {
                row.url = target.to_string();
            }
            continue;
        }
        // Inspect adds plugin-owned servers only.
        if src.and_then(|s| s.get("type")).and_then(|v| v.as_str()) != Some("plugin") {
            continue;
        }
        let can_sign_in = mcp_can_sign_in(&transport, target, false);
        rows.push(McpRow {
            name,
            enabled: true,
            scope: if scope.is_empty() {
                "user".into()
            } else {
                scope
            },
            transport,
            url: if target.starts_with("http") {
                target.to_string()
            } else {
                String::new()
            },
            can_sign_in,
            signed_in: false,
        });
    }
}

fn parse_inspect_skills(inspect: &Value) -> Vec<SkillRow> {
    let Some(arr) = inspect.get("skills").and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let desc = item
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let source_val = item.get("source");
        let source = source_val
            .map(skill_source_label)
            .unwrap_or_else(|| "personal".into());
        let path = source_val
            .and_then(|s| s.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let disabled = item
            .get("disabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let has_extras = skill_has_extras(&path);
        out.push(SkillRow {
            name,
            description: desc,
            source,
            path,
            has_extras,
            disabled,
        });
    }
    // Name-only sort splits a plugin heading.
    out.sort_by(|a, b| {
        let ra = skill_rank(&a.source);
        let rb = skill_rank(&b.source);
        ra.cmp(&rb)
            .then_with(|| a.source.to_lowercase().cmp(&b.source.to_lowercase()))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

fn skill_has_extras(skill_md: &str) -> bool {
    if skill_md.is_empty() {
        return false;
    }
    let p = Path::new(skill_md);
    let dir = if p
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("SKILL.md"))
    {
        p.parent()
    } else if p.is_dir() {
        Some(p)
    } else {
        p.parent()
    };
    let Some(dir) = dir else {
        return false;
    };
    let Ok(rd) = fs::read_dir(dir) else {
        return false;
    };
    rd.flatten().any(|ent| {
        let name = ent.file_name();
        let n = name.to_string_lossy();
        !n.starts_with('.') && !n.eq_ignore_ascii_case("SKILL.md") && n != "node_modules"
    })
}

fn skill_rank(source: &str) -> u8 {
    if source == "project" || source.starts_with("project:") {
        0
    } else if source == "personal" {
        1
    } else if source.starts_with("plugin") {
        2
    } else if source == "bundled" {
        3
    } else {
        4
    }
}

pub fn load_plugins_snapshot(cwd: &str) -> Result<PluginsSnapshot, String> {
    let listed = grok_json(&["mcp", "list", "--json"], cwd);
    let mcp_error = listed.as_ref().err().cloned();
    let mut mcp = listed.as_ref().ok().map(parse_mcp_list).unwrap_or_default();
    let inspect = grok_json(&["inspect", "--json"], cwd).ok();
    if let Some(rep) = &inspect {
        merge_inspect_mcp(&mut mcp, rep);
    }
    apply_mcp_auth(&mut mcp);
    let skills = if let Some(rep) = &inspect {
        parse_inspect_skills(rep)
    } else {
        list_skill_commands(cwd)
            .into_iter()
            .map(|s| SkillRow {
                name: s.name,
                description: s.description,
                source: s.source,
                path: String::new(),
                has_extras: false,
                disabled: false,
            })
            .collect()
    };
    Ok(PluginsSnapshot {
        mcp,
        skills,
        mcp_error,
    })
}

pub fn set_mcp_enabled(name: &str, enabled: bool, cwd: &str) -> Result<(), String> {
    if !valid_mcp_name(name) {
        return Err("That MCP name is not valid.".into());
    }
    let verb = if enabled { "enable" } else { "disable" };
    grok_ok(&["mcp", verb, name], cwd)
}

pub fn remove_mcp_server(name: &str, cwd: &str) -> Result<(), String> {
    if !valid_mcp_name(name) {
        return Err("That MCP name is not valid.".into());
    }
    grok_ok(&["mcp", "remove", name], cwd)
}

pub fn add_mcp_url(name: &str, url: &str, cwd: &str) -> Result<(), String> {
    let name = name.trim();
    let url = url.trim();
    if !valid_mcp_name(name) {
        return Err("That MCP name is not valid.".into());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Use an http URL.".into());
    }
    grok_ok(&["mcp", "add", "--transport", "http", name, url], cwd)
}

fn github_shorthand(url: &str) -> Option<String> {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))?;
    let rest = rest.trim_end_matches(".git").trim_end_matches('/');
    let mut parts = rest.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

fn market_plugin_source(item: &Value) -> String {
    let src = item.get("source");
    let url = src
        .and_then(|s| s.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let path = src
        .and_then(|s| s.get("path"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if let Some(short) = github_shorthand(url) {
        if path.is_empty() {
            return short;
        }
        return format!("{short}#{path}");
    }
    if !url.is_empty() {
        return url.to_string();
    }
    item.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn parse_marketplace_file(path: &Path, installed: &HashSet<String>) -> Vec<MarketPlugin> {
    let Ok(raw) = fs::read_to_string(path) else {
        return vec![];
    };
    let Ok(val) = serde_json::from_str::<Value>(raw.trim()) else {
        return vec![];
    };
    let market = val
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let Some(arr) = val.get("plugins").and_then(|v| v.as_array()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let description = item
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let homepage = item
            .get("homepage")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let source = market_plugin_source(item);
        if source.is_empty() {
            continue;
        }
        let installed = installed.contains(&name.to_ascii_lowercase());
        out.push(MarketPlugin {
            name,
            description,
            marketplace: if market.is_empty() {
                "Marketplace".into()
            } else {
                market.clone()
            },
            source,
            homepage,
            installed,
        });
    }
    out
}

fn installed_plugin_names(cwd: &str) -> HashSet<String> {
    let Ok(val) = grok_json(&["plugin", "list", "--json"], cwd) else {
        return HashSet::new();
    };
    let Some(arr) = val.as_array() else {
        return HashSet::new();
    };
    arr.iter()
        .filter_map(|item| item.get("name").and_then(|v| v.as_str()))
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn list_marketplace_plugins(cwd: &str) -> Result<Vec<MarketPlugin>, String> {
    let installed = installed_plugin_names(cwd);
    let Some(home) = grok_home() else {
        return Ok(vec![]);
    };
    let cache = home.join("marketplace-cache");
    let Ok(rd) = fs::read_dir(&cache) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for ent in rd.flatten() {
        let dir = ent.path();
        if !dir.is_dir() {
            continue;
        }
        for rel in [
            ".grok-plugin/marketplace.json",
            ".claude-plugin/marketplace.json",
        ] {
            let file = dir.join(rel);
            if !file.is_file() {
                continue;
            }
            for row in parse_marketplace_file(&file, &installed) {
                let key = format!("{}::{}", row.marketplace, row.name);
                if seen.insert(key) {
                    out.push(row);
                }
            }
        }
    }
    out.sort_by(|a, b| {
        let g = a
            .marketplace
            .to_ascii_lowercase()
            .cmp(&b.marketplace.to_ascii_lowercase());
        if g != std::cmp::Ordering::Equal {
            return g;
        }
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    Ok(out)
}

pub fn install_marketplace_plugin(source: &str, cwd: &str) -> Result<(), String> {
    let source = source.trim();
    if source.is_empty() || source.contains('\0') || source.chars().any(|c| c.is_control()) {
        return Err("That plugin source is not valid.".into());
    }
    grok_ok(&["plugin", "install", source, "--trust"], cwd)
}

/// Drop this server's MCP OAuth keys only. Does not touch `auth.json` or other servers.
pub fn sign_out_mcp(name: &str) -> Result<(), String> {
    if !valid_mcp_name(name) {
        return Err("That MCP name is not valid.".into());
    }
    let path = grok_home()
        .map(|h| h.join("mcp_credentials.json"))
        .ok_or_else(|| "Could not find ~/.grok.".to_string())?;
    if !path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|_| "Could not read MCP login.".to_string())?;
    let mut val: Value =
        serde_json::from_str(raw.trim()).map_err(|_| "Could not read MCP login.".to_string())?;
    let Some(map) = val.as_object_mut() else {
        return Err("Could not read MCP login.".into());
    };
    let prefix = format!("{name}:");
    let before = map.len();
    map.retain(|k, _| k != name && !k.starts_with(&prefix));
    if map.len() == before {
        return Ok(());
    }
    let body =
        serde_json::to_string_pretty(&val).map_err(|_| "Could not write MCP login.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|_| "Could not write MCP login.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, &path).map_err(|_| "Could not write MCP login.".to_string())?;
    Ok(())
}

fn user_config_path() -> Result<PathBuf, String> {
    grok_home()
        .map(|h| h.join("config.toml"))
        .ok_or_else(|| "Could not find ~/.grok.".to_string())
}

fn skills_section_range(raw: &str) -> Option<std::ops::Range<usize>> {
    let start = if raw.starts_with("[skills]") {
        0
    } else {
        raw.find("\n[skills]").map(|i| i + 1)?
    };
    let after = start + "[skills]".len();
    let end = raw[after..]
        .find("\n[")
        .map(|i| after + i)
        .unwrap_or(raw.len());
    Some(start..end)
}

fn parse_toml_string_array(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(q) = rest.find('"') {
        rest = &rest[q + 1..];
        let Some(end) = rest.find('"') else {
            break;
        };
        let item = rest[..end].trim();
        if !item.is_empty() {
            out.push(item.to_string());
        }
        rest = &rest[end + 1..];
    }
    out
}

fn format_disabled_array(names: &[String]) -> String {
    if names.is_empty() {
        return "disabled = []\n".into();
    }
    let mut s = String::from("disabled = [\n");
    for n in names {
        s.push_str("  \"");
        s.push_str(n);
        s.push_str("\",\n");
    }
    s.push_str("]\n");
    s
}

/// Edit only `[skills].disabled` in user config. Do not rewrite other tables.
pub fn set_skill_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let name = name.trim();
    if !valid_mcp_name(name) {
        return Err("That skill name is not valid.".into());
    }
    let path = user_config_path()?;
    let raw = if path.is_file() {
        fs::read_to_string(&path).map_err(|_| "Could not read Grok config.".to_string())?
    } else {
        String::new()
    };
    let next = patch_skills_disabled(&raw, name, enabled)?;
    if next == raw {
        return Ok(());
    }
    let tmp = path.with_extension("toml.desk-tmp");
    fs::write(&tmp, next).map_err(|_| "Could not update Grok config.".to_string())?;
    fs::rename(&tmp, &path).map_err(|_| {
        let _ = fs::remove_file(&tmp);
        "Could not update Grok config.".to_string()
    })?;
    Ok(())
}

fn patch_skills_disabled(raw: &str, name: &str, enabled: bool) -> Result<String, String> {
    let Some(range) = skills_section_range(raw) else {
        if enabled {
            return Ok(raw.to_string());
        }
        let mut out = raw.to_string();
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n[skills]\n");
        out.push_str(&format_disabled_array(&[name.to_string()]));
        return Ok(out);
    };
    let section = &raw[range.clone()];
    let key = "disabled";
    let Some(key_at) = section.find(key) else {
        if enabled {
            return Ok(raw.to_string());
        }
        let mut section = section.to_string();
        if !section.ends_with('\n') {
            section.push('\n');
        }
        section.push_str(&format_disabled_array(&[name.to_string()]));
        let mut out = String::new();
        out.push_str(&raw[..range.start]);
        out.push_str(&section);
        out.push_str(&raw[range.end..]);
        return Ok(out);
    };
    let after_key = &section[key_at + key.len()..];
    let Some(eq) = after_key.find('=') else {
        return Err("Could not update skills.".into());
    };
    let after_eq = after_key[eq + 1..].trim_start();
    if !after_eq.starts_with('[') {
        return Err("Could not update skills.".into());
    }
    let mut depth = 0i32;
    let mut end_rel = None;
    for (i, c) in after_eq.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end_rel = Some(i + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let end_rel = end_rel.ok_or_else(|| "Could not update skills.".to_string())?;
    let array_abs_start =
        key_at + key.len() + eq + 1 + (after_key[eq + 1..].len() - after_eq.len());
    let array_abs_end = array_abs_start + end_rel;
    let mut names = parse_toml_string_array(&section[array_abs_start..array_abs_end]);
    let had = names.iter().any(|n| n.eq_ignore_ascii_case(name));
    if enabled {
        if !had {
            return Ok(raw.to_string());
        }
        names.retain(|n| !n.eq_ignore_ascii_case(name));
    } else if !had {
        names.push(name.to_string());
    } else {
        return Ok(raw.to_string());
    }
    let mut rebuilt = format_disabled_array(&names);
    if rebuilt.ends_with('\n') {
        rebuilt.pop();
    }
    let mut section = section.to_string();
    section.replace_range(key_at..array_abs_end, &rebuilt);
    let mut out = String::new();
    out.push_str(&raw[..range.start]);
    out.push_str(&section);
    out.push_str(&raw[range.end..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{
        finish_model_list, grok_45_model, patch_skills_disabled, ModelInfo, DEFAULT_MODEL_ID,
        GROK_45_ID,
    };

    #[test]
    fn disable_then_enable_skill() {
        let raw = "[skills]\ndisabled = [\n  \"a\",\n]\n";
        let off = patch_skills_disabled(raw, "b", false).unwrap();
        assert!(off.contains("\"b\""));
        assert!(off.contains("\"a\""));
        let on = patch_skills_disabled(&off, "b", true).unwrap();
        assert!(!on.contains("\"b\""));
        assert!(on.contains("\"a\""));
    }

    #[test]
    fn model_list_keeps_grok_45_when_cache_omits_it() {
        let models = finish_model_list(vec![ModelInfo {
            id: DEFAULT_MODEL_ID.into(),
            name: "Grok 4.6".into(),
            is_default: true,
            efforts: vec![],
            context_window: None,
            auto_compact_percent: None,
        }]);
        assert!(models.iter().any(|m| m.id == GROK_45_ID));
        assert!(models.iter().any(|m| m.id == DEFAULT_MODEL_ID));
    }

    #[test]
    fn model_list_keeps_cache_grok_45() {
        let cached = grok_45_model();
        let models = finish_model_list(vec![cached.clone()]);
        let found = models.iter().find(|m| m.id == GROK_45_ID).unwrap();
        assert_eq!(found.name, cached.name);
        assert_eq!(found.efforts.len(), cached.efforts.len());
    }
}
