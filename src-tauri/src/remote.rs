use std::process::{Command, Stdio};

#[derive(Clone, Debug)]
pub struct SshProject {
    pub destination: String,
    pub path: String,
}

pub fn parse_project(value: &str) -> Result<Option<SshProject>, String> {
    let Some(raw) = value.strip_prefix("ssh://") else {
        return Ok(None);
    };
    let (destination, path) = raw
        .split_once('/')
        .ok_or_else(|| "VPS project URL must include an absolute path.".to_string())?;
    let (user, host) = destination.split_once('@').unwrap_or(("", destination));
    let valid_part = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if destination.starts_with('-')
        || destination.matches('@').count() > 1
        || (destination.contains('@') && user.is_empty())
        || (!user.is_empty() && !valid_part(user))
        || !valid_part(host)
    {
        return Err("VPS project URL has an invalid SSH user or host.".into());
    }
    let path = percent_decode(&format!("/{path}"))?;
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err("VPS project path must be an absolute path without control characters.".into());
    }
    Ok(Some(SshProject {
        destination: destination.to_string(),
        path,
    }))
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| "VPS project URL has invalid path encoding.".to_string())?;
            let hex = std::str::from_utf8(hex)
                .map_err(|_| "VPS project URL has invalid path encoding.".to_string())?;
            decoded.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "VPS project URL has invalid path encoding.".to_string())?,
            );
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "VPS project URL path is not valid UTF-8.".to_string())
}

fn ssh_base(target: &SshProject) -> Command {
    let mut command = Command::new("/usr/bin/ssh");
    command.args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
    command.arg(&target.destination);
    command
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn validate_project(value: &str) -> Result<(), String> {
    let target = parse_project(value)?.ok_or_else(|| "Not a VPS project.".to_string())?;
    let remote_command = format!(
        "test -d {} && command -v grok >/dev/null && grok --version >/dev/null && test -s \"$HOME/.grok/auth.json\"",
        shell_quote(&target.path)
    );
    let output = ssh_base(&target)
        .arg(remote_command)
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        "Could not open VPS project. Check SSH access, the project path, Grok Build, and run `grok login` on the VPS.".into()
    } else {
        format!("Could not open VPS project: {detail}")
    })
}

pub fn agent_command(target: &SshProject) -> Command {
    let mut command = ssh_base(target);
    command
        .arg("grok --permission-mode default agent stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
}
