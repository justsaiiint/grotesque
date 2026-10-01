use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use std::process::{Child, Command, Output, Stdio};

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
    valid_destination(destination)?;
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

#[derive(Clone, Serialize, Deserialize)]
struct SavedVps {
    id: String,
    user: String,
    host: String,
    port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    #[serde(default)]
    has_password: bool,
}

#[derive(Clone, Serialize)]
pub struct SavedVpsLabel {
    pub id: String,
    pub label: String,
}

struct SshLaunch {
    args: Vec<String>,
    askpass_id: Option<String>,
}

fn vps_support_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set.".to_string())?;
    Ok(std::path::PathBuf::from(home).join("Library/Application Support/com.justsaiiint.grokdesk"))
}

fn hosts_path() -> Result<std::path::PathBuf, String> {
    Ok(vps_support_dir()?.join("vps-hosts.json"))
}

fn load_saved() -> Result<Vec<SavedVps>, String> {
    let path = hosts_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read saved hosts: {e}"))?;
    if text.trim().is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str(&text).map_err(|_| "Saved hosts file is invalid.".to_string())
}

fn store_saved(rows: &[SavedVps]) -> Result<(), String> {
    let path = hosts_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not save the host: {e}"))?;
    }
    let text = serde_json::to_string_pretty(rows)
        .map_err(|_| "Could not save the host.".to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &text).map_err(|e| format!("Could not save the host: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save the host: {e}"))
}

fn saved_host(id: &str) -> Option<SavedVps> {
    load_saved().ok()?.into_iter().find(|row| row.id == id)
}

fn new_id(existing: &[SavedVps]) -> String {
    let mut bytes = [0u8; 4];
    if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = file.read_exact(&mut bytes);
    }
    let mut n = u32::from_be_bytes(bytes);
    loop {
        let id = format!("gvk{n:08x}");
        if existing.iter().all(|row| row.id != id) {
            return id;
        }
        n = n.wrapping_add(1);
    }
}

fn host_label(user: &str, host: &str, port: u16) -> String {
    format!("{user}@{host}:{port}")
}

fn name_part(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// PEM `Proc-Type`, PKCS#8 `BEGIN ENCRYPTED`, or an OpenSSH cipher other than `none`.
fn key_is_encrypted(text: &str) -> bool {
    let head: String = text.chars().take(800).collect();
    if head.contains("Proc-Type: 4,ENCRYPTED") || head.contains("BEGIN ENCRYPTED PRIVATE KEY") {
        return true;
    }
    let Some(rest) = head.split("-----BEGIN OPENSSH PRIVATE KEY-----").nth(1) else {
        return false;
    };
    let b64: String = rest
        .split_whitespace()
        .take_while(|word| !word.starts_with('-'))
        .collect();
    !b64.starts_with("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU")
}

const ASKPASS_BODY: &str = "#!/bin/sh\n/usr/bin/security find-generic-password -s grotesque-vps -a \"$GROTESQUE_VPS_ID\" -w\n";

fn askpass_ready(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode_ok = std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o777 == 0o700)
            .unwrap_or(false);
        if !mode_ok {
            return false;
        }
    }
    std::fs::read_to_string(path).ok().as_deref() == Some(ASKPASS_BODY)
}

fn askpass_script() -> Result<std::path::PathBuf, String> {
    let path = vps_support_dir()?.join("vps-askpass.sh");
    if askpass_ready(&path) {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not prepare SSH: {e}"))?;
    }
    std::fs::write(&path, ASKPASS_BODY).map_err(|e| format!("Could not prepare SSH: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Could not prepare SSH: {e}"))?;
    }
    Ok(path)
}

// ponytail: password is a security(1) argv for this one call. The stored copy is the Keychain item.
fn set_keychain(id: &str, password: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            "grotesque-vps",
            "-a",
            id,
            "-w",
            password,
        ])
        .output()
        .map_err(|e| format!("Could not save the password: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(&output, "Could not save the password."))
    }
}

