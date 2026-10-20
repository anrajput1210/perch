//! System widgets on macOS: battery (pmset), CPU/RAM (sysinfo), volume (AppleScript), and whether the camera or mic
//! is on (CoreMediaIO / Core Audio "running somewhere"). Same `sys` event as Windows. macOS doesn't say which app is
//! using them, so the names stay blank. No `level` events (capturing system audio needs screen-recording
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

// ---- camera / mic in use ----

#[repr(C)]
struct PropertyAddress { selector: u32, scope: u32, element: u32 }

const fn fourcc(s: &[u8; 4]) -> u32 {
    (s[0] as u32) << 24 | (s[1] as u32) << 16 | (s[2] as u32) << 8 | s[3] as u32
}
const SYSTEM_OBJECT: u32 = 1;
const GLOBAL: u32 = fourcc(b"glob");
const RUNNING_SOMEWHERE: u32 = fourcc(b"gone"); // same selector in Core Audio and CoreMediaIO

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(id: u32, addr: *const PropertyAddress, qsize: u32, qdata: *const std::ffi::c_void,
        size: *mut u32, data: *mut std::ffi::c_void) -> i32;
}

#[link(name = "CoreMediaIO", kind = "framework")]
extern "C" {
    fn CMIOObjectGetPropertyDataSize(id: u32, addr: *const PropertyAddress, qsize: u32, qdata: *const std::ffi::c_void, size: *mut u32) -> i32;
    fn CMIOObjectGetPropertyData(id: u32, addr: *const PropertyAddress, qsize: u32, qdata: *const std::ffi::c_void,
        size: u32, used: *mut u32, data: *mut std::ffi::c_void) -> i32;
}

/// Is the default microphone being recorded from by any app?
fn mic_on() -> bool {
    unsafe {
        let (mut dev, mut size) = (0u32, 4u32);
        let addr = PropertyAddress { selector: fourcc(b"dIn "), scope: GLOBAL, element: 0 };
        if AudioObjectGetPropertyData(SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size, &mut dev as *mut u32 as _) != 0 || dev == 0 {
            return false;
        }
        let (mut on, mut size) = (0u32, 4u32);
        let addr = PropertyAddress { selector: RUNNING_SOMEWHERE, scope: GLOBAL, element: 0 };
        AudioObjectGetPropertyData(dev, &addr, 0, std::ptr::null(), &mut size, &mut on as *mut u32 as _) == 0 && on != 0
    }
}

/// Is any camera streaming to any app?
fn camera_on() -> bool {
    unsafe {
        let devices = PropertyAddress { selector: fourcc(b"dev#"), scope: GLOBAL, element: 0 };
        let mut size = 0u32;
        if CMIOObjectGetPropertyDataSize(SYSTEM_OBJECT, &devices, 0, std::ptr::null(), &mut size) != 0 || size == 0 {
            return false;
        }
        let mut ids = vec![0u32; size as usize / 4];
        let mut used = 0u32;
        if CMIOObjectGetPropertyData(SYSTEM_OBJECT, &devices, 0, std::ptr::null(), size, &mut used, ids.as_mut_ptr() as _) != 0 {
            return false;
        }
        let running = PropertyAddress { selector: RUNNING_SOMEWHERE, scope: GLOBAL, element: 0 };
        ids.iter().any(|&id| {
            let mut on = 0u32;
            CMIOObjectGetPropertyData(id, &running, 0, std::ptr::null(), 4, &mut used, &mut on as *mut u32 as _) == 0 && on != 0
        })
    }
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
                // blank name: macOS doesn't tell other apps who is using the camera or mic
                camera: if camera_on() { vec![String::new()] } else { vec![] },
                mic: if mic_on() { vec![String::new()] } else { vec![] },
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
