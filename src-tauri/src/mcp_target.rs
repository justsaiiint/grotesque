//! Shared live ACP and session replay helpers.

use serde_json::Value;

fn looks_like_tool_slug(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 3 || t.len() > 64 {
        return false;
    }
    let mut parts = t.split('_');
    let Some(first) = parts.next() else {
        return false;
    };
    if first.is_empty() || !first.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    let rest: Vec<&str> = parts.collect();
    !rest.is_empty()
        && rest
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
        && t.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

// Slack C/F/U-style ids. A name always has a letter run with no digit.
fn looks_like_host_id(s: &str) -> bool {
    let t = s.trim();
    let n = t.len();
    if n < 9 || n > 18 {
        return false;
    }
    let mut chars = t.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !matches!(
        first.to_ascii_uppercase(),
        'C' | 'D' | 'G' | 'F' | 'U' | 'T' | 'W'
    ) {
        return false;
    }
    let mut digit = false;
    for c in chars {
        if c.is_ascii_digit() {
            digit = true;
        } else if !c.is_ascii_alphanumeric() {
            return false;
        }
    }
    digit
}

const MCP_KIND_SKIP: &[&str] = &[
    "add",
    "brandfetch",
    "call",
    "close",
    "create",
    "delete",
    "docs",
    "download",
    "duplicate",
    "edit",
    "fetch",
    "find",
    "lookup",
    "figma",
    "gdocs",
    "get",
    "github",
    "gitlab",
    "gmail",
    "google",
    "granola",
    "linear",
    "list",
    "mcp",
    "mixpanel",
    "mymind",
    "notion",
    "open",
    "other",
    "palmier",
    "paste",
    "patch",
    "pencil",
    "personal",
    "plus",
    "post",
    "move",
    "plan",
    "publish",
    "query",
    "react",
    "read",
    "remove",
    "reply",
    "retrieve",
    "schedule",
    "search",
    "send",
    "share",
    "sentry",
    "server",
    "set",
    "slack",
    "telegram",
    "tool",
    "typefully",
    "update",
    "upload",
    "use",
    "write",
];

fn mcp_kind_noun(name: &str) -> Option<String> {
    let slug = name.rsplit("__").next().unwrap_or(name);
    let mut out: Vec<String> = Vec::new();
    for t in slug.split(|c: char| c == '_' || c == '-') {
        if t.is_empty() {
            continue;
        }
        let l = t.to_ascii_lowercase();
        if MCP_KIND_SKIP.contains(&l.as_str()) {
            continue;
        }
        out.push(l);
    }
    if out.len() == 1 && out[0] == "pages" {
        return Some("page".into());
    }
    if !out.is_empty() {
        return Some(out.join(" "));
    }
    let low = slug.to_ascii_lowercase();
    if low.contains("draft") {
        return Some("draft".into());
    }
    if low.contains("folder") {
        return Some("folder".into());
    }
    if low.contains("comment") {
        return Some("comment".into());
    }
    if low.contains("transcript") {
        return Some("transcript".into());
    }
    if low.contains("meeting") {
        return Some("meeting".into());
    }
    if low.contains("page") || low.contains("fetch") {
        return Some("page".into());
    }
    None
}

fn looks_like_uuid(s: &str) -> bool {
    let t: String = s.trim().chars().filter(|c| *c != '-').collect();
    t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_opaque_target(s: &str) -> bool {
    let t = s.trim();
    t.eq_ignore_ascii_case("self")
        || looks_like_host_id(t)
        || looks_like_uuid(t)
        || (t.len() >= 6 && t.chars().all(|c| c.is_ascii_digit()))
}

fn first_line(s: &str, max_chars: usize) -> Option<String> {
    let line = s.lines().find(|l| !l.trim().is_empty())?.trim();
    if line.is_empty() || is_opaque_target(line) {
        return None;
    }
    Some(line.chars().take(max_chars).collect())
}

fn title_from_url(s: &str) -> Option<String> {
    if !s.contains("://") {
        return None;
    }
    let noq = s.split(['?', '#']).next().unwrap_or(s);
    let seg = noq.rsplit('/').find(|p| !p.is_empty())?;
    let mut base = seg;
    if base.len() > 33 {
        let dash = base.len() - 33;
        if base.as_bytes().get(dash) == Some(&b'-') {
            let tail = &base[dash + 1..];
            if tail.len() == 32 && tail.chars().all(|c| c.is_ascii_hexdigit()) {
                base = &base[..dash];
            }
        }
    }
    let title = base.replace('-', " ");
    let title = title.trim();
    if title.is_empty() || is_opaque_target(title) {
        None
    } else {
        Some(title.to_string())
    }
}

pub(crate) fn humanize_mcp_query(name: &str, raw: Option<String>) -> Option<String> {
    match raw {
        Some(t) if !is_opaque_target(&t) => Some(t),
        other => mcp_kind_noun(name).or_else(|| other.filter(|t| !is_opaque_target(t))),
    }
}

fn value_as_target(v: &Value, max_chars: usize) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || looks_like_tool_slug(t) || is_opaque_target(t) {
                return None;
            }
            if t.contains("://") {
                return title_from_url(t);
            }
            if t.chars().count() > max_chars {
                return None;
            }
            Some(t.to_string())
        }
        Value::Array(arr) => arr.iter().find_map(|x| value_as_target(x, max_chars)),
        _ => None,
    }
}

