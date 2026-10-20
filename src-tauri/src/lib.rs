//! Shared by the app and the perch-hook relay.
pub mod hooks;
pub mod settings;

use serde_json::Value;

/// Per-user named pipe (Windows). Only local clients are accepted (see pipe server).
#[cfg(windows)]
pub fn pipe_name() -> String {
    let user: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    format!(r"\\.\pipe\perch-{user}")
}

/// Per-user Unix socket (macOS) in a 0700 folder in the home directory.
#[cfg(unix)]
pub fn socket_path() -> std::path::PathBuf {
    std::path::Path::new(&std::env::var("HOME").unwrap_or_default()).join(".perch").join("hook.sock")
}

/// Events the agent waits on: the relay keeps the connection open for the island's answer.
pub fn is_blocking(ev: &Value) -> bool {
    match ev["hook_event_name"].as_str() {
        Some("PermissionRequest") => true,
        Some("PreToolUse") => ev["tool_name"] == "AskUserQuestion",
        _ => false,
    }
}

/// Map another agent's event names onto the Claude Code names the island understands.
pub fn translate(ev: &mut Value, agent: &str) {
    if agent != "gemini" {
        return;
    }
    let name = match ev["hook_event_name"].as_str() {
        Some("BeforeTool") => "PreToolUse",
        Some("AfterTool") => "PostToolUse",
        Some("BeforeAgent") => "UserPromptSubmit",
        Some("AfterAgent") => "Stop",
        _ => return,
    };
    ev["hook_event_name"] = name.into();
    if name == "Stop" {
        ev["last_assistant_message"] = ev["prompt_response"].clone();
    }
}

/// `--agent` tags: lowercase letters, digits and hyphens, 1–24 chars. Anything else is treated as Claude Code.
pub fn valid_agent(tag: &str) -> bool {
    (1..=24).contains(&tag.len()) && tag.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn blocking_events() {
        assert!(is_blocking(&json!({"hook_event_name": "PermissionRequest"})));
        assert!(is_blocking(&json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion"})));
        assert!(!is_blocking(&json!({"hook_event_name": "PreToolUse", "tool_name": "Bash"})));
        assert!(!is_blocking(&json!({"hook_event_name": "Stop"})));
    }

    #[test]
    fn gemini_events_translate() {
        let mut ev = json!({"hook_event_name": "AfterAgent", "prompt_response": "done"});
        translate(&mut ev, "gemini");
        assert_eq!(ev["hook_event_name"], "Stop");
        assert_eq!(ev["last_assistant_message"], "done");
        let mut ev = json!({"hook_event_name": "BeforeTool"});
        translate(&mut ev, "codex");
        assert_eq!(ev["hook_event_name"], "BeforeTool");
    }

    #[test]
    fn agent_tags() {
        assert!(valid_agent("codex"));
        assert!(valid_agent("my-tool-2"));
        assert!(!valid_agent(""));
        assert!(!valid_agent("Codex"));
        assert!(!valid_agent("a-name-that-is-way-too-long-for-a-pill"));
    }
}
