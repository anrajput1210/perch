//! macOS clipboard history (`clip` events) + copy, AirDrop for shelf files, and putting the island at the notch.
use objc2_app_kit::{
    NSPasteboard, NSPasteboardTypeString, NSSharingService, NSSharingServiceNameSendViaAirDrop, NSStatusWindowLevel,
    NSWindow, NSWindowCollectionBehavior,
};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSArray, NSString, NSURL};
use std::time::Duration;
use tauri::{AppHandle, Emitter, PhysicalPosition, WebviewWindow};

/// Password managers mark secrets with this type (nspasteboard.org) so clipboard tools leave them alone.
const CONCEALED: &str = "org.nspasteboard.ConcealedType";

fn read_clipboard(pb: &NSPasteboard) -> Option<String> {
    let types = pb.types()?;
    if types.iter().any(|t| t.to_string() == CONCEALED) {
        return None;
    }
    Some(pb.stringForType(unsafe { NSPasteboardTypeString })?.to_string())
}

/// Emits `clip` with the new text whenever something copies text (copies over 20 000 chars are skipped).
pub fn watch_clipboard(app: AppHandle) {
    std::thread::spawn(move || {
        let pb = NSPasteboard::generalPasteboard();
        let mut count = pb.changeCount();
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let now = pb.changeCount();
            if now == count {
                continue;
            }
            count = now;
            if let Some(t) = read_clipboard(&pb).filter(|t| !t.trim().is_empty() && t.len() <= 20_000) {
                let _ = app.emit("clip", t);
            }
        }
    });
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let pb = NSPasteboard::generalPasteboard();
    pb.clearContents();
    if pb.setString_forType(&NSString::from_str(&text), unsafe { NSPasteboardTypeString }) { Ok(()) } else { Err("Couldn't copy.".into()) }
}

/// Send shelf files with AirDrop.
#[tauri::command]
pub fn share_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(service) = NSSharingService::sharingServiceNamed(unsafe { NSSharingServiceNameSendViaAirDrop }) else { return };
        let urls: Vec<Retained<AnyObject>> = paths.iter()
            .map(|p| Retained::into_super(Retained::into_super(NSURL::fileURLWithPath(&NSString::from_str(p)))))
            .collect();
        unsafe { service.performWithItems(&NSArray::from_retained_slice(&urls)) };
    }).map_err(|e| e.to_string())
}

/// Put the island at the top (the notch) or bottom of `monitor`, above the menu bar and on every Space.
pub fn place(win: &WebviewWindow, monitor: usize, position: &str) {
    if let Ok(ptr) = win.ns_window() {
        // SAFETY: Tauri hands out the live NSWindow for this webview window; setup runs on the main thread
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.setLevel(NSStatusWindowLevel + 1);
        ns.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    let mons = win.available_monitors().unwrap_or_default();
    let Some(m) = mons.get(monitor).cloned().or_else(|| win.primary_monitor().ok().flatten()) else { return };
    let (pos, size) = (m.position(), m.size());
    let w = win.outer_size().map(|s| s.width as i32).unwrap_or(720);
    let h = win.outer_size().map(|s| s.height as i32).unwrap_or(480);
    let x = match position {
        "top-left" => pos.x,
        "top-right" => pos.x + size.width as i32 - w,
        _ => pos.x + (size.width as i32 - w) / 2,
    };
    let y = if position == "bottom" { pos.y + size.height as i32 - h } else { pos.y };
    let _ = win.set_position(PhysicalPosition::new(x, y));
}
