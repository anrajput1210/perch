#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Perch app: the island window, the local server for hook events (named pipe on Windows, Unix socket on macOS),
//! click-through, and the tray. Session state lives in the web UI (src/store.ts); Rust only carries messages.

mod desk;
#[cfg_attr(windows, path = "platform/windows/mod.rs")]
#[cfg_attr(target_os = "macos", path = "platform/macos/mod.rs")]
mod platform;

use perch_core::settings::{set_autostart, Settings};
use perch_core::{hooks, is_blocking};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<String>>>>;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Default, Deserialize)]
struct Rect { x: f64, y: f64, w: f64, h: f64 }
struct HitRect(Mutex<Rect>);
struct Config(Mutex<Settings>);
/// The tray's "Sounds" check item, kept in step with the settings window.
struct SoundItem(CheckMenuItem<tauri::Wry>);

// ---- hook server ----

#[cfg(windows)]
async fn serve(app: AppHandle, pending: Pending) {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = perch_core::pipe_name();
    let mut server = match ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true).create(&name) {
        Ok(s) => s,
        Err(e) => return eprintln!("perch: pipe {name} unavailable ({e}); is Perch already running?"),
    };
    loop {
        if server.connect().await.is_err() {
            continue;
        }
        let next = match ServerOptions::new().reject_remote_clients(true).create(&name) {
            Ok(s) => s,
            Err(e) => return eprintln!("perch: pipe error {e}"),
        };
        let conn = std::mem::replace(&mut server, next);
        tokio::spawn(handle(conn, app.clone(), pending.clone()));
    }
}

#[cfg(unix)]
async fn serve(app: AppHandle, pending: Pending) {
    use std::os::unix::fs::PermissionsExt;
    let path = perch_core::socket_path();
    let dir = path.parent().unwrap();
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)); // only this user can connect
    let _ = std::fs::remove_file(&path); // stale socket from a previous run
    let listener = match tokio::net::UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => return eprintln!("perch: socket {} unavailable ({e})", path.display()),
    };
    loop {
        if let Ok((conn, _)) = listener.accept().await {
            tokio::spawn(handle(conn, app.clone(), pending.clone()));
        }
    }
}

async fn handle<S: AsyncRead + AsyncWrite>(conn: S, app: AppHandle, pending: Pending) {
    let (r, mut w) = tokio::io::split(conn);
    let mut r = BufReader::new(r);
    let mut line = String::new();
    if r.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }
    let Ok(payload) = serde_json::from_str::<Value>(&line) else { return };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let blocking = is_blocking(&payload);
    if !blocking {
        let _ = app.emit("hook", json!({ "id": id, "payload": payload, "blocking": false }));
        return;
    }
    let (tx, rx) = oneshot::channel();
    pending.lock().unwrap().insert(id, tx);
    let _ = app.emit("hook", json!({ "id": id, "payload": payload, "blocking": true }));
    let mut buf = [0u8; 1];
    tokio::select! {
        reply = rx => {
            if let Ok(out) = reply {
                let _ = w.write_all(format!("{out}\n").as_bytes()).await;
                let _ = w.flush().await;
                // let the relay read before the handle closes
                let _ = tokio::time::timeout(Duration::from_secs(2), r.read(&mut buf)).await;
            }
        }
        _ = r.read(&mut buf) => {
            // relay gave up (timeout) or the agent was cancelled: drop the card
            pending.lock().unwrap().remove(&id);
            let _ = app.emit("hook-cancel", id);
        }
    }
}

// ---- commands ----

#[tauri::command]
fn reply(id: u64, output: String, pending: State<Pending>) {
    if let Some(tx) = pending.lock().unwrap().remove(&id) {
        let _ = tx.send(output);
    }
}

#[tauri::command]
fn set_hit_rect(rect: Rect, hit: State<HitRect>) {
    *hit.0.lock().unwrap() = rect;
}

fn settings_path(app: &AppHandle) -> std::path::PathBuf {
    app.path().app_config_dir().unwrap_or_default().join("settings.json")
}

#[tauri::command]
fn get_settings(cfg: State<Config>) -> Settings {
    cfg.0.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings, cfg: State<Config>) -> Result<Settings, String> {
    let s = settings.sanitized();
    let old = cfg.0.lock().unwrap().clone();
    if (s.position.as_str(), s.monitor) != (old.position.as_str(), old.monitor) {
        if let Some(w) = app.get_webview_window("main") {
            platform::native::place(&w, s.monitor, &s.position);
        }
    }
    let was = old.start_with_windows;
    if s.start_with_windows != was {
        set_autostart(s.start_with_windows, &std::env::current_exe().unwrap_or_default())?;
    }
    s.save(&settings_path(&app))?;
    *cfg.0.lock().unwrap() = s.clone();
    if let Some(item) = app.try_state::<SoundItem>() {
        let _ = item.0.set_checked(s.sound);
    }
    let _ = app.emit("settings", &s);
    Ok(s)
}

#[derive(serde::Serialize)]
struct AgentStatus { id: &'static str, name: &'static str, connected: bool, config: String }

#[tauri::command]
fn agents() -> Vec<AgentStatus> {
    hooks::AGENTS.iter().map(|a| {
        let p = hooks::config_path(a);
        AgentStatus { id: a.id, name: a.name, connected: hooks::installed(&p), config: p.display().to_string() }
    }).collect()
}

#[tauri::command]
fn connect_agent(id: String, on: bool) -> Result<(), String> {
    let a = hooks::agent(&id).ok_or("unknown agent")?;
    let p = hooks::config_path(a);
    if on { hooks::install_for(a, &p, &hook_exe()) } else { hooks::uninstall(&p) }
}

