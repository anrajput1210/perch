//! perch-hook: the command agents run as their hook. Forwards the hook JSON to Perch over a local named pipe
//! (Windows) or Unix socket (macOS) and,
//! for blocking events, prints Perch's answer. Fails open: if Perch isn't running or doesn't answer in time,
//! it prints nothing and exits 0, so the agent asks in its terminal as usual.
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::time::Duration;

const REPLY_TIMEOUT: Duration = Duration::from_secs(290); // under the 300 s hook timeout

#[cfg(unix)]
fn connect() -> Option<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(perch_core::socket_path()).map_err(|e| debug(&format!("connect failed: {e}"))).ok()
}

#[cfg(windows)]
fn connect() -> Option<std::fs::File> {
    const ERROR_PIPE_BUSY: i32 = 231;
    for _ in 0..6 {
        match std::fs::OpenOptions::new().read(true).write(true).open(perch_core::pipe_name()) {
            Ok(f) => return Some(f),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                debug(&format!("connect failed: {e}"));
                return None;
            }
        }
    }
    debug("pipe stayed busy");
    None
}

/// PERCH_DEBUG=1 prints what the relay does to stderr (never stdout: stdout is the hook's answer).
fn debug(msg: &str) {
    if std::env::var_os("PERCH_DEBUG").is_some() {
        eprintln!("perch-hook: {msg}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // perch-hook --install [claude|codex|gemini] / --uninstall [...]
    if let Some(cmd) = args.first().filter(|a| *a == "--install" || *a == "--uninstall") {
        let Some(a) = perch_core::hooks::agent(args.get(1).map_or("claude", String::as_str)) else {
            eprintln!("unknown agent; use claude, codex or gemini");
            std::process::exit(2)
        };
        let settings = perch_core::hooks::config_path(a);
        let exe = std::env::current_exe().unwrap_or_default();
        let res = if cmd == "--install" { perch_core::hooks::install_for(a, &settings, &exe) } else { perch_core::hooks::uninstall(&settings) };
        match res {
            Ok(()) => println!("{} {}", if cmd == "--install" { "Connected Perch to" } else { "Removed Perch from" }, settings.display()),
            Err(e) => { eprintln!("{e}"); std::process::exit(1) }
        }
        return;
    }
    let agent = args.iter().position(|a| a == "--agent").and_then(|i| args.get(i + 1)).filter(|a| perch_core::valid_agent(a));

    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return;
    }
    let Ok(mut ev) = serde_json::from_str::<serde_json::Value>(&input) else { return debug(&format!("stdin isn't JSON: {input:?}")) };
    if let Some(a) = agent {
        perch_core::translate(&mut ev, a);
        ev["perch_agent"] = a.clone().into();
    }
    let blocking = perch_core::is_blocking(&ev);

    let Some(mut pipe) = connect() else { return };
    if let Err(e) = writeln!(pipe, "{ev}") {
        return debug(&format!("write failed: {e}"));
    }
    debug(&format!("sent {} (blocking: {blocking})", ev["hook_event_name"]));
    if !blocking {
        return;
    }

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(pipe).read_line(&mut line);
        let _ = tx.send(line);
    });
    let got = rx.recv_timeout(REPLY_TIMEOUT);
    debug(&format!("reply: {got:?}"));
    if let Ok(line) = got {
        let line = line.trim();
        if !line.is_empty() {
            println!("{line}");
        }
    }
}