fn delete_keychain(id: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            "grotesque-vps",
            "-a",
            id,
        ])
        .output()
        .map_err(|e| format!("Could not remove the password: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = command_error(&output, "Could not remove the password.");
    if detail.to_ascii_lowercase().contains("could not be found") {
        return Ok(());
    }
    Err(detail)
}

pub fn list_saved_hosts() -> Vec<SavedVpsLabel> {
    load_saved()
        .unwrap_or_default()
        .into_iter()
        .map(|row| SavedVpsLabel {
            label: host_label(&row.user, &row.host, row.port),
            id: row.id,
        })
        .collect()
}

pub fn save_host(
    host: &str,
    user: &str,
    port: u16,
    identity: Option<&str>,
    password: &str,
) -> Result<SavedVpsLabel, String> {
    let host = host.trim();
    let user = user.trim();
    let identity = identity.map(str::trim).filter(|s| !s.is_empty());
    if !name_part(host) || !name_part(user) {
        return Err("Enter a host and a user.".into());
    }
    if port == 0 {
        return Err("Use a port from 1 to 65535.".into());
    }
    if identity.is_none() && password.is_empty() {
        return Err("Add a private key or a password.".into());
    }
    if let Some(path) = identity {
        if path.chars().any(char::is_control) || path.contains('"') {
            return Err("That key path cannot be used.".into());
        }
        if !std::path::Path::new(path).is_file() {
            return Err("Private key file was not found.".into());
        }
        let bytes = std::fs::read(path).map_err(|e| format!("Could not read the private key: {e}"))?;
        let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
        if key_is_encrypted(&head) {
            return Err("That key has a passphrase. This form cannot unlock it. Use a key without a passphrase, or a password for the host.".into());
        }
    }
    let mut rows = load_saved()?;
    let previous = rows.clone();
    let id = rows
        .iter()
        .find(|row| row.user == user && row.host == host && row.port == port)
        .map(|row| row.id.clone())
        .unwrap_or_else(|| new_id(&rows));
    let row = SavedVps {
        id: id.clone(),
        user: user.to_string(),
        host: host.to_string(),
        port,
        identity: identity.map(str::to_string),
        has_password: !password.is_empty(),
    };
    if let Some(slot) = rows.iter_mut().find(|item| item.id == id) {
        *slot = row;
    } else {
        rows.push(row);
    }
    store_saved(&rows)?;
    // File lands first. A failed Keychain update rolls it back so has_password matches the secret.
    let keychain = if password.is_empty() {
        delete_keychain(&id)
    } else {
        set_keychain(&id, password)
    };
    if let Err(e) = keychain {
        if let Err(rollback) = store_saved(&previous) {
            return Err(format!("{e} Saved hosts could not be restored: {rollback}"));
        }
        return Err(e);
    }
    Ok(SavedVpsLabel {
        id,
        label: host_label(user, host, port),
    })
}

fn ssh_opt(key: &str, value: &str) -> String {
    if value.chars().any(char::is_whitespace) {
        format!("{key}=\"{value}\"")
    } else {
        format!("{key}={value}")
    }
}

fn ssh_launch(destination: &str, saved: Option<&SavedVps>) -> SshLaunch {
    let mut args = vec!["-T".to_string()];
    let Some(saved) = saved else {
        args.extend([
            "-o".into(),
            "BatchMode=yes".into(),
            "-o".into(),
            "ConnectTimeout=8".into(),
            destination.into(),
        ]);
        return SshLaunch {
            args,
            askpass_id: None,
        };
    };
    args.extend([
        "-o".into(),
        format!("HostName={}", saved.host),
        "-o".into(),
        format!("User={}", saved.user),
        "-o".into(),
        format!("Port={}", saved.port),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
    ]);
    if let Some(key) = &saved.identity {
        args.extend([
            "-o".into(),
            ssh_opt("IdentityFile", key),
            "-o".into(),
            "IdentitiesOnly=yes".into(),
        ]);
    }
    if saved.has_password {
        let auth = if saved.identity.is_some() {
            "publickey,password,keyboard-interactive"
        } else {
            "password,keyboard-interactive"
        };
        // Command-line -o is first, so these beat a Host * BatchMode yes in ssh config.
        args.extend([
            "-o".into(),
            "BatchMode=no".into(),
            "-o".into(),
            "PasswordAuthentication=yes".into(),
            "-o".into(),
            "KbdInteractiveAuthentication=yes".into(),
            "-o".into(),
            format!("PreferredAuthentications={auth}"),
        ]);
        args.push(destination.to_string());
        SshLaunch {
            args,
            askpass_id: Some(saved.id.clone()),
        }
    } else {
        args.extend(["-o".into(), "BatchMode=yes".into()]);
        args.push(destination.to_string());
        SshLaunch {
            args,
            askpass_id: None,
        }
    }
}

fn ssh_base(target: &SshProject) -> Result<Command, String> {
    let saved = saved_host(&target.destination);
    let launch = ssh_launch(&target.destination, saved.as_ref());
    let mut command = Command::new("/usr/bin/ssh");
    command.args(&launch.args);
    if let Some(id) = launch.askpass_id {
        let script = askpass_script()?;
        command.env("SSH_ASKPASS", &script);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("GROTESQUE_VPS_ID", id);
    }
    Ok(command)
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn grok_output(target: &SshProject, cwd: &str, args: &[&str]) -> Result<Output, String> {
    let mut command = format!("cd {} && exec grok", shell_quote(cwd));
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    ssh_base(target)?
        .arg(command)
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))
}

pub fn grok_json(target: &SshProject, cwd: &str, args: &[&str]) -> Result<Value, String> {
    let output = grok_output(target, cwd, args)?;
    if !output.status.success() {
        return Err(command_error(&output, "Grok CLI failed."));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Could not read Grok output.".to_string())
}

fn command_error(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = stderr.trim();
    if !message.is_empty() {
        return message.to_string();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = stdout.trim();
    if message.is_empty() {
        fallback.into()
    } else {
        message.to_string()
    }
}

pub fn python_json(
    target: &SshProject,
    script: &str,
    args: &[&str],
) -> Result<Value, String> {
    let mut command = format!("python3 -c {}", shell_quote(script));
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    let output = ssh_base(target)?
        .arg(command)
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "VPS command failed."));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Could not read VPS output.".to_string())
}

pub fn read_remote_file(target: &SshProject, path: &str) -> Result<String, String> {
    let script = "import os,sys\np=os.path.expanduser(sys.argv[1])\ntry: sys.stdout.buffer.write(open(p,'rb').read())\nexcept FileNotFoundError: pass";
    let output = ssh_base(target)?
        .arg(format!("python3 -c {} {}", shell_quote(script), shell_quote(path)))
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not read VPS file."));
    }
    String::from_utf8(output.stdout).map_err(|_| "Remote file is not valid UTF-8.".to_string())
}

const READ_TEXT_PY: &str = "\
import codecs, os, signal, sys
signal.alarm(8)
root=os.path.realpath(sys.argv[1])
p=os.path.realpath(sys.argv[2])
try:
 if os.path.commonpath([root, p]) != root: raise SystemExit('File is outside the project.')
except ValueError:
 raise SystemExit('File is outside the project.')
if not os.path.isfile(p): raise SystemExit('File is not on disk.')
data=open(p,'rb').read(80001)
dec=codecs.getincrementaldecoder('utf-8')('ignore')
text=dec.decode(data[:80000], True)
if len(data) > 80000: text += '\\u2026'
sys.stdout.buffer.write(text.encode())
";

const READ_SKILL_PY: &str = "\
import codecs, os, signal, sys
signal.alarm(8)
p=os.path.realpath(os.path.expanduser(sys.argv[1]))
if not os.path.isfile(p): raise SystemExit('Skill file not found.')
d=os.path.dirname(p)
for _ in range(8):
 if os.path.isfile(os.path.join(d,'SKILL.md')): break
 parent=os.path.dirname(d)
 if parent==d: raise SystemExit('File is not in a skill folder.')
 d=parent
else: raise SystemExit('File is not in a skill folder.')
if not os.path.commonpath([d, p])==d: raise SystemExit('File is outside the skill folder.')
raw=open(p,'rb').read(80001)
dec=codecs.getincrementaldecoder('utf-8')('ignore')
sys.stdout.buffer.write(dec.decode(raw[:80000], True).encode())
";

pub const LIST_SESSIONS_PY: &str = "\
import datetime, json, os, sys
root=os.path.expanduser('~/.grok/sessions/'+sys.argv[1])
FILLER=('<user_info>','<system-reminder>','<git_status>','This session is being continued')

def is_compact(t):
 t=t.strip()
 if not t.startswith('/compact'): return False
 rest=t[8:]
 return rest=='' or rest[:1].isspace()

def user_query(raw):
 start=raw.find('<user_query>')
 if start<0: return None
 rest=raw[start+12:]
 end=rest.find('</user_query>')
 if end<0: return None
 q=rest[:end].strip()
 return q or None