fn strip_search_label(s: &str) -> Option<String> {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    for pre in ["x search:", "web search:"] {
        if lower.starts_with(pre) {
            let rest = t.get(pre.len()..).unwrap_or("").trim();
            return if rest.is_empty() {
                None
            } else {
                Some(rest.to_string())
            };
        }
    }
    if lower == "x search" || lower == "web search" {
        return None;
    }
    Some(t.to_string())
}

fn pick_target_from(obj: &Value) -> Option<String> {
    const PRIMARY: &[&str] = &[
        "query",
        "pattern",
        "search",
        "q",
        "search_query",
        "searchQuery",
        "natural_language_query",
        "term",
        "keywords",
        "title",
        "draft_title",
        "subject",
        "label",
        "heading",
        "url",
        "href",
        "uri",
        "link",
        "path",
        "file",
        "filename",
        "target_file",
        "document",
        "to",
        "chat",
        "channel",
        "conversation",
        "username",
        "user",
        "email",
        "from",
        "name",
    ];
    const TEXT: &[&str] = &["text", "message", "prompt", "question", "snippet"];
    const IDS: &[&str] = &[
        "id",
        "document_id",
        "documentId",
        "page_id",
        "file_id",
        "message_id",
        "chat_id",
    ];
    for key in PRIMARY {
        if *key == "keywords" {
            if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
                let joined: Vec<&str> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(str::trim))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !joined.is_empty() {
                    return Some(joined.join(" "));
                }
            }
        }
        if let Some(s) = obj.get(*key).and_then(|v| value_as_target(v, 200)) {
            if let Some(clean) = strip_search_label(&s) {
                return Some(clean);
            }
        }
    }
    for key in TEXT {
        if let Some(s) = obj.get(*key).and_then(|v| value_as_target(v, 80)) {
            return Some(s);
        }
    }
    for key in IDS {
        if let Some(s) = obj.get(*key).and_then(|v| value_as_target(v, 80)) {
            return Some(s);
        }
    }
    None
}

// Grok MCP `use_tool` puts the call in `tool_input`, not `arguments`.
const MCP_ARG_WRAP: &[&str] = &[
    "arguments",
    "params",
    "input",
    "args",
    "tool_input",
    "requestBody",
];

fn pick_pages_title(obj: &Value) -> Option<String> {
    let page = obj.get("pages")?.as_array()?.first()?;
    if let Some(t) = page.get("title").and_then(|v| value_as_target(v, 200)) {
        return Some(t);
    }
    let props = page.get("properties")?;
    for key in ["title", "Title", "Name", "name"] {
        if let Some(t) = props.get(key).and_then(|v| value_as_target(v, 200)) {
            return Some(t);
        }
    }
    None
}

