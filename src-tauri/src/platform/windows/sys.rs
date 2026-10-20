//! System widgets: battery, CPU, RAM, volume, camera/mic in use (polled once a second as a `sys` event), the live
//! output level for the media waveform (`level`, ~15 Hz while there is sound), and volume/mute/brightness setters.
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::{Result, HSTRING, PWSTR};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows::Win32::System::Registry::{RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_QWORD};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

#[derive(Clone, PartialEq, Serialize)]
pub struct Sys {
    /// percent, None on desktops without a battery
    battery: Option<u8>,
    charging: bool,
    cpu: u8,
    ram: u8,
    volume: u8,
    muted: bool,
    /// apps using the camera / microphone right now
    camera: Vec<String>,
    mic: Vec<String>,
}

fn device() -> Result<IMMDevice> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED); // per thread; "already initialized" is fine
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        en.GetDefaultAudioEndpoint(eRender, eConsole)
    }
}

fn endpoint() -> Result<IAudioEndpointVolume> {
    unsafe { device()?.Activate(CLSCTX_ALL, None) }
}

fn ticks(f: FILETIME) -> u64 {
    (f.dwHighDateTime as u64) << 32 | f.dwLowDateTime as u64
}

fn cpu_times() -> (u64, u64) {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)); }
    (ticks(idle), ticks(kernel) + ticks(user)) // kernel time includes idle time
}

/// "Microsoft.WindowsCamera_8wekyb3d8bbwe" -> "WindowsCamera"; "C:#Program Files#Zoom#Zoom.exe" -> "Zoom"
pub fn app_name(key: &str) -> String {
    if key.contains('#') {
        let file = key.rsplit('#').next().unwrap_or(key);
        return file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file).to_string();
    }
    let pkg = key.split('_').next().unwrap_or(key);
    pkg.rsplit('.').next().unwrap_or(pkg).to_string()
}

/// Apps using a capability right now: Windows' privacy store marks them with LastUsedTimeStop = 0.
fn in_use(capability: &str) -> Vec<String> {
    let base = format!(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{capability}");
    let mut apps = Vec::new();
    for sub in [base.clone(), format!(r"{base}\NonPackaged")] {
        let mut key = HKEY::default();
        if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(&sub), None, KEY_READ, &mut key) }.is_err() {
            continue;
        }
        let mut name = [0u16; 512];
        for i in 0.. {
            let mut len = name.len() as u32;
            if unsafe { RegEnumKeyExW(key, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None) }.is_err() {
                break;
            }
            let app = String::from_utf16_lossy(&name[..len as usize]);
            let qword = |value: &str| {
                let (mut v, mut size) = (0u64, 8u32);
                let ok = unsafe {
                    RegGetValueW(key, &HSTRING::from(&app), &HSTRING::from(value), RRF_RT_REG_QWORD, None,
                        Some(&mut v as *mut u64 as _), Some(&mut size))
                }.is_ok();
                ok.then_some(v)
            };
            if qword("LastUsedTimeStop") == Some(0) && qword("LastUsedTimeStart").unwrap_or(0) > 0 {
                apps.push(app_name(&app));
            }
        }
        unsafe { let _ = RegCloseKey(key); }
    }
    apps
}

fn read(prev: &mut (u64, u64)) -> Sys {
    let mut power = SYSTEM_POWER_STATUS::default();
    let has_power = unsafe { GetSystemPowerStatus(&mut power) }.is_ok();
    let battery = (has_power && power.BatteryFlag & 128 == 0 && power.BatteryLifePercent <= 100).then_some(power.BatteryLifePercent);
    let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { let _ = GlobalMemoryStatusEx(&mut mem); }
    let now = cpu_times();
    let (idle, total) = (now.0 - prev.0, now.1 - prev.1);
    *prev = now;
    let cpu = if total == 0 { 0 } else { (100 * (total - idle.min(total)) / total) as u8 };
    let (volume, muted) = endpoint()
        .and_then(|v| unsafe { Ok((v.GetMasterVolumeLevelScalar()?, v.GetMute()?.as_bool())) })
        .unwrap_or((0.0, false));
    Sys {
        battery,
        charging: power.ACLineStatus == 1,
        cpu,
        ram: mem.dwMemoryLoad as u8,
        volume: (volume * 100.0).round() as u8,
        muted,
        camera: in_use("webcam"),
        mic: in_use("microphone"),
    }
}

pub fn watch(app: AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        let mut prev = cpu_times();
        let mut last = None;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let s = read(&mut prev);
            if last.as_ref() != Some(&s) {
                let _ = a.emit("sys", &s);
                last = Some(s);
            }
        }
    });
    // output peak level for the waveform; silent -> no events
    std::thread::spawn(move || {
        let mut meter: Option<IAudioMeterInformation> = None;
        let mut n = 0u32;
        let mut was_quiet = true;
        loop {
            std::thread::sleep(Duration::from_millis(66));
            n += 1;
            if meter.is_none() || n % 45 == 0 {
                // re-acquire every ~3 s so a changed default device (headphones) is followed
                meter = device().and_then(|d| unsafe { d.Activate(CLSCTX_ALL, None) }).ok();
            }
            let peak = meter.as_ref().and_then(|m| unsafe { m.GetPeakValue() }.ok()).unwrap_or(0.0);
            let quiet = peak < 0.005;
            if !(quiet && was_quiet) {
                let _ = app.emit("level", peak);
            }
            was_quiet = quiet;
        }
    });
}

#[tauri::command]
pub async fn set_volume(volume: Option<f32>, muted: Option<bool>) -> std::result::Result<(), String> {
    let v = endpoint().map_err(|e| e.to_string())?;
    unsafe {
        if let Some(x) = volume {
            v.SetMasterVolumeLevelScalar(x.clamp(0.0, 1.0), std::ptr::null()).map_err(|e| e.to_string())?;
        }
        if let Some(m) = muted {
            v.SetMute(m, std::ptr::null()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn powershell(script: &str) -> std::result::Result<String, String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// Built-in display brightness (laptops), 0-100. None when the display doesn't support it (most desktop monitors).
// ponytail: WMI through PowerShell (~0.3 s per call); fine for a slider that sends on release, not for live dragging
#[tauri::command]
pub async fn get_brightness() -> Option<u8> {
    powershell("(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop).CurrentBrightness")
        .ok()?.lines().next()?.trim().parse().ok()
}

#[tauri::command]
pub async fn set_brightness(level: u8) -> std::result::Result<(), String> {
    let level = level.min(100);
    powershell(&format!("Invoke-CimMethod -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -MethodName WmiSetBrightness -Arguments @{{Brightness={level};Timeout=0}} -ErrorAction Stop | Out-Null")).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::app_name;

    #[test]
    fn privacy_app_names() {
        assert_eq!(app_name("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "WindowsCamera");
        assert_eq!(app_name(r"C:#Program Files#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(app_name("Discord"), "Discord");
    }
}