def extract_user_text(val):
 if not isinstance(val, dict) or 'synthetic_reason' in val: return None
 content=val.get('content') if 'content' in val else None
 if isinstance(content, list):
  for part in content:
   if not isinstance(part, dict): continue
   t=part.get('text')
   if not isinstance(t, str): continue
   q=user_query(t)
   if q: return q
  for part in content:
   if not isinstance(part, dict): continue
   t=part.get('text')
   if not isinstance(t, str): continue
   t=t.strip()
   if not t or t.startswith(FILLER) or len(t.encode())<=8: continue
   return t
  return None
 if isinstance(content, str):
  s=content.strip()
  return s or None
 return None

def looks_turn(line):
 return ('\"type\":\"user\"' in line or '\"type\": \"user\"' in line
  or '\"type\":\"assistant\"' in line or '\"type\": \"assistant\"' in line)

def line_has_prompt(line):
 line=line.strip()
 if not line or not looks_turn(line): return False
 try: val=json.loads(line)
 except json.JSONDecodeError: return False
 return val.get('type')=='user' and extract_user_text(val) is not None

def file_has_prompt(path):
 try: f=open(path, encoding='utf-8', errors='replace')
 except OSError: return False
 with f:
  for line in f:
   if line_has_prompt(line): return True
 return False

def updates_have_prompt(path):
 try: f=open(path, encoding='utf-8', errors='replace')
 except OSError: return False
 with f:
  for line in f:
   if 'user_message_chunk' not in line: continue
   try: val=json.loads(line)
   except json.JSONDecodeError: continue
   params=val.get('params')
   if not isinstance(params, dict): continue
   kind=params.get('sessionUpdate')
   update=params
   if not isinstance(kind, str):
    update=params.get('update')
    if not isinstance(update, dict): continue
    kind=update.get('sessionUpdate')
   if kind!='user_message_chunk': continue
   content=update.get('content')
   t=content.get('text') if isinstance(content, dict) else ''
   if not isinstance(t, str): continue
   t=t.strip()
   if t and not t.startswith(FILLER) and not is_compact(t): return True
 return False

def iso_mtime(path):
 try: ts=os.path.getmtime(path)
 except OSError: return ''
 return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

try: names=os.listdir(root)
except OSError: names=[]
rows=[]
for sid in names:
 d=os.path.join(root, sid)
 if not os.path.isdir(d) or len(sid)<8: continue
 if not file_has_prompt(os.path.join(d,'chat_history.jsonl')) and not updates_have_prompt(os.path.join(d,'updates.jsonl')): continue
 title='Chat'
 updated=''
 try:
  s=json.load(open(os.path.join(d,'summary.json'), encoding='utf-8'))
  if s.get('session_kind')=='subagent': continue
  got=s.get('generated_title')
  title=(got.strip() if isinstance(got, str) else '') or 'Chat'
  updated=s.get('updated_at') if isinstance(s.get('updated_at'), str) else ''
  if not updated:
   last=s.get('last_active_at')
   updated=last if isinstance(last, str) else ''
 except (OSError, UnicodeError, json.JSONDecodeError, AttributeError):
  pass
 if not updated: updated=iso_mtime(d)
 rows.append({'sessionId':sid,'title':title,'updatedAt':updated})
rows.sort(key=lambda x: x['updatedAt'], reverse=True)
print(json.dumps(rows[:500]))
";

pub fn read_project_file(target: &SshProject, path: &str) -> Result<String, String> {
    let output = ssh_base(target)?
        .arg(format!(
            "python3 -c {} {} {}",
            shell_quote(READ_TEXT_PY),
            shell_quote(&target.path),
            shell_quote(path)
        ))
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not read VPS file."));
    }
    String::from_utf8(output.stdout).map_err(|_| "VPS file is not valid UTF-8.".to_string())
}

pub fn read_skill_file(target: &SshProject, path: &str) -> Result<String, String> {
    let output = ssh_base(target)?
        .arg(format!(
            "python3 -c {} {}",
            shell_quote(READ_SKILL_PY),
            shell_quote(path)
        ))
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not read VPS skill file."));
    }
    String::from_utf8(output.stdout).map_err(|_| "VPS skill file is not valid UTF-8.".into())
}