fn pick_post_text(obj: &Value) -> Option<String> {
    let plats = obj.get("platforms")?.as_object()?;
    for (_k, v) in plats {
        if let Some(posts) = v.get("posts").and_then(|x| x.as_array()) {
            for p in posts {
                if let Some(t) = p
                    .get("text")
                    .and_then(|x| x.as_str())
                    .and_then(|s| first_line(s, 80))
                {
                    return Some(t);
                }
            }
        }
        if let Some(md) = v
            .get("content_markdown")
            .and_then(|x| x.as_str())
            .and_then(|s| first_line(s.trim_start_matches('#').trim(), 80))
        {
            return Some(md);
        }
    }
    None
}

fn pick_rich_leaf(obj: &Value) -> Option<String> {
    pick_target_from(obj)
        .or_else(|| pick_pages_title(obj))
        .or_else(|| pick_post_text(obj))
        .or_else(|| {
            obj.get("id").and_then(|v| v.as_str()).and_then(|id| {
                if id.eq_ignore_ascii_case("self") {
                    Some("workspace".into())
                } else {
                    title_from_url(id)
                }
            })
        })
}

fn visit_arg_objects(v: &Value, depth: u8, f: &mut impl FnMut(&Value)) {
    if depth > 2 || !v.is_object() {
        return;
    }
    f(v);
    for wrap in MCP_ARG_WRAP {
        match v.get(*wrap) {
            Some(Value::String(s)) => {
                if let Ok(obj) = serde_json::from_str::<Value>(s) {
                    visit_arg_objects(&obj, depth + 1, f);
                }
            }
            Some(obj) if obj.is_object() => visit_arg_objects(obj, depth + 1, f),
            _ => {}
        }
    }
}

pub(crate) fn nested_target(input: &Value) -> Option<String> {
    let mut found = None;
    visit_arg_objects(input, 0, &mut |obj| {
        if found.is_none() {
            found = pick_rich_leaf(obj);
        }
    });
    found
}

pub(crate) fn json_u64(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    v.as_u64()
        .or_else(|| v.as_i64().and_then(|i| u64::try_from(i).ok()))
        .or_else(|| v.as_str()?.parse().ok())
}

pub(crate) fn clip_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &s[..end])
}

pub(crate) fn is_image_path(path: &str) -> bool {
    let p = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let Some((_, ext)) = p.rsplit_once('.') else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "heic" | "avif"
            | "tif" | "tiff"
    )
}

pub(crate) fn format_read_span(offset: Option<u64>, limit: Option<u64>) -> String {
    match (offset, limit) {
        (None, None) => "all".into(),
        (None, Some(n)) => format!("first {n} lines"),
        (Some(o), None) => format!("from line {}", if o == 0 { 1 } else { o }),
        (Some(o), Some(n)) => {
            let start = if o == 0 { 1 } else { o };
            format!(
                "lines {start}–{}",
                start.saturating_add(n.saturating_sub(1))
            )
        }
    }
}

pub(crate) fn ask_header(args: &Value) -> Option<String> {
    let arr = args.get("questions")?.as_array()?;
    let q = arr.first()?;
    for key in ["header", "question", "prompt", "title"] {
        if let Some(s) = q.get(key).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn str_from_keys(obj: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(t) = obj.get(*key).and_then(|v| v.as_str()).map(str::trim) {
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

pub(crate) fn nested_str(input: &Value, keys: &[&str]) -> Option<String> {
    let mut found = None;
    visit_arg_objects(input, 0, &mut |obj| {
        if found.is_none() {
            found = str_from_keys(obj, keys);
        }
    });
    found
}

pub(crate) const PATH_KEYS: &[&str] = &[
    "target_file",
    "target_directory",
    "path",
    "file_path",
    "file",
];

pub(crate) fn urls_from(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(arr) = v.get("sources").and_then(|x| x.as_array()) {
        for src in arr {
            if let Some(u) = src.get("url").and_then(|x| x.as_str()) {
                if !u.is_empty() {
                    out.push(u.to_string());
                }
            } else if let Some(u) = src.as_str() {
                if !u.is_empty() {
                    out.push(u.to_string());
                }
            }
        }
    }
    if let Some(u) = v.get("url").and_then(|x| x.as_str()) {
        if !u.is_empty() {
            out.push(u.to_string());
        }
    }
    out
}
