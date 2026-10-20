//! Windows clipboard history (`clip` events) + copy, the share sheet for shelf files, and window placement.
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

const CF_UNICODETEXT: u32 = 13;

fn read_clipboard() -> Option<String> {
    unsafe {
        // password managers tag secrets with this format so clipboard tools leave them alone
        let secret = RegisterClipboardFormatW(&HSTRING::from("ExcludeClipboardContentFromMonitorProcessing"));
        if IsClipboardFormatAvailable(secret).is_ok() || IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
            return None;
        }
        OpenClipboard(None).ok()?;
        let text = GetClipboardData(CF_UNICODETEXT).ok().and_then(|h| {
            let g = HGLOBAL(h.0);
            let p = GlobalLock(g) as *const u16;
            if p.is_null() {
                return None;
            }
            let len = (0..).take_while(|&i| *p.add(i) != 0).count();
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
            let _ = GlobalUnlock(g);
            Some(s)
        });
        let _ = CloseClipboard();
        text
    }
}

/// Emits `clip` with the new text whenever something copies text (copies over 20 000 chars are skipped).
pub fn watch_clipboard(app: AppHandle) {
    std::thread::spawn(move || {
        let mut seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let now = unsafe { GetClipboardSequenceNumber() };
            if now == seq {
                continue;
            }
            seq = now;
            if let Some(t) = read_clipboard().filter(|t| !t.trim().is_empty() && t.len() <= 20_000) {
                let _ = app.emit("clip", t);
            }
        }
    });
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let wide: Vec<u16> = text.encode_utf16().chain([0]).collect();
    unsafe {
        OpenClipboard(None).map_err(|e| e.to_string())?;
        let r = (|| {
            EmptyClipboard()?;
            let g = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2)?;
            let p = GlobalLock(g) as *mut u16;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), p, wide.len());
            let _ = GlobalUnlock(g);
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(g.0)))?; // the clipboard owns g now
            windows::core::Result::Ok(())
        })();
        let _ = CloseClipboard();
        r.map_err(|e| e.to_string())
    }
}

/// Windows' share sheet (Nearby Share, Mail, other apps) for shelf files; the closest thing to AirDrop.
#[tauri::command]
pub fn share_files(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Storage::{IStorageItem, StorageFile};
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;

    let win = app.get_webview_window("main").ok_or("no window")?;
    let raw = win.hwnd().map_err(|e| e.to_string())?.0 as isize; // HWND isn't Send; its value is
    let (tx, rx) = std::sync::mpsc::channel();
    // the handler from the previous share, removed before adding this one's
    static TOKEN: std::sync::Mutex<Option<i64>> = std::sync::Mutex::new(None);
    // the share UI has to be raised from the window's own (UI) thread
    win.run_on_main_thread(move || {
        let hwnd = windows::Win32::Foundation::HWND(raw as _);
        let r = (|| -> windows::core::Result<()> {
            let interop = windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>()?;
            let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };
            if let Some(old) = TOKEN.lock().unwrap().take() {
                let _ = dtm.RemoveDataRequested(old);
            }
            let handler = TypedEventHandler::new(move |_, args: windows::core::Ref<DataRequestedEventArgs>| {
                let req = args.ok()?.Request()?;
                let data = req.Data()?;
                let title = if paths.len() == 1 { "1 file from Perch".to_string() } else { format!("{} files from Perch", paths.len()) };
                data.Properties()?.SetTitle(&HSTRING::from(title))?;
                let deferral = req.GetDeferral()?;
                let items: Vec<Option<IStorageItem>> = paths.iter()
                    .filter_map(|p| StorageFile::GetFileFromPathAsync(&HSTRING::from(p)).ok()?.join().ok())
                    .filter_map(|f| f.cast::<IStorageItem>().ok().map(Some))
                    .collect();
                data.SetStorageItemsReadOnly(&windows_collections::IIterable::<IStorageItem>::from(items))?;
                deferral.Complete()
            });
            *TOKEN.lock().unwrap() = Some(dtm.DataRequested(&handler)?);
            unsafe { interop.ShowShareUIForWindow(hwnd) }
        })();
        let _ = tx.send(r.map_err(|e| e.to_string()));
    }).map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "Share didn't open.".to_string())?
}

/// Put the island window on `monitor` (index; out of range = primary) at the top or bottom edge.
pub fn place(win: &WebviewWindow, monitor: usize, position: &str) {
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
