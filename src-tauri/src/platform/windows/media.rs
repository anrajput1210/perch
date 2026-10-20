//! Now playing: the media session Windows shows in its volume flyout (Spotify, browsers, Media Player...).
//! Polled once a second and sent to the island as a `media` event; `null` when there is no media session.
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

#[derive(Clone, PartialEq, Serialize)]
pub struct Media {
    title: String,
    artist: String,
    app: String,
    playing: bool,
    /// seconds; 0 when the app doesn't report a timeline (many browsers)
    position: f64,
    duration: f64,
    /// album art bytes, sent only when the track changes
    art: Option<Vec<u8>>,
    art_type: String,
    /// album art as a URL instead of bytes (macOS Spotify); always None here
    art_url: Option<String>,
}

fn manager() -> windows::core::Result<Manager> {
    Manager::RequestAsync()?.join()
}

fn read(s: &Session, with_art: bool) -> windows::core::Result<Media> {
    let props = s.TryGetMediaPropertiesAsync()?.join()?;
    let playing = s.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;
    let t = s.GetTimelineProperties()?;
    let secs = |d: windows::Foundation::TimeSpan| d.Duration as f64 / 1e7;
    let app = s.SourceAppUserModelId()?.to_string();
    let app = app.rsplit(['\\', '!']).next().unwrap_or(&app).trim_end_matches(".exe").to_string();
    let (mut art, mut art_type) = (None, String::new());
    if with_art {
        if let Ok(stream) = props.Thumbnail().and_then(|r| r.OpenReadAsync()?.join()) {
            let size = stream.Size()? as u32;
            let reader = DataReader::CreateDataReader(&stream)?;
            reader.LoadAsync(size)?.join()?;
            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf)?;
            art_type = stream.ContentType()?.to_string();
            art = Some(buf);
        }
    }
    Ok(Media {
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        app,
        playing,
        position: secs(t.Position()?),
        duration: secs(t.EndTime()?),
        art,
        art_type,
        art_url: None,
    })
}

pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        // ponytail: polls every second instead of subscribing to session/property change events
        let mut last: Option<Media> = None;
        let mut track = String::new();
        let mut mgr = None;
        loop {
            if mgr.is_none() {
                mgr = manager().ok();
            }
            let cur = mgr.as_ref().and_then(|m| m.GetCurrentSession().ok()).and_then(|s| {
                let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
                let id = format!("{}\u{1}{}", props.Title().ok()?, props.Artist().ok()?);
                let m = read(&s, id != track).ok()?;
                track = id;
                Some(m)
            });
            if cur.is_none() {
                track.clear();
            }
            if cur != last {
                let _ = app.emit("media", &cur);
                last = cur.map(|m| Media { art: None, ..m });
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[tauri::command]
pub async fn media_control(action: String, position: Option<f64>) -> Result<(), String> {
    let s = manager().and_then(|m| m.GetCurrentSession()).map_err(|e| e.to_string())?;
    let op = match action.as_str() {
        "toggle" => s.TryTogglePlayPauseAsync(),
        "next" => s.TrySkipNextAsync(),
        "prev" => s.TrySkipPreviousAsync(),
        // TimeSpan ticks are 100 ns
        "seek" => s.TryChangePlaybackPositionAsync((position.unwrap_or(0.0).max(0.0) * 1e7) as i64),
        _ => return Err("unknown action".into()),
    };
    op.and_then(|o| o.join()).map(|_| ()).map_err(|e| e.to_string())
}