pub fn write_skill_file(target: &SshProject, path: &str, content: &str) -> Result<(), String> {
    let script = "import os,sys,tempfile\np=os.path.realpath(os.path.expanduser(sys.argv[1]))\nif not os.path.isfile(p): raise SystemExit('Skill file not found.')\nd=os.path.dirname(p)\nfor _ in range(8):\n if os.path.isfile(os.path.join(d,'SKILL.md')): break\n parent=os.path.dirname(d)\n if parent==d: raise SystemExit('File is not in a skill folder.')\n d=parent\nelse: raise SystemExit('File is not in a skill folder.')\nif not os.path.commonpath([d,p])==d: raise SystemExit('File is outside the skill folder.')\nmode=os.stat(p).st_mode & 0o777\nfd,t=tempfile.mkstemp(dir=os.path.dirname(p))\ntry:\n os.fchmod(fd,mode)\n with os.fdopen(fd,'wb') as f: f.write(sys.stdin.buffer.read())\n os.replace(t,p)\nexcept:\n try: os.unlink(t)\n except OSError: pass\n raise";
    let mut command = ssh_base(target)?;
    command
        .arg(format!("python3 -c {} {}", shell_quote(script), shell_quote(path)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "SSH stdin missing.".to_string())?
        .write_all(content.as_bytes())
        .map_err(|e| format!("Could not send VPS skill file: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Could not finish SSH: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(&output, "Could not update VPS skill file."))
    }
}

pub fn write_remote_file(target: &SshProject, path: &str, content: &str) -> Result<(), String> {
    let script = "import os,sys,tempfile\np=os.path.expanduser(sys.argv[1])\nd=os.path.dirname(p)\nos.makedirs(d, exist_ok=True)\nfd,t=tempfile.mkstemp(dir=d)\ntry:\n os.fchmod(fd,0o600)\n with os.fdopen(fd,'wb') as f: f.write(sys.stdin.buffer.read())\n os.replace(t,p)\nexcept:\n try: os.unlink(t)\n except OSError: pass\n raise";
    let mut command = ssh_base(target)?;
    command
        .arg(format!(
            "python3 -c {} {}",
            shell_quote(script),
            shell_quote(path)
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "SSH stdin missing.".to_string())?
        .write_all(content.as_bytes())
        .map_err(|e| format!("Could not send VPS config: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Could not finish SSH: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_error(&output, "Could not update VPS config."))
    }
}

const FETCH_IMAGE_PY: &str = r#"
import os, sys
p = sys.argv[1]
if not p.startswith('/') or any(ord(c) < 32 for c in p):
    raise SystemExit('Not an image.')
real = os.path.realpath(p)
if not os.path.isfile(real):
    raise SystemExit('Not an image.')
name = os.path.basename(real).lower()
exts = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.heic', '.avif', '.tif', '.tiff')
if not name.endswith(exts):
    raise SystemExit('Not an image.')
size = os.path.getsize(real)
if size <= 0 or size > 12 * 1024 * 1024:
    raise SystemExit('Image is too large (12 MB max).')
sys.stdout.buffer.write(open(real, 'rb').read())
"#;

const UPLOAD_ATTACH_PY: &str = r#"
import os, sys
rel = sys.argv[1]
prefix = '~/.grok/grotesque-attach/'
if not rel.startswith(prefix):
    raise SystemExit('Bad attach path.')
rest = rel[len(prefix):]
parts = rest.split('/')
if len(parts) != 2 or not parts[0] or not parts[1] or parts[1] in ('.', '..'):
    raise SystemExit('Bad attach path.')
name = parts[1]
if any(ord(c) < 32 or c in '/\\' for c in name):
    raise SystemExit('Bad attach name.')
p = os.path.expanduser(rel)
os.makedirs(os.path.dirname(p), exist_ok=True)
data = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
if len(data) > 32 * 1024 * 1024:
    raise SystemExit('File is too large (32 MB max).')
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
try:
    os.write(fd, data)
finally:
    os.close(fd)
print(os.path.realpath(p))
"#;

const SIDE_DIR_PY: &str = r#"
import os, sys
slug = sys.argv[1]
if not slug or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_' for c in slug):
    raise SystemExit('Bad side folder.')
d = os.path.expanduser('~/.grok/grotesque-side/' + slug)
os.makedirs(d, exist_ok=True)
print(os.path.realpath(d))
"#;

const SEARCH_PY: &str = r#"
import json, os, sys
root = os.path.expanduser('~/.grok/sessions/' + sys.argv[1])
rows = []
try:
    names = os.listdir(root)
except OSError:
    names = []
for sid in names:
    if not sid or any(c.isspace() for c in sid):
        continue
    d = os.path.join(root, sid)
    if not os.path.isdir(d) or len(sid) < 8:
        continue
    try:
        mtime = os.path.getmtime(d)
    except OSError:
        continue
    rows.append((mtime, sid, d))
rows.sort(reverse=True)

def scrub(v):
    if isinstance(v, dict):
        if v.get('type') in ('image', 'ImageContent'):
            return None
        out = {}
        for k, val in v.items():
            if k == 'data' and isinstance(val, str) and len(val) > 256:
                continue
            child = scrub(val)
            if child is None:
                continue
            out[k] = child
        return out
    if isinstance(v, list):
        return [c for c in (scrub(i) for i in v) if c is not None]
    return v

def has_text(v):
    if isinstance(v, dict):
        for key in ('text', 'content'):
            val = v.get(key)
            if isinstance(val, str) and val.strip():
                return True
        return any(has_text(x) for x in v.values())
    if isinstance(v, list):
        return any(has_text(x) for x in v)
    return False

def filtered(path):
    try:
        f = open(path, encoding='utf-8', errors='replace')
    except OSError:
        return []
    out = []
    with f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                if 'data:image' in raw:
                    continue
                out.append(raw + '\n')
                continue
            obj = scrub(obj)
            if not has_text(obj):
                continue
            out.append(json.dumps(obj, ensure_ascii=False, separators=(',', ':')) + '\n')
    return out

# ponytail: newest 40 sessions per VPS folder; raise when older chats must be searchable
for _, sid, d in rows[:40]:
    lines = filtered(os.path.join(d, 'updates.jsonl')) + filtered(os.path.join(d, 'chat_history.jsonl'))
    if not lines:
        continue
    sys.stdout.write('\x1e' + sid + '\n')
    sys.stdout.write(''.join(lines))
"#;

const PATHS_EXIST_PY: &str = r#"
import json, os, sys
root = os.path.realpath(sys.argv[1])
try:
    raws = json.loads(sys.argv[2])
except Exception:
    raws = []
if not isinstance(raws, list):
    raws = []
out = []
seen = set()

def under(candidate):
    try:
        canon = os.path.realpath(candidate)
    except OSError:
        return None
    if not (os.path.isfile(canon) or os.path.isdir(canon)):
        return None
    try:
        if os.path.commonpath([root, canon]) != root:
            return None
    except ValueError:
        return None
    return canon

for raw in raws[:64]:
    if not isinstance(raw, str):
        continue
    key = raw.strip()
    if not key or key in seen:
        continue
    seen.add(key)
    p = key
    if p.startswith('file://'):
        p = p[7:]
    p = p.replace('\\', '/')
    if p in ('', '/', '.', './', '..'):
        continue
    if p == '~' or p.startswith('~/'):
        p = os.path.expanduser(p)
    hit = None
    if p.startswith('/'):
        hit = under(p)
        if hit is None and not p.startswith('//'):
            rel = p[1:]
            if rel:
                hit = under(os.path.join(root, rel))
    else:
        rel = p[2:] if p.startswith('./') else p
        hit = under(os.path.join(root, rel))
    if hit:
        out.append({'raw': key, 'path': hit})
print(json.dumps(out))
"#;

fn normalize_abs(path: &str) -> String {
    let mut out = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop();
            continue;
        }
        out.push(part);
    }
    format!("/{}", out.join("/"))
}

pub fn resolve_image_path(root: &str, raw: &str) -> Result<String, String> {
    let mut path = raw.trim().to_string();
    if let Some(rest) = path.strip_prefix("file://") {
        path = rest.to_string();
    }
    if path.is_empty() || path.starts_with('~') || path.chars().any(char::is_control) {
        return Err("Not an image.".into());
    }
    if !path.starts_with('/') {
        let rel = path.trim_start_matches("./");
        let base = root.trim_end_matches('/');
        path = format!("{base}/{rel}");
    }
    let path = normalize_abs(&path);
    if path == "/" || path.chars().any(char::is_control) {
        return Err("Not an image.".into());
    }
    Ok(path)
}

pub fn fetch_image_bytes(target: &SshProject, abs: &str) -> Result<Vec<u8>, String> {
    if !abs.starts_with('/') || abs.chars().any(char::is_control) {
        return Err("Not an image.".into());
    }
    let output = ssh_base(target)?
        .arg(format!(
            "python3 -c {} {}",
            shell_quote(FETCH_IMAGE_PY),
            shell_quote(abs)
        ))
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not read the image."));
    }
    if output.stdout.is_empty() || output.stdout.len() > 12 * 1024 * 1024 {
        return Err("Image is empty or too large.".into());
    }
    Ok(output.stdout)
}

fn ssh_python_stdin(
    target: &SshProject,
    script: &str,
    arg: &str,
    bytes: &[u8],
) -> Result<Output, String> {
    let mut command = ssh_base(target)?;
    command
        .arg(format!(
            "python3 -c {} {}",
            shell_quote(script),
            shell_quote(arg)
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    let write_err = match child.stdin.take() {
        None => Some("SSH stdin missing.".to_string()),
        Some(mut stdin) => stdin
            .write_all(bytes)
            .err()
            .map(|e| format!("Could not send the file: {e}")),
    };
    finish_child(child, write_err)
}

/// `write_err` means stdin never finished. Reap the child either way.
fn finish_child(mut child: Child, write_err: Option<String>) -> Result<Output, String> {
    if let Some(e) = write_err {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    child
        .wait_with_output()
        .map_err(|e| format!("Could not finish SSH: {e}"))
}

pub fn upload_attach_bytes(target: &SshProject, rel: &str, bytes: &[u8]) -> Result<String, String> {
    let output = ssh_python_stdin(target, UPLOAD_ATTACH_PY, rel, bytes)?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not upload the file."));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !path.starts_with('/') {
        return Err("Upload did not return a path.".into());
    }
    Ok(path)
}

pub fn ensure_side_dir(target: &SshProject, slug: &str) -> Result<String, String> {
    if slug.is_empty() || !slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Bad side folder.".into());
    }
    let output = ssh_base(target)?
        .arg(format!(
            "python3 -c {} {}",
            shell_quote(SIDE_DIR_PY),
            shell_quote(slug)
        ))
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not create the side folder."));
    }
    let path = String::from_utf8(output.stdout)
        .map_err(|_| "Side folder path is not valid UTF-8.".to_string())?;
    let path = path.trim();
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err("Side folder path was not absolute.".into());
    }
    Ok(path.to_string())
}

