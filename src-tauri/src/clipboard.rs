// The PRIMARY selection: the "middle-click clipboard" every X11 and Wayland desktop keeps
// alongside the ordinary one. A terminal writes to it the moment you drag over text and reads
// it on a middle click, and it is deliberately NOT the CLIPBOARD that Ctrl+Shift+C uses, which
// is the whole point: selecting text can never clobber what you deliberately copied.
//
// It needs its own commands because nothing else can reach it. No browser API exposes PRIMARY
// at all, and tauri-plugin-clipboard-manager speaks only CLIPBOARD. This talks to arboard
// directly, which costs no build time: the plugin already pulls it in.

use std::sync::Mutex;

use arboard::{Clipboard, Error, GetExtLinux, LinuxClipboardKind, SetExtLinux};

/// One long-lived clipboard connection, built on first use.
///
/// Long-lived is not a convenience. Under X11 the data lives in the process that owns the
/// selection, served by a thread arboard ties to the `Clipboard`, so a per-call instance would
/// drop what it just wrote the instant it returned. (Wayland forks a server process instead and
/// would not care, but one code path is enough.) Lazy because the connection can fail, and a
/// missing clipboard must not stop Athena from starting.
#[derive(Default)]
pub struct Primary(Mutex<Option<Clipboard>>);

impl Primary {
    fn run<T>(&self, f: impl FnOnce(&mut Clipboard) -> Result<T, Error>) -> Result<T, Error> {
        // A panic in another call poisoned nothing that matters here: the value behind the lock
        // is a connection, not an invariant, so the poison is stepped over rather than spread.
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_none() {
            *slot = Some(Clipboard::new()?);
        }
        let out = f(slot.as_mut().expect("just connected"));
        // A connection broken by a compositor restart stays broken, and every later call would
        // fail against the corpse. Drop it so the next call reconnects. An empty selection is
        // not a broken connection, so it is the one error that keeps the connection.
        if matches!(&out, Err(e) if !matches!(e, Error::ContentNotAvailable)) {
            *slot = None;
        }
        out
    }
}

/// The PRIMARY selection's text, or `""` when nothing is selected anywhere on the desktop.
///
/// Empty is a normal answer rather than an error: it means a middle click pastes nothing.
#[tauri::command]
pub fn primary_read(state: tauri::State<'_, Primary>) -> Result<String, String> {
    match state.run(|cb| cb.get().clipboard(LinuxClipboardKind::Primary).text()) {
        Ok(text) => Ok(text),
        Err(Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Take ownership of the PRIMARY selection with this text.
#[tauri::command]
pub fn primary_write(text: String, state: tauri::State<'_, Primary>) -> Result<(), String> {
    state
        .run(|cb| cb.set().clipboard(LinuxClipboardKind::Primary).text(text))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// cargo test -- --ignored --nocapture
    ///
    /// Ignored by default because it needs a real desktop session and momentarily takes the
    /// PRIMARY selection off whoever owns it. That is also the only way to find out whether this
    /// machine's compositor speaks the primary-selection protocol at all, which is the one thing
    /// about this file that cannot be answered by reading it. Whatever was selected is put back.
    #[test]
    #[ignore]
    fn primary_round_trips() {
        let p = Primary::default();
        let before = primary_read(/* state */ &p).expect("read");

        primary_write_inner(&p, "athena primary check").expect("write");
        assert_eq!(primary_read(&p).expect("read back"), "athena primary check");

        if !before.is_empty() {
            primary_write_inner(&p, &before).expect("restore");
        }
    }

    // The commands themselves take tauri::State, which a unit test cannot build, so the test
    // drives the same two closures against the same Primary.
    fn primary_read(p: &Primary) -> Result<String, String> {
        match p.run(|cb| cb.get().clipboard(LinuxClipboardKind::Primary).text()) {
            Ok(t) => Ok(t),
            Err(Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn primary_write_inner(p: &Primary, text: &str) -> Result<(), String> {
        p.run(|cb| cb.set().clipboard(LinuxClipboardKind::Primary).text(text.to_string()))
            .map_err(|e| e.to_string())
    }
}
