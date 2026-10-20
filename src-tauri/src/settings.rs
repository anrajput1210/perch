//! Perch's own settings (not the agents'), stored as JSON in the app config folder.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub sound: bool,
    pub volume: f32,
    /// close an island the user opened after this many seconds without activity
    pub auto_close_s: u32,
    /// hide the island after this many minutes without mouse movement (0 = never)
    pub away_min: u32,
    pub start_with_windows: bool,
    /// watch coding agents (sessions, approvals, questions); off = agents ask in their terminal
    pub code_mode: bool,
    /// "top" | "top-left" | "top-right" | "bottom"
    pub position: String,
    /// index into the system's monitor list; out of range = primary
    pub monitor: usize,
    /// "oled" | "gray" | "midnight" | "purple"
    pub theme: String,
    pub opacity: f32,
    pub scale: f32,
    /// iCal link for meeting alerts (Google: "Secret address in iCal format"; Outlook: "Publish calendar")
    pub calendar_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { sound: true, volume: 0.5, auto_close_s: 60, away_min: 3, start_with_windows: false, code_mode: true, position: "top".into(), monitor: 0,
               theme: "oled".into(), opacity: 1.0, scale: 1.0, calendar_url: String::new() }
    }
}

impl Settings {
    /// Missing or unreadable file -> defaults; unknown/missing fields -> defaults for those fields.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self).unwrap()).map_err(|e| e.to_string())
    }

    /// Clamp values coming from the settings window.
    pub fn sanitized(mut self) -> Self {
        self.volume = self.volume.clamp(0.0, 1.0);
        self.auto_close_s = self.auto_close_s.clamp(10, 3600);
        self.away_min = self.away_min.min(120);
        self.opacity = self.opacity.clamp(0.5, 1.0);
        self.scale = self.scale.clamp(0.8, 1.4);
        if !["top", "top-left", "top-right", "bottom"].contains(&self.position.as_str()) {
            self.position = "top".into();
        }
        if !["oled", "gray", "midnight", "purple"].contains(&self.theme.as_str()) {
            self.theme = "oled".into();
        }
        self
    }
}

/// Start with Windows: a value under HKCU\...\Run pointing at this exe.
#[cfg(windows)]
pub fn set_autostart(on: bool, exe: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let quoted = format!("\"{}\"", exe.display());
    let args: Vec<&str> = if on {
        vec!["add", key, "/v", "Perch", "/t", "REG_SZ", "/d", &quoted, "/f"]
    } else {
        vec!["delete", key, "/v", "Perch", "/f"]
    };
    let out = std::process::Command::new("reg").args(&args).creation_flags(CREATE_NO_WINDOW).output().map_err(|e| e.to_string())?;
    // deleting a value that isn't there is fine
    if out.status.success() || !on { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// Start at login on macOS: a LaunchAgent plist pointing at this executable.
#[cfg(target_os = "macos")]
pub fn set_autostart(on: bool, exe: &Path) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let plist = Path::new(&home).join("Library/LaunchAgents/dev.perch.island.plist");
    if !on {
        let _ = std::fs::remove_file(&plist);
        return Ok(());
    }
    let exe = exe.display().to_string().replace('&', "&amp;").replace('<', "&lt;");
    let body = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.perch.island</string>
  <key>ProgramArguments</key><array><string>{exe}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
"#);
    std::fs::create_dir_all(plist.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&plist, body).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_partial_files_and_clamping() {
        let dir = std::env::temp_dir().join(format!("perch-settings-{}", std::process::id()));
        let p = dir.join("settings.json");
        assert_eq!(Settings::load(&p), Settings::default());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&p, r#"{"sound": false}"#).unwrap();
        let s = Settings::load(&p);
        assert!(!s.sound);
        assert_eq!(s.auto_close_s, 60);
        assert!(s.code_mode); // files from before code mode keep agents on
        let s = Settings { volume: 4.0, auto_close_s: 1, theme: "neon".into(), scale: 9.0, ..s }.sanitized();
        assert_eq!((s.volume, s.auto_close_s, s.theme.as_str(), s.scale), (1.0, 10, "oled", 1.4));
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s);
    }
}