pub fn ssh_project_url(destination: &str, path: &str) -> String {
    format!(
        "ssh://{destination}{}",
        crate::percent_encode_path(path)
    )
}

pub fn search_session_blob(target: &SshProject, encoded: &str) -> Result<String, String> {
    let output = ssh_base(target)?
        .arg(format!(
            "python3 -c {} {}",
            shell_quote(SEARCH_PY),
            shell_quote(encoded)
        ))
        .output()
        .map_err(|e| format!("Could not start SSH: {e}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Could not search VPS chats."));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn paths_exist(target: &SshProject, paths: &[String]) -> Result<Vec<(String, String)>, String> {
    let payload = serde_json::to_string(paths).unwrap_or_else(|_| "[]".into());
    let hits = python_json(target, PATHS_EXIST_PY, &[&target.path, &payload])?;
    let mut out = Vec::new();
    for row in hits.as_array().into_iter().flatten() {
        let raw = row.get("raw").and_then(|v| v.as_str()).unwrap_or("");
        let path = row.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if raw.is_empty() || !path.starts_with('/') {
            continue;
        }
        out.push((raw.to_string(), path.to_string()));
    }
    Ok(out)
}

pub fn validate_project(value: &str) -> Result<(), String> {
    let target = parse_project(value)?.ok_or_else(|| "Not a VPS project.".to_string())?;
    let remote_command = format!(
        "test -d {} && command -v grok >/dev/null && grok --version >/dev/null && test -s \"$HOME/.grok/auth.json\"",
        shell_quote(&target.path)
    );
    let output = ssh_base(&target)?
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

pub fn valid_destination(destination: &str) -> Result<(), String> {
    let (user, host) = destination.split_once('@').unwrap_or(("", destination));
    let valid_part = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    if destination.is_empty()
        || destination.starts_with('-')
        || destination.matches('@').count() > 1
        || (destination.contains('@') && user.is_empty())
        || (!user.is_empty() && !valid_part(user))
        || !valid_part(host)
    {
        return Err("VPS project URL has an invalid SSH user or host.".into());
    }
    Ok(())
}

fn strip_ssh_comment(line: &str) -> &str {
    let mut quote: Option<char> = None;
    for (i, c) in line.char_indices() {
        match (quote, c) {
            (None, '#') => return &line[..i],
            (None, '"' | '\'') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            _ => {}
        }
    }
    line
}

/// `Host` aliases from an OpenSSH config. Wildcards and aliases this app cannot dial are dropped.
pub fn ssh_config_hosts(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in text.lines() {
        let line = strip_ssh_comment(raw).trim();
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for token in parts {
            let alias = token.trim_matches(|c| c == '"' || c == '\'');
            if alias.is_empty() || alias.contains(['*', '?', '!']) {
                continue;
            }
            if valid_destination(alias).is_err() || !seen.insert(alias.to_string()) {
                continue;
            }
            out.push(alias.to_string());
        }
    }
    out
}

pub fn ssh_config_hosts_from_home() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(std::path::Path::new(&home).join(".ssh/config")) else {
        return vec![];
    };
    ssh_config_hosts(&text)
}

/// Grok encodes a session cwd by replacing `/` with `%2F` and nothing else.
#[cfg(test)]
pub fn session_cwd_path(encoded: &str) -> String {
    encoded.replace("%2F", "/")
}

#[cfg(test)]
fn parent_dir(path: &str) -> String {
    let path = path.trim_end_matches('/');
    match path.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => path[..i].to_string(),
    }
}