/// Monitor names for the settings window, in the order `Settings::monitor` indexes.
#[tauri::command]
fn monitors(app: AppHandle) -> Vec<String> {
    let w = app.get_webview_window("main");
    w.and_then(|w| w.available_monitors().ok()).unwrap_or_default().iter().enumerate()
        .map(|(i, m)| format!("{} · {}×{}", m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1)), m.size().width, m.size().height))
        .collect()
}

#[tauri::command]
fn start_demo(app: AppHandle) {
    let _ = app.emit("demo", ());
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Perch settings")
        .inner_size(560.0, 640.0)
        .resizable(true)
        .build();
}

/// Ctrl+Alt+P: open the island and give it keyboard focus (Y/N/Esc/1-4 then work).
fn summon(app: &AppHandle) {
    let _ = app.emit("open", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

fn hook_exe() -> std::path::PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    exe.with_file_name(if cfg!(windows) { "perch-hook.exe" } else { "perch-hook" })
}

// ---- window: top-centre placement, click-through outside the island, cursor feed for the eyes ----

fn cursor_loop(app: AppHandle, win: WebviewWindow) {
    std::thread::spawn(move || {
        let mut inside_last = None;
        let mut last = (f64::NAN, f64::NAN);
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let (Ok(c), Ok(p), Ok(scale)) = (app.cursor_position(), win.outer_position(), win.scale_factor()) else { continue };
            let (x, y) = ((c.x - p.x as f64) / scale, (c.y - p.y as f64) / scale);
            let r = *app.state::<HitRect>().0.lock().unwrap();
            let m = 6.0;
            let inside = r.w > 0.0 && x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
            if inside_last != Some(inside) {
                let _ = win.set_ignore_cursor_events(!inside);
                inside_last = Some(inside);
            }
            if (x, y) != last {
                let _ = win.emit("cursor", (x, y));
                last = (x, y);
            }
        }
    });
}

fn tray(app: &tauri::App) -> tauri::Result<()> {
    let keys = if cfg!(target_os = "macos") { "⌘⌥P" } else { "Ctrl+Alt+P" };
    let open = MenuItem::with_id(app, "open", format!("Open the island    {keys}"), true, None::<&str>)?;
    let demo = MenuItem::with_id(app, "demo", "Play the demo", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let on = app.state::<Config>().0.lock().unwrap().sound;
    let sound = CheckMenuItem::with_id(app, "sound", "Sounds", true, on, None::<&str>)?;
    app.manage(SoundItem(sound.clone()));
    let install = MenuItem::with_id(app, "install", "Connect Claude Code", true, None::<&str>)?;
    let remove = MenuItem::with_id(app, "uninstall", "Disconnect Claude Code", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Perch", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &demo, &sound, &settings, &sep, &install, &remove, &sep, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Perch")
        .menu(&menu)
        .on_menu_event(|app, e| {
            let note = |msg: String| { let _ = app.emit("note", msg); };
            match e.id().as_ref() {
                "open" => summon(app),
                "demo" => start_demo(app.clone()),
                "settings" => open_settings(app.clone()),
                "sound" => {
                    let cfg = app.state::<Config>();
                    let cur = cfg.0.lock().unwrap().clone();
                    let s = Settings { sound: !cur.sound, ..cur };
                    if let Err(err) = set_settings(app.clone(), s, cfg) { note(err) }
                }
                "install" => match hooks::install(&hooks::claude_settings(), &hook_exe()) {
                    Ok(()) => note("Connected. New Claude Code sessions will show up here.".into()),
                    Err(err) => note(err),
                },
                "uninstall" => match hooks::uninstall(&hooks::claude_settings()) {
                    Ok(()) => note("Disconnected from Claude Code.".into()),
                    Err(err) => note(err),
                },
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let pending: Pending = Arc::default();
    tauri::Builder::default()
        .manage(pending.clone())
        .manage(HitRect(Mutex::new(Rect::default())))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _sc, ev| if ev.state() == ShortcutState::Pressed { summon(app) })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![reply, set_hit_rect, get_settings, set_settings, agents, connect_agent, start_demo, open_settings, monitors,
            platform::media::media_control, platform::sys::set_volume, platform::sys::get_brightness, platform::sys::set_brightness,
            platform::native::copy_text, platform::native::share_files, desk::open_path, desk::open_url, desk::fetch_ics, desk::claude_usage])
        .setup(move |app| {
            let settings = Settings::load(&settings_path(app.handle()));
            app.manage(Config(Mutex::new(settings.clone())));
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // menu bar app: no Dock icon
            // Ctrl+Alt+P on Windows, Cmd+Option+P on macOS
            let mods = if cfg!(target_os = "macos") { Modifiers::SUPER | Modifiers::ALT } else { Modifiers::CONTROL | Modifiers::ALT };
            if let Err(e) = app.global_shortcut().register(Shortcut::new(Some(mods), Code::KeyP)) {
                eprintln!("perch: hotkey unavailable ({e})");
            }
            let win = app.get_webview_window("main").expect("main window");
            platform::native::place(&win, settings.monitor, &settings.position);
            let _ = win.set_ignore_cursor_events(true);
            win.show()?;
            cursor_loop(app.handle().clone(), win);
            tray(app)?;
            platform::media::watch(app.handle().clone());
            platform::sys::watch(app.handle().clone());
            platform::native::watch_clipboard(app.handle().clone());
            tauri::async_runtime::spawn(serve(app.handle().clone(), pending));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Perch");
}
