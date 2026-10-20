//! Now playing on macOS: Spotify and Music through AppleScript. (The system-wide MediaRemote framework is private
//! and locked down since macOS 15.4, so browsers aren't covered.) Same `media` event shape as Windows.
use serde::Serialize;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, PartialEq, Serialize)]
pub struct Media {
    title: String,
    artist: String,
    app: String,
    playing: bool,
    position: f64,
    duration: f64,
    art: Option<Vec<u8>>,
    art_type: String,
    /// Spotify hands out its album art as a URL
    art_url: Option<String>,
}

const PLAYERS: &[&str] = &["Spotify", "Music"];
/// the player the island is showing, for the controls
static CURRENT: Mutex<String> = Mutex::new(String::new());

fn osascript(script: &str) -> Option<String> {
    let out = Command::new("osascript").args(["-e", script]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn read(app: &str) -> Option<Media> {
    let (dur, art) = if app == "Spotify" {
        ("(duration of current track) / 1000", "(artwork url of current track)")
    } else {
        ("duration of current track", "\"\"")
    };
    // `is running` doesn't launch the player; first use asks the user to let Perch control it (Automation)
    let script = format!(
        r#"if application "{app}" is running then
tell application "{app}"
if player state is stopped then return ""
set sep to (ASCII character 31)
return (name of current track) & sep & (artist of current track) & sep & (player state as text) & sep & (player position as text) & sep & ({dur} as text) & sep & {art}
end tell
end if
return """#
    );
    let out = osascript(&script)?;
    let f: Vec<&str> = out.split('\u{1f}').collect();
    if f.len() < 6 {
        return None;
    }
    let num = |s: &str| s.replace(',', ".").parse::<f64>().unwrap_or(0.0); // some locales print 12,5
    Some(Media {
        title: f[0].into(),
        artist: f[1].into(),
        app: app.into(),
        playing: f[2] == "playing",
        position: num(f[3]),
        duration: num(f[4]),
        art: None,
        art_type: String::new(),
        art_url: (!f[5].is_empty()).then(|| f[5].to_string()),
    })
}

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        // ponytail: one osascript per player per second; switch to distributed notifications if it shows in Activity Monitor
        let mut last: Option<Media> = None;
        loop {
            let all: Vec<Media> = PLAYERS.iter().filter_map(|p| read(p)).collect();
            let cur = all.iter().find(|m| m.playing).or(all.first()).cloned();
            *CURRENT.lock().unwrap() = cur.as_ref().map(|m| m.app.clone()).unwrap_or_default();
            if cur != last {
                let _ = app.emit("media", &cur);
                last = cur;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[tauri::command]
pub async fn media_control(action: String, position: Option<f64>) -> Result<(), String> {
    let app = CURRENT.lock().unwrap().clone();
    if app.is_empty() {
        return Err("Nothing is playing.".into());
    }
    let verb = match action.as_str() {
        "toggle" => "playpause".to_string(),
        "next" => "next track".to_string(),
        "prev" => "previous track".to_string(),
        "seek" => format!("set player position to {}", position.unwrap_or(0.0).max(0.0)),
        _ => return Err("unknown action".into()),
    };
    osascript(&format!(r#"tell application "{app}" to {verb}"#)).map(|_| ()).ok_or_else(|| "The player didn't respond.".into())
}