/// Directories the first folder list scans. A known project whose parent is `/`
/// is scanned itself. `/` is never included.
#[cfg(test)]
pub fn parents_to_list(known: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for path in known {
        let parent = parent_dir(path);
        let dir = if parent == "/" {
            path.clone()
        } else {
            parent
        };
        if dir == "/" || !seen.insert(dir.clone()) {
            continue;
        }
        out.push(dir);
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirRow {
    pub path: String,
    pub known: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirList {
    pub rows: Vec<RemoteDirRow>,
    pub truncated: bool,
    pub browse: String,
}

fn folder_sort_key(path: &str) -> String {
    path.rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or(path)
        .to_lowercase()
}

/// Known projects stay even past the cap. `cap` limits the other rows.
pub fn merge_remote_dirs(
    known: &[String],
    children: &[String],
    cap: usize,
) -> (Vec<RemoteDirRow>, bool) {
    let mut seen = HashSet::new();
    let mut known_rows = Vec::new();
    for path in known {
        if path.is_empty() || !seen.insert(path.clone()) {
            continue;
        }
        known_rows.push(path.clone());
    }
    known_rows.sort_by(|a, b| folder_sort_key(a).cmp(&folder_sort_key(b)));
    let mut rest = Vec::new();
    for path in children {
        if path.is_empty() || seen.contains(path) {
            continue;
        }
        if seen.insert(path.clone()) {
            rest.push(path.clone());
        }
    }
    rest.sort_by(|a, b| folder_sort_key(a).cmp(&folder_sort_key(b)));
    // ponytail: 400 names per listing; a narrower path if a folder is larger
    let truncated = rest.len() > cap;
    if truncated {
        rest.truncate(cap);
    }
    let mut rows: Vec<RemoteDirRow> = known_rows
        .into_iter()
        .map(|path| RemoteDirRow { path, known: true })
        .collect();
    rows.extend(rest.into_iter().map(|path| RemoteDirRow {
        path,
        known: false,
    }));
    (rows, truncated)
}

const LIST_DIRS_PY: &str = "\
import json, os, sys
browse = sys.argv[1] if len(sys.argv) > 1 else ''
CAP = 400

def parent_of(path):
    path = path.rstrip('/') or '/'
    if path == '/':
        return '/'
    i = path.rfind('/')
    return '/' if i <= 0 else path[:i]

def kids(parent, show_hidden=False):
    found = []
    try:
        names = os.listdir(parent)
    except OSError:
        return found
    for name in names:
        if not name or any(ord(c) < 32 for c in name):
            continue
        # Dot dirs show only while browsing one folder. The project scan skips them.
        if name.startswith('.') and not show_hidden:
            continue
        full = os.path.join(parent, name)
        try:
            if os.path.isdir(full):
                found.append(full)
        except OSError:
            continue
    found.sort(key=str.lower)
    return found

def known_paths():
    root = os.path.expanduser('~/.grok/sessions')
    out = []
    try:
        encs = os.listdir(root)
    except OSError:
        return out
    for enc in encs:
        if not os.path.isdir(os.path.join(root, enc)):
            continue
        path = enc.replace('%2F', '/')
        if path.startswith('/') and os.path.isdir(path):
            out.append(path)
    return out

truncated = False
if browse:
    known = []
    ok = browse.startswith('/') and not any(ord(c) < 32 for c in browse)
    children = kids(browse, True) if ok else []
    if len(children) > CAP:
        children = children[:CAP]
        truncated = True
else:
    known = known_paths()
    parents = []
    seen = set()
    for path in known:
        parent = parent_of(path)
        scan = path if parent == '/' else parent
        if scan != '/' and scan not in seen:
            seen.add(scan)
            parents.append(scan)
    if not known:
        home = os.path.expanduser('~')
        if home and home != '/':
            parents.append(home)
    children = []
    for parent in parents:
        for full in kids(parent):
            if len(children) >= CAP:
                truncated = True
                break
            children.append(full)
        if truncated:
            break
print(json.dumps({'known': known, 'children': children, 'truncated': truncated, 'browse': browse}))
";

pub fn list_remote_dirs(destination: &str, browse: Option<&str>) -> Result<RemoteDirList, String> {
    valid_destination(destination)?;
    let browse = browse.unwrap_or("").trim();
    if !browse.is_empty() && (!browse.starts_with('/') || browse.chars().any(char::is_control)) {
        return Err("Use an absolute path.".into());
    }
    let target = SshProject {
        destination: destination.to_string(),
        path: "/".into(),
    };
    let val = python_json(&target, LIST_DIRS_PY, &[browse])?;
    let known = string_list(val.get("known"));
    let children = string_list(val.get("children"));
    let py_trunc = val
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let known_for_merge: Vec<String> = if browse.is_empty() {
        known
    } else {
        let child_set: HashSet<&str> = children.iter().map(String::as_str).collect();
        known
            .into_iter()
            .filter(|path| child_set.contains(path.as_str()))
            .collect()
    };
    let (rows, truncated) = merge_remote_dirs(&known_for_merge, &children, 400);
    Ok(RemoteDirList {
        rows,
        truncated: truncated || py_trunc,
        browse: browse.to_string(),
    })
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

pub fn agent_command(target: &SshProject) -> Result<Command, String> {
    let mut command = ssh_base(target)?;
    command
        .arg("grok --permission-mode default agent stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::{
        merge_remote_dirs, parents_to_list, session_cwd_path, ssh_config_hosts, valid_destination,
    };

    #[test]
    fn ssh_config_hosts_skip_wildcards_and_comments() {
        let text = "\
# Host hidden
Host vps # tailscale
Host new_xpipe mac-local-codex
HOST imac
Host imac-ts
Host *
Host *.local
HostName 10.0.0.1
Host -bad
";
        assert_eq!(
            ssh_config_hosts(text),
            vec!["vps", "new_xpipe", "mac-local-codex", "imac", "imac-ts"]
        );
    }

    #[test]
    fn root_session_does_not_expand_slash() {
        assert_eq!(session_cwd_path("%2Froot"), "/root");
        assert_eq!(
            session_cwd_path("%2Fopt%2Fdocker%2Fapps%2FMoeSite"),
            "/opt/docker/apps/MoeSite"
        );
        let listed = parents_to_list(&[
            "/root".into(),
            "/opt/docker/apps/MoeSite".into(),
            "/opt/docker/apps/wrapper".into(),
        ]);
        assert_eq!(
            listed,
            vec!["/root".to_string(), "/opt/docker/apps".to_string()]
        );
        assert!(!listed.iter().any(|p| p == "/" || p == "/bin"));
    }

    #[test]
    fn destination_rejects_leading_dash() {
        assert!(valid_destination("-oProxyCommand=x").is_err());
        assert!(valid_destination("vps").is_ok());
        assert!(valid_destination("root@moevps").is_ok());
    }

    #[test]
    fn duplicate_child_paths_collapse() {
        let (rows, truncated) = merge_remote_dirs(
            &["/opt/docker/apps/MoeSite".into()],
            &[
                "/opt/docker/apps/MoeSite".into(),
                "/opt/docker/apps/wrapper".into(),
                "/opt/docker/apps/wrapper".into(),
            ],
            400,
        );
        assert!(!truncated);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].known && rows[0].path.ends_with("MoeSite"));
        assert!(!rows[1].known && rows[1].path.ends_with("wrapper"));
    }

    #[test]
    fn browse_shows_hidden_dirs_scan_does_not() {
        let tmp = std::env::temp_dir().join(format!("grotesque-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("visible")).unwrap();
        std::fs::create_dir_all(tmp.join(".hidden")).unwrap();
        std::fs::write(tmp.join("note.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(tmp.join("visible"), tmp.join("linkdir")).unwrap();
        let root = tmp.to_str().unwrap();

        let names = |output: std::process::Output| -> Vec<String> {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let val: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            val["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        };

        let scan = names(py(super::LIST_DIRS_PY, Some(&tmp), &[]));
        assert!(scan.iter().all(|p| p.starts_with(root)));
        assert!(scan.iter().any(|p| p.ends_with("/visible")));
        assert!(scan.iter().any(|p| p.ends_with("/linkdir")));
        assert!(!scan.iter().any(|p| p.ends_with("/.hidden") || p.ends_with("/note.txt")));

        let listed = py(super::LIST_DIRS_PY, Some(&tmp), &[tmp.clone()]);
        assert!(listed.status.success(), "{}", String::from_utf8_lossy(&listed.stderr));
        let val: serde_json::Value = serde_json::from_slice(&listed.stdout).unwrap();
        assert_eq!(val["browse"].as_str(), Some(root));
        let browsed: Vec<&str> = val["children"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(browsed.iter().any(|p| p.ends_with("/.hidden")));
        assert!(browsed.iter().any(|p| p.ends_with("/visible")));
        assert!(browsed.iter().any(|p| p.ends_with("/linkdir")));
        assert!(!browsed.iter().any(|p| p.ends_with("/note.txt")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn py(script: &str, home: Option<&std::path::Path>, args: &[std::path::PathBuf]) -> std::process::Output {
        let mut cmd = std::process::Command::new("python3");
        cmd.arg("-c").arg(script);
        if let Some(home) = home {
            cmd.env("HOME", home);
        }
        for arg in args {
            cmd.arg(arg);
        }
        cmd.output().expect("python3")
    }

    #[test]
    fn remote_session_list_keeps_real_prompts_and_iso_times() {
        let tmp = std::env::temp_dir().join(format!("grotesque-sessions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join(".grok/sessions/%2Fwork");
        std::fs::create_dir_all(&root).unwrap();
        let write = |id: &str, name: &str, body: &str| {
            let dir = root.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(name), body).unwrap();
        };
        write("promptses", "chat_history.jsonl", "{\"type\":\"user\",\"content\":\"hello there\"}\n");
        write("promptses", "summary.json", "{\"generated_title\":\"Hello\"}\n");
        write("emptyses1", "summary.json", "{\"generated_title\":\"Empty\"}\n");
        write(
            "fillerses",
            "chat_history.jsonl",
            "{\"type\":\"user\",\"content\":[{\"text\":\"<user_info>abcdefghij\"}]}\n",
        );
        write("subagents", "chat_history.jsonl", "{\"type\":\"user\",\"content\":\"hello there\"}\n");
        write(
            "subagents",
            "summary.json",
            "{\"session_kind\":\"subagent\",\"generated_title\":\"Sub\"}\n",
        );
        write(
            "updateses",
            "updates.jsonl",
            "{\"params\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"text\":\"real question\"}}}\n",
        );
        write("updateses", "summary.json", "{\"updated_at\":\"2020-01-01T00:00:00Z\"}\n");
        write(
            "compactses",
            "updates.jsonl",
            "{\"params\":{\"sessionUpdate\":\"user_message_chunk\",\"content\":{\"text\":\"/compact\"}}}\n",
        );
        write(
            "queryonly1",
            "chat_history.jsonl",
            "{\"type\":\"user\",\"content\":[{\"text\":\"<user_query>ship it</user_query>\"}]}\n",
        );

        let output = py(super::LIST_SESSIONS_PY, Some(&tmp), &[std::path::PathBuf::from("%2Fwork")]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
        let ids: Vec<&str> = rows
            .iter()
            .filter_map(|row| row.get("sessionId").and_then(|v| v.as_str()))
            .collect();
        assert!(ids.contains(&"promptses"));
        assert!(ids.contains(&"updateses"));
        assert!(ids.contains(&"queryonly1"));
        assert!(!ids.contains(&"emptyses1"));
        assert!(!ids.contains(&"fillerses"));
        assert!(!ids.contains(&"subagents"));
        assert!(!ids.contains(&"compactses"));
        assert_eq!(ids.last().copied(), Some("updateses"));
        let updated = rows
            .iter()
            .find(|row| row["sessionId"] == "promptses")
            .unwrap()["updatedAt"]
            .as_str()
            .unwrap();
        assert!(updated.contains('T') && updated.ends_with('Z'), "{updated}");
        assert!(!updated.contains('.'));
        assert_eq!(
            rows.iter().find(|row| row["sessionId"] == "updateses").unwrap()["updatedAt"],
            "2020-01-01T00:00:00Z"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn remote_text_read_stops_at_utf8_and_project_root() {
        let tmp = std::env::temp_dir().join(format!("grotesque-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), "secret-bytes").unwrap();
        std::os::unix::fs::symlink(outside.join("secret"), proj.join("leak")).unwrap();
        let mut big = vec![b'a'; 79_999];
        big.extend_from_slice(&[0xC3, 0xA9, b'b']);
        std::fs::write(proj.join("big.txt"), &big).unwrap();
        std::fs::write(proj.join("small.txt"), "café").unwrap();

        let leak = py(super::READ_TEXT_PY, None, &[proj.clone(), proj.join("leak")]);
        assert!(!leak.status.success());
        assert!(leak.stdout.is_empty());

        let small = py(super::READ_TEXT_PY, None, &[proj.clone(), proj.join("small.txt")]);
        assert_eq!(small.stdout, "café".as_bytes());

        let cut = py(super::READ_TEXT_PY, None, &[proj.clone(), proj.join("big.txt")]);
        assert!(cut.status.success(), "{}", String::from_utf8_lossy(&cut.stderr));
        let text = String::from_utf8(cut.stdout).unwrap();
        assert!(text.ends_with('…'));
        assert_eq!(text.chars().filter(|c| *c == 'a').count(), 79_999);
        assert!(!text.contains('é'));

        let skill = proj.join("skills/demo");
        std::fs::create_dir_all(&skill).unwrap();
        let mut skill_body = vec![b'a'; 79_999];
        skill_body.push(0xC3);
        std::fs::write(skill.join("SKILL.md"), &skill_body).unwrap();
        let skill_out = py(super::READ_SKILL_PY, None, &[skill.join("SKILL.md")]);
        assert!(
            skill_out.status.success(),
            "{}",
            String::from_utf8_lossy(&skill_out.stderr)
        );
        assert_eq!(skill_out.stdout, vec![b'a'; 79_999]);
        std::fs::write(skill.join("note.md"), "café").unwrap();
        let note = py(super::READ_SKILL_PY, None, &[skill.join("note.md")]);
        assert_eq!(note.stdout, "café".as_bytes());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn image_fetch_refuses_non_image() {
        let tmp = std::env::temp_dir().join(format!("grotesque-img-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let txt = tmp.join("notes.txt");
        std::fs::write(&txt, b"hello").unwrap();
        let refused = py(super::FETCH_IMAGE_PY, None, &[txt.clone()]);
        assert!(!refused.status.success());
        assert!(refused.stdout.is_empty());
        std::os::unix::fs::symlink(&txt, tmp.join("fake.png")).unwrap();
        let linked = py(super::FETCH_IMAGE_PY, None, &[tmp.join("fake.png")]);
        assert!(!linked.status.success());
        assert!(linked.stdout.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn side_url_stays_on_the_host() {
        let url = super::ssh_project_url("vps", "/root/.grok/grotesque-side/side_1");
        let parsed = super::parse_project(&url).unwrap().unwrap();
        assert_eq!(parsed.destination, "vps");
        assert_eq!(parsed.path, "/root/.grok/grotesque-side/side_1");
    }

    #[test]
    fn path_chips_stay_in_the_project() {
        let tmp = std::env::temp_dir().join(format!("grotesque-paths-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let proj = tmp.join("proj");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(proj.join("ok.txt"), b"ok").unwrap();
        std::fs::write(outside.join("secret.txt"), b"no").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), proj.join("leak")).unwrap();
        let payload = serde_json::json!([
            "ok.txt",
            "leak",
            outside.join("secret.txt").to_string_lossy().as_ref(),
        ])
        .to_string();
        let out = py(
            super::PATHS_EXIST_PY,
            None,
            &[proj, std::path::PathBuf::from(payload)],
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let rows: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["raw"], "ok.txt");
        assert!(rows[0]["path"].as_str().unwrap().ends_with("/ok.txt"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn search_keeps_text_beside_an_image() {
        let tmp = std::env::temp_dir().join(format!("grotesque-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = tmp.join(".grok/sessions/%2Fwork/session01");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("chat_history.jsonl"),
            concat!(
                r#"{"type":"user","content":[{"type":"text","text":"<user_query>weekly-report please</user_query>"},{"type":"image","data":"data:image/png;base64,AAAA"}]}"#,
                "\n",
                r#"{"type":"user","content":[{"type":"image","data":"data:image/png;base64,BBBB"}]}"#,
                "\n",
            ),
        )
        .unwrap();
        let out = py(
            super::SEARCH_PY,
            Some(&tmp),
            &[std::path::PathBuf::from("%2Fwork")],
        );
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(stdout.contains("weekly-report"), "{stdout}");
        assert!(!stdout.contains("AAAA"), "{stdout}");
        assert!(!stdout.contains("BBBB"), "{stdout}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stdin_failure_reaps_the_child() {
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let err = super::finish_child(child, Some("nope".into())).unwrap_err();
        assert_eq!(err, "nope");
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap();
        assert!(!alive.success());
    }

    #[test]
    fn saved_host_ssh_keeps_password_out_of_the_command() {
        let key = super::SavedVps {
            id: "gvk00000001".into(),
            user: "root".into(),
            host: "example.com".into(),
            port: 2222,
            identity: Some("/tmp/id_ed25519".into()),
            has_password: false,
        };
        let keyed = super::ssh_launch("gvk00000001", Some(&key));
        let keyed_text = keyed.args.join(" ");
        assert!(keyed_text.contains("BatchMode=yes"));
        assert!(keyed_text.contains("Port=2222"));
        assert!(keyed_text.contains("IdentitiesOnly=yes"));
        assert!(keyed.askpass_id.is_none());

        let password = super::SavedVps {
            identity: None,
            has_password: true,
            ..key
        };
        let secret = "s3cret-password";
        let with_password = super::ssh_launch("gvk00000001", Some(&password));
        let password_text = with_password.args.join(" ");
        assert!(password_text.contains("BatchMode=no"));
        assert!(password_text.contains("PasswordAuthentication=yes"));
        assert!(password_text.contains("KbdInteractiveAuthentication=yes"));
        assert!(!password_text.contains("BatchMode=yes"));
        assert!(!password_text.contains(secret));
        assert_eq!(with_password.askpass_id.as_deref(), Some("gvk00000001"));

        let plain = super::ssh_launch("vps", None);
        assert_eq!(
            plain.args,
            vec![
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                "vps",
            ]
        );
        assert!(plain.askpass_id.is_none());
    }

    #[test]
    fn encrypted_private_key_is_rejected() {
        assert!(super::key_is_encrypted(
            "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n"
        ));
        assert!(super::key_is_encrypted(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\n"
        ));
        assert!(!super::key_is_encrypted(
            "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n"
        ));
        assert!(!super::key_is_encrypted(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\n"
        ));
        assert!(super::key_is_encrypted(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0\n-----END OPENSSH PRIVATE KEY-----\n"
        ));
    }

    #[test]
    fn askpass_helper_rejects_a_wrong_script_or_mode() {
        let dir = std::env::temp_dir().join(format!(
            "grotesque-askpass-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vps-askpass.sh");
        std::fs::write(&path, "#!/bin/sh\necho no\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!super::askpass_ready(&path));
        std::fs::write(&path, super::ASKPASS_BODY).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!super::askpass_ready(&path));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(super::askpass_ready(&path));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vps_helper_scripts_parse() {
        for script in [
            super::FETCH_IMAGE_PY,
            super::UPLOAD_ATTACH_PY,
            super::SIDE_DIR_PY,
            super::SEARCH_PY,
            super::PATHS_EXIST_PY,
        ] {
            let mut child = std::process::Command::new("python3")
                .arg("-c")
                .arg("import ast,sys; ast.parse(sys.stdin.read())")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            std::io::Write::write_all(&mut stdin, script.as_bytes()).unwrap();
            drop(stdin);
            let out = child.wait_with_output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
}
