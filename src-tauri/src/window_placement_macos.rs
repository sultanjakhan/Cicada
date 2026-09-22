use objc2_app_kit::{NSScreen, NSWindow};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Manager;

fn autosave_name(data_dir: &Path) -> String {
    let profile = Sha256::digest(data_dir.as_os_str().as_encoded_bytes());
    let build = if cfg!(debug_assertions) {
        "dev"
    } else {
        "release"
    };
    format!("Cicada.main.{build}.{}", hex::encode(profile))
}

fn title_bar_visible(frame: NSRect, visible: NSRect) -> bool {
    let left = frame.origin.x.max(visible.origin.x);
    let right = (frame.origin.x + frame.size.width).min(visible.origin.x + visible.size.width);
    let top = frame.origin.y + frame.size.height;
    right - left >= 120.0
        && top <= visible.origin.y + visible.size.height
        && top >= visible.origin.y + 40.0
}

fn restore_native(window: &NSWindow, data_dir: &Path, main_thread: MainThreadMarker) {
    let name = NSString::from_str(&autosave_name(data_dir));
    let restored = window.setFrameUsingName(&name);
    let _ = window.setFrameAutosaveName(&name);
    if !restored {
        return;
    }

    let frame = window.frame();
    if NSScreen::screens(main_thread)
        .iter()
        .any(|screen| title_bar_visible(frame, screen.visibleFrame()))
    {
        return;
    }

    // A detached display may leave a saved frame entirely offscreen.
    if let Some(screen) = NSScreen::mainScreen(main_thread) {
        let visible = screen.visibleFrame();
        let size = NSSize::new(
            frame.size.width.min(visible.size.width),
            frame.size.height.min(visible.size.height),
        );
        let origin = NSPoint::new(
            visible.origin.x + (visible.size.width - size.width) / 2.0,
            visible.origin.y + (visible.size.height - size.height) / 2.0,
        );
        window.setFrame_display(NSRect::new(origin, size), false);
    }
}

pub(crate) fn restore(app: &tauri::AppHandle, data_dir: &Path, show: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Some(main_thread) = MainThreadMarker::new() {
        if let Ok(raw) = window.ns_window() {
            // Tauri creates the NSWindow before setup, which runs on the UI thread.
            let native = unsafe { &*(raw as *const NSWindow) };
            restore_native(native, data_dir, main_thread);
        }
    }
    if show {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autosave_names_are_profile_and_build_scoped() {
        assert_eq!(
            autosave_name(Path::new("/tmp/cicada-a")),
            autosave_name(Path::new("/tmp/cicada-a"))
        );
        assert_ne!(
            autosave_name(Path::new("/tmp/cicada-a")),
            autosave_name(Path::new("/tmp/cicada-b"))
        );
        let build = if cfg!(debug_assertions) {
            "dev"
        } else {
            "release"
        };
        assert!(
            autosave_name(Path::new("/tmp/cicada-a")).starts_with(&format!("Cicada.main.{build}."))
        );
    }

    #[test]
    fn title_bar_must_remain_on_an_available_screen() {
        let screen = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1920.0, 1040.0));
        let on_screen = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(760.0, 720.0));
        let detached = NSRect::new(NSPoint::new(2500.0, 100.0), NSSize::new(760.0, 720.0));
        let hidden_title = NSRect::new(NSPoint::new(100.0, 900.0), NSSize::new(760.0, 720.0));
        assert!(title_bar_visible(on_screen, screen));
        assert!(!title_bar_visible(detached, screen));
        assert!(!title_bar_visible(hidden_title, screen));
    }

    #[test]
    fn equally_sized_displays_are_distinguished_by_position() {
        let left = NSRect::new(NSPoint::new(-1920.0, 0.0), NSSize::new(1920.0, 1040.0));
        let right = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1920.0, 1040.0));
        let on_left = NSRect::new(NSPoint::new(-1800.0, 100.0), NSSize::new(760.0, 720.0));
        assert!(title_bar_visible(on_left, left));
        assert!(!title_bar_visible(on_left, right));
    }
}
