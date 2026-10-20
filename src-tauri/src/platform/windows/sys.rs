//! System widgets: battery, CPU, RAM, volume, brightness, camera/mic in use (polled once a second as a `sys` event),
//! the live output level for the media waveform (`level`, ~15 Hz while there is sound), and volume/mute/brightness
//! setters. Brightness goes through WMI (root\WMI WmiMonitorBrightness*), which only built-in laptop panels support.
use serde::Serialize;
use std::sync::atomic::{AtomicI16, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::{w, Error, Result, BSTR, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::System::Wmi::{
    IWbemClassObject, IWbemLocator, IWbemServices, WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY,
    WBEM_GENERIC_FLAG_TYPE, WBEM_INFINITE,
};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, EOAC_NONE,
    RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
};
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
    /// built-in display brightness, None when the display can't be dimmed by software (most desktop monitors)
    brightness: Option<u8>,
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
        brightness: u8::try_from(BRIGHTNESS.load(Ordering::Relaxed)).ok(),
        camera: in_use("webcam"),
        mic: in_use("microphone"),
    }
}

pub fn watch(app: AppHandle) {
    watch_brightness();
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

// ---- brightness ----

/// Last brightness read (-1 = unsupported or not read yet).
static BRIGHTNESS: AtomicI16 = AtomicI16::new(-1);
/// Requests for the brightness thread, which owns the (thread-bound) WMI connection.
static SET: Mutex<Option<Sender<u8>>> = Mutex::new(None);

struct Wmi(IWbemServices);

impl Wmi {
    fn connect() -> Result<Self> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let loc: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)?;
            let none = BSTR::new();
            let svc = loc.ConnectServer(&BSTR::from(r"root\WMI"), &none, &none, &none, 0, &none, None)?;
            // WMI refuses calls that only identify the caller (COM's default here): impersonate instead
            const RPC_C_AUTHN_WINNT: u32 = 10;
            CoSetProxyBlanket(&svc, RPC_C_AUTHN_WINNT, 0, PCWSTR::null(), RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE)?;
            Ok(Self(svc))
        }
    }

    fn first(&self, class: &str) -> Result<IWbemClassObject> {
        unsafe {
            let flags = WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY;
            let rows = self.0.ExecQuery(&BSTR::from("WQL"), &BSTR::from(format!("SELECT * FROM {class}")), flags, None)?;
            let (mut row, mut n) = ([None], 0);
            rows.Next(WBEM_INFINITE, &mut row, &mut n).ok()?;
            row[0].take().ok_or_else(|| Error::from(E_FAIL))
        }
    }

    fn get(&self) -> Option<u8> {
        let mut v = VARIANT::default();
        unsafe { self.first("WmiMonitorBrightness").ok()?.Get(w!("CurrentBrightness"), 0, &mut v, None, None).ok()? };
        u32::try_from(&v).ok().map(|x| x.min(100) as u8)
    }

    fn set(&self, level: u8) -> Result<()> {
        unsafe {
            let display = self.first("WmiMonitorBrightnessMethods")?;
            let mut path = VARIANT::default();
            display.Get(w!("__PATH"), 0, &mut path, None, None)?;
            let mut class = None;
            self.0.GetObject(&BSTR::from("WmiMonitorBrightnessMethods"), WBEM_GENERIC_FLAG_TYPE(0), None, Some(&mut class), None)?;
            let (mut sig, mut out) = (None, None);
            class.ok_or_else(|| Error::from(E_FAIL))?.GetMethod(w!("WmiSetBrightness"), 0, &mut sig, &mut out)?;
            let args = sig.ok_or_else(|| Error::from(E_FAIL))?.SpawnInstance(0)?;
            args.Put(w!("Timeout"), 0, &VARIANT::from(0i32), 0)?;
            args.Put(w!("Brightness"), 0, &VARIANT::from(level), 0)?; // uint8: must be VT_UI1
            self.0.ExecMethod(&BSTR::try_from(&path)?, &BSTR::from("WmiSetBrightness"), WBEM_GENERIC_FLAG_TYPE(0), None, &args, None, None)
        }
    }
}

/// Reads brightness every second (so brightness keys show up on the island) and applies slider moves, newest first.
fn watch_brightness() {
    let (tx, rx) = channel::<u8>();
    *SET.lock().unwrap() = Some(tx);
    std::thread::spawn(move || {
        let Ok(wmi) = Wmi::connect() else { return };
        loop {
            if let Ok(mut level) = rx.recv_timeout(Duration::from_secs(1)) {
                while let Ok(newer) = rx.try_recv() {
                    level = newer; // a drag sends many; only the last one matters
                }
                let _ = wmi.set(level);
            }
            BRIGHTNESS.store(wmi.get().map_or(-1, i16::from), Ordering::Relaxed);
        }
    });
}

#[tauri::command]
pub async fn get_brightness() -> Option<u8> {
    u8::try_from(BRIGHTNESS.load(Ordering::Relaxed)).ok()
}

#[tauri::command]
pub async fn set_brightness(level: u8) -> std::result::Result<(), String> {
    if BRIGHTNESS.load(Ordering::Relaxed) < 0 {
        return Err("This display's brightness can't be changed from Perch.".into());
    }
    let level = level.min(100);
    BRIGHTNESS.store(level.into(), Ordering::Relaxed);
    SET.lock().unwrap().as_ref().ok_or("not ready")?.send(level).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::app_name;

    /// Touches the real display, so opt-in: cargo test -- --ignored brightness
    #[test]
    #[ignore]
    fn brightness_round_trip() {
        let wmi = super::Wmi::connect().unwrap();
        let now = wmi.get().expect("this display doesn't support WMI brightness");
        wmi.set(now).unwrap(); // same value: nothing visible changes
        assert_eq!(wmi.get(), Some(now));
    }

    #[test]
    fn privacy_app_names() {
        assert_eq!(app_name("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "WindowsCamera");
        assert_eq!(app_name(r"C:#Program Files#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(app_name("Discord"), "Discord");
    }
}
