//! Install / remove Perch's entries in an agent's hook config without touching anything else.
//! Claude Code and Codex share one format (event -> [{matcher?, hooks: [{type, command, timeout}]}]);
//! Gemini CLI uses the same shape with its own event names and timeouts in milliseconds.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct Agent {
    pub id: &'static str,
    pub name: &'static str,
    /// config file relative to the home directory
    pub file: &'static str,
    /// (event, timeout in the agent's unit). Blocking events wait for the island, so they get long timeouts.
    pub events: &'static [(&'static str, u32)],
}

pub const AGENTS: &[Agent] = &[
    Agent { id: "claude", name: "Claude Code", file: ".claude/settings.json", events: &[
        ("SessionStart", 10), ("UserPromptSubmit", 10), ("PreToolUse", 300), ("PostToolUse", 10),
        ("PermissionRequest", 300), ("Notification", 10), ("SubagentStop", 10), ("Stop", 10), ("SessionEnd", 10),
    ] },
    Agent { id: "codex", name: "Codex", file: ".codex/hooks.json", events: &[
        ("SessionStart", 10), ("UserPromptSubmit", 10), ("PreToolUse", 10), ("PostToolUse", 10),
        ("PermissionRequest", 300), ("Stop", 10), ("SessionEnd", 3),
    ] },
    Agent { id: "gemini", name: "Gemini CLI", file: ".gemini/settings.json", events: &[
        ("SessionStart", 10_000), ("BeforeAgent", 10_000), ("BeforeTool", 10_000), ("AfterTool", 10_000),
        ("AfterAgent", 10_000), ("Notification", 10_000), ("SessionEnd", 10_000),
    ] },
];
const MARK: &str = "perch-hook";

pub fn agent(id: &str) -> Option<&'static Agent> {
    AGENTS.iter().find(|a| a.id == id)
}

pub fn config_path(a: &Agent) -> PathBuf {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    Path::new(&home).join(a.file)
}

pub fn claude_settings() -> PathBuf {
    config_path(&AGENTS[0])
}

fn load(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("Couldn't read {}: {e}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} isn't valid JSON ({e}). Perch won't edit it; fix it and try again.", path.display()))?;
    if v.is_object() { Ok(v) } else { Err(format!("{} isn't a JSON object. Perch won't edit it.", path.display())) }
}

fn save(path: &Path, v: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

fn is_ours(group: &Value) -> bool {
    group["hooks"].as_array().is_some_and(|hs| hs.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(MARK))))
}

/// Remove our groups; drop event arrays and the hooks object if they end up empty.
fn strip(v: &mut Value) {
    let Some(hooks) = v.get_mut("hooks").and_then(Value::as_object_mut) else { return };
    for groups in hooks.values_mut() {
        if let Some(arr) = groups.as_array_mut() {
            arr.retain(|g| !is_ours(g));
        }
    }
    hooks.retain(|_, g| !g.as_array().is_some_and(Vec::is_empty));
    if hooks.is_empty() {
        v.as_object_mut().unwrap().remove("hooks");
    }
}

pub fn installed(path: &Path) -> bool {
    load(path).is_ok_and(|v| v["hooks"].as_object().is_some_and(|h| h.values().any(|g| g.as_array().is_some_and(|a| a.iter().any(is_ours)))))
}

pub fn install(path: &Path, hook_exe: &Path) -> Result<(), String> {
    install_for(&AGENTS[0], path, hook_exe)
}

pub fn install_for(a: &Agent, path: &Path, hook_exe: &Path) -> Result<(), String> {
    let mut v = load(path)?;
    let backup = path.with_extension("json.perch-backup");
    if path.exists() && !backup.exists() {
        std::fs::copy(path, &backup).map_err(|e| format!("Couldn't back up settings: {e}"))?;
    }
    strip(&mut v); // idempotent: re-install replaces our old entries
    let exe = hook_exe.display().to_string().replace('\\', "/");
    let command = if a.id == "claude" { format!("\"{exe}\"") } else { format!("\"{exe}\" --agent {}", a.id) };
    if !v["hooks"].is_object() {
        v["hooks"] = json!({});
    }
    for (event, timeout) in a.events {
        let slot = &mut v["hooks"][*event];
        if !slot.is_array() {
            *slot = json!([]);
        }
        slot.as_array_mut().unwrap().push(json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }));
    }
    save(path, &v)
}

pub fn uninstall(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut v = load(path)?;
    strip(&mut v);
    save(path, &v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str, content: Option<&str>) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("perch-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        if let Some(c) = content {
            std::fs::write(&p, c).unwrap();
        }
        p
    }
    const EXE: &str = r"C:\Program Files\Perch\perch-hook.exe";

    #[test]
    fn keeps_user_hooks_and_is_idempotent() {
        let user = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#;
        let p = tmp("merge", Some(user));
        install(&p, Path::new(EXE)).unwrap();
        install(&p, Path::new(EXE)).unwrap();
        let v = load(&p).unwrap();
        assert_eq!(v["model"], "opus");
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user hook + exactly one of ours");
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert_eq!(v["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 300);
        assert!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap().contains("C:/Program Files/Perch/perch-hook.exe"));
        assert!(installed(&p));
        assert!(p.with_extension("json.perch-backup").exists());

        uninstall(&p).unwrap();
        let v = load(&p).unwrap();
        assert!(!installed(&p));
        assert_eq!(v["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(v["hooks"].get("PreToolUse").is_none());
    }

    #[test]
    fn fresh_file_and_full_cleanup() {
        let p = tmp("fresh", None);
        install(&p, Path::new(EXE)).unwrap();
        assert!(installed(&p));
        uninstall(&p).unwrap();
        assert_eq!(load(&p).unwrap(), json!({}));
    }

    #[test]
    fn codex_and_gemini_get_tagged_commands() {
        let p = tmp("codex", None);
        install_for(agent("codex").unwrap(), &p, Path::new(EXE)).unwrap();
        let v = load(&p).unwrap();
        assert!(v["hooks"]["PermissionRequest"][0]["hooks"][0]["command"].as_str().unwrap().ends_with("--agent codex"));
        let g = tmp("gemini", None);
        install_for(agent("gemini").unwrap(), &g, Path::new(EXE)).unwrap();
        let v = load(&g).unwrap();
        assert_eq!(v["hooks"]["BeforeTool"][0]["hooks"][0]["timeout"], 10_000);
        assert!(v["hooks"].get("PermissionRequest").is_none());
    }

    #[test]
    fn refuses_broken_json() {
        let p = tmp("broken", Some("{ not json"));
        assert!(install(&p, Path::new(EXE)).unwrap_err().contains("isn't valid JSON"));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{ not json");
    }
}
