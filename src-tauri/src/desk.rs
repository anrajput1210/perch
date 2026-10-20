//! Cross-platform desk tools: open/reveal shelf files, fetch the calendar's iCal feed, and today's Claude Code
//! token usage from its local transcripts. Platform-specific pieces (clipboard, share sheet) live in platform/.
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

/// Open with the default app; `reveal` shows it in File Explorer / Finder instead.
#[tauri::command]
pub fn open_path(path: String, reveal: bool) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err("That file has moved or been deleted.".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer.exe");
        if reveal { c.arg(format!("/select,{path}")) } else { c.arg(&path) };
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        if reveal { c.args(["-R", &path]) } else { c.arg(&path) };
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a meeting link in the default browser (https only).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened.".into());
    }
    #[cfg(windows)]
    let prog = "explorer.exe";
    #[cfg(target_os = "macos")]
    let prog = "open";
    std::process::Command::new(prog).arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Fetch an iCal feed (https:// or webcal://) as text.
#[tauri::command]
pub async fn fetch_ics(url: String) -> Result<String, String> {
    let url = url.trim().replacen("webcal://", "https://", 1);
    if !url.starts_with("https://") {
        return Err("Use the https:// or webcal:// iCal link.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url).timeout(Duration::from_secs(20)).call().map_err(|e| e.to_string())?
            .into_string().map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[derive(Default, Serialize)]
pub struct Usage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    messages: u64,
    sessions: u64,
}

/// Claude Code tokens since `since` (an ISO UTC timestamp, e.g. local midnight), from ~/.claude/projects/*/*.jsonl.
// ponytail: re-reads every transcript touched in the last 36 h on each call (a few MB); keep per-file offsets if slow
#[tauri::command]
pub async fn claude_usage(since: String) -> Usage {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let dir = PathBuf::from(home).join(".claude").join("projects");
    tauri::async_runtime::spawn_blocking(move || usage_in(&dir, &since)).await.unwrap_or_default()
}

fn usage_in(dir: &std::path::Path, since: &str) -> Usage {
    let mut u = Usage::default();
    let mut seen = HashSet::new();
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(36 * 3600);
    let files = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten())
        .filter(|f| f.path().extension().is_some_and(|e| e == "jsonl"))
        .filter(|f| f.metadata().and_then(|m| m.modified()).is_ok_and(|t| t > cutoff));
    for f in files {
        let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
        let mut counted = false;
        for line in text.lines().filter(|l| l.contains("\"usage\"")) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if v["timestamp"].as_str().is_none_or(|t| t < since) {
                continue;
            }
            let m = &v["message"];
            // a streamed reply is logged once per content block with the same id; count it once
            if !seen.insert(m["id"].as_str().unwrap_or_default().to_string()) {
                continue;
            }
            let n = |k: &str| m["usage"][k].as_u64().unwrap_or(0);
            u.input += n("input_tokens");
            u.output += n("output_tokens");
            u.cache_read += n("cache_read_input_tokens");
            u.cache_write += n("cache_creation_input_tokens");
            u.messages += 1;
            counted = true;
        }
        u.sessions += counted as u64;
    }
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_counts_each_message_once_after_since() {
        let dir = std::env::temp_dir().join(format!("perch-usage-{}", std::process::id()));
        let proj = dir.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        let line = |id: &str, ts: &str| format!(r#"{{"timestamp":"{ts}","message":{{"id":"{id}","usage":{{"input_tokens":2,"output_tokens":10,"cache_read_input_tokens":100}}}}}}"#);
        let lines = [line("a", "2026-10-20T01:00:00Z"), line("a", "2026-10-20T01:00:00Z"), line("b", "2026-10-20T02:00:00Z"), line("old", "2026-10-18T02:00:00Z")];
        std::fs::write(proj.join("s.jsonl"), lines.join("\n")).unwrap();
        let u = usage_in(&dir, "2026-10-19T07:00:00Z");
        assert_eq!((u.messages, u.output, u.cache_read, u.sessions), (2, 20, 200, 1));
    }
}
