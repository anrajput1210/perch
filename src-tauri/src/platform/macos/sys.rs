//! System widgets on macOS: battery (pmset), CPU/RAM (sysinfo), volume (AppleScript). Same `sys` event as Windows.
//! Camera/mic indicators stay empty: macOS already shows its own green/orange dots, and detecting them needs
//! CoreMediaIO/Core Audio listeners. No `level` events either (capturing system audio needs screen-recording
//! permission), so the waveform falls back to an animated one.
use serde::Serialize;
use std::process::Command;
use std::time::Duration;
use sysinfo::System;
use tauri::{AppHandle, Emitter};

#[derive(Clone, PartialEq, Serialize)]
pub struct Sys {
    battery: Option<u8>,
    charging: bool,
    cpu: u8,
    ram: u8,
    volume: u8,
    muted: bool,
    brightness: Option<u8>,
    camera: Vec<String>,
    mic: Vec<String>,
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `pmset -g batt` -> (percent, charging); None on Macs without a battery.
pub fn parse_pmset(s: &str) -> Option<(u8, bool)> {
    let pct = s.split('%').next()?.rsplit(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
    Some((pct, s.contains("AC Power")))
}

fn volume() -> (u8, bool) {
    run("osascript", &["-e", "set v to get volume settings\nreturn (output volume of v as text) & \",\" & (output muted of v as text)"])
        .and_then(|s| {
            let (v, m) = s.split_once(',')?;
            Some((v.trim().parse().ok()?, m.trim() == "true"))
        })
        .unwrap_or((0, false))
}

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut last = None;
        let mut batt = None;
        for n in 0u64.. {
            std::thread::sleep(Duration::from_secs(2));
            sys.refresh_cpu_usage();
            sys.refresh_memory();
            if n % 15 == 0 {
                batt = run("pmset", &["-g", "batt"]).as_deref().and_then(parse_pmset); // every 30 s
            }
            let (volume, muted) = volume();
            let s = Sys {
                battery: batt.map(|b| b.0),
                charging: batt.is_some_and(|b| b.1),
                cpu: sys.global_cpu_usage().round() as u8,
                ram: (100 * sys.used_memory() / sys.total_memory().max(1)) as u8,
                volume,
                muted,
                brightness: None,
                camera: vec![],
                mic: vec![],
            };
            if last.as_ref() != Some(&s) {
                let _ = app.emit("sys", &s);
                last = Some(s);
            }
        }
    });
}

#[tauri::command]
pub async fn set_volume(volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
    let mut script = String::new();
    if let Some(v) = volume {
        script += &format!("set volume output volume {}\n", (v.clamp(0.0, 1.0) * 100.0).round());
    }
    if let Some(m) = muted {
        script += &format!("set volume output muted {m}\n");
    }
    run("osascript", &["-e", &script]).map(|_| ()).ok_or_else(|| "Couldn't change the volume.".into())
}

/// macOS has no public brightness API for apps; the island hides the slider.
#[tauri::command]
pub async fn get_brightness() -> Option<u8> {
    None
}

#[tauri::command]
pub async fn set_brightness(_level: u8) -> Result<(), String> {
    Err("Brightness isn't available on macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::parse_pmset;

    #[test]
    fn pmset_output() {
        let s = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t87%; charging; 0:40 remaining present: true";
        assert_eq!(parse_pmset(s), Some((87, true)));
        assert_eq!(parse_pmset("Now drawing from 'AC Power'"), None);
    }
}
