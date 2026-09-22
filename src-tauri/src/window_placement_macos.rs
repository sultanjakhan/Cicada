use objc2_app_kit::{NSScreen, NSWindow};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, WindowEvent};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Frame {
    fn sane(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && (640.0..=10000.0).contains(&self.width)
            && (500.0..=10000.0).contains(&self.height)
    }

    fn rect(self) -> NSRect {
        NSRect::new(
            NSPoint::new(self.x, self.y),
            NSSize::new(self.width, self.height),
        )
    }
}

impl From<NSRect> for Frame {
    fn from(rect: NSRect) -> Self {
        Self {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }
}

fn state_path(data_dir: &Path, debug: bool) -> PathBuf {
    data_dir.join(if debug {
        "window-placement-macos.dev.json"
    } else {
        "window-placement-macos.json"
    })
}

fn title_bar_visible(frame: NSRect, visible: NSRect) -> bool {
    let left = frame.origin.x.max(visible.origin.x);
    let right = (frame.origin.x + frame.size.width).min(visible.origin.x + visible.size.width);
    let top = frame.origin.y + frame.size.height;
    right - left >= 120.0
        && top <= visible.origin.y + visible.size.height
        && top >= visible.origin.y + 40.0
}

fn on_available_screen(frame: NSRect, main_thread: MainThreadMarker) -> bool {
    NSScreen::screens(main_thread)
        .iter()
        .any(|screen| title_bar_visible(frame, screen.visibleFrame()))
}

fn read_frame(path: &Path) -> Option<Frame> {
    if std::fs::metadata(path).ok()?.len() > 4096 {
        return None;
    }
    let frame: Frame = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    frame.sane().then_some(frame)
}

fn native_window(window: &tauri::WebviewWindow) -> Option<(&NSWindow, MainThreadMarker)> {
    let main_thread = MainThreadMarker::new()?;
    let raw = window.ns_window().ok()?;
    // Tauri's window event callbacks and setup run on the UI thread.
    Some((unsafe { &*(raw as *const NSWindow) }, main_thread))
}

fn current_frame(window: &tauri::WebviewWindow) -> Option<Frame> {
    if window.is_minimized().ok()? {
        return None;
    }
    let (native, main_thread) = native_window(window)?;
    let frame = Frame::from(native.frame());
    (frame.sane() && on_available_screen(frame.rect(), main_thread)).then_some(frame)
}

fn restore_native(window: &NSWindow, saved: Option<Frame>, main_thread: MainThreadMarker) {
    let Some(saved) = saved else {
        return;
    };
    if on_available_screen(saved.rect(), main_thread) {
        window.setFrame_display(saved.rect(), false);
        return;
    }

    // A detached display may leave a saved frame entirely offscreen.
    if let Some(screen) = NSScreen::screens(main_thread).firstObject() {
        let visible = screen.visibleFrame();
        let size = NSSize::new(
            saved.width.min(visible.size.width),
            saved.height.min(visible.size.height),
        );
        let origin = NSPoint::new(
            visible.origin.x + (visible.size.width - size.width) / 2.0,
            visible.origin.y + (visible.size.height - size.height) / 2.0,
        );
        window.setFrame_display(NSRect::new(origin, size), false);
    }
}

#[derive(Default)]
struct Snapshot {
    current: Option<Frame>,
    saved: Option<Frame>,
}

pub(crate) struct PlacementState {
    path: PathBuf,
    snapshot: Mutex<Snapshot>,
}

impl PlacementState {
    fn update(&self, frame: Option<Frame>) {
        if let Some(frame) = frame {
            if let Ok(mut snapshot) = self.snapshot.lock() {
                snapshot.current = Some(frame);
            }
        }
    }

    fn flush(&self) {
        let Ok(mut snapshot) = self.snapshot.lock() else {
            return;
        };
        let Some(current) = snapshot.current else {
            return;
        };
        if snapshot.saved == Some(current) {
            return;
        }
        if let Ok(bytes) = serde_json::to_vec(&current) {
            if crate::update_journal::atomic_write(&self.path, &bytes).is_ok() {
                snapshot.saved = Some(current);
            }
        }
    }
}

pub(crate) fn restore(app: &tauri::AppHandle, data_dir: &Path, show: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let path = state_path(data_dir, cfg!(debug_assertions));
    let saved = read_frame(&path);
    if let Some((native, main_thread)) = native_window(&window) {
        restore_native(native, saved, main_thread);
    }

    let state = Arc::new(PlacementState {
        path,
        snapshot: Mutex::new(Snapshot {
            current: current_frame(&window),
            saved,
        }),
    });
    app.manage(state.clone());
    let tracked_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            state.update(current_frame(&tracked_window));
        }
        WindowEvent::CloseRequested { .. } => {
            state.update(current_frame(&tracked_window));
            state.flush();
        }
        _ => {}
    });

    if show {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn persist_for_exit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<PlacementState>>() {
        state.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_file_isolated_by_directory_and_build() {
        assert_ne!(
            state_path(Path::new("/tmp/profile-a"), false),
            state_path(Path::new("/tmp/profile-b"), false)
        );
        assert_ne!(
            state_path(Path::new("/tmp/profile-a"), false),
            state_path(Path::new("/tmp/profile-a"), true)
        );
        assert_eq!(
            state_path(Path::new("/tmp/profile-a"), false),
            Path::new("/tmp/profile-a/window-placement-macos.json")
        );
    }

    #[test]
    fn malformed_or_non_finite_saved_geometry_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = state_path(directory.path(), false);
        std::fs::write(&path, b"{\"x\":0,\"y\":0,\"width\":0,\"height\":720}").unwrap();
        assert!(read_frame(&path).is_none());
        std::fs::write(&path, b"not json").unwrap();
        assert!(read_frame(&path).is_none());
        assert!(!Frame {
            x: f64::NAN,
            y: 0.0,
            width: 760.0,
            height: 720.0
        }
        .sane());
    }

    #[test]
    fn exact_logical_frame_survives_an_atomic_save_and_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = state_path(directory.path(), false);
        let frame = Frame {
            x: 1851.0,
            y: 263.0,
            width: 760.0,
            height: 720.0,
        };
        let state = PlacementState {
            path: path.clone(),
            snapshot: Mutex::new(Snapshot {
                current: Some(frame),
                saved: None,
            }),
        };
        state.flush();
        assert_eq!(read_frame(&path), Some(frame));
        assert_eq!(state.snapshot.lock().unwrap().saved, Some(frame));
    }

    #[test]
    fn exit_without_a_new_frame_preserves_the_loaded_position() {
        let directory = tempfile::tempdir().unwrap();
        let path = state_path(directory.path(), false);
        let loaded = Frame {
            x: 1851.0,
            y: 263.0,
            width: 760.0,
            height: 720.0,
        };
        let original = serde_json::to_vec(&loaded).unwrap();
        std::fs::write(&path, &original).unwrap();
        let state = PlacementState {
            path: path.clone(),
            snapshot: Mutex::new(Snapshot {
                current: None,
                saved: read_frame(&path),
            }),
        };
        state.update(None);
        state.flush();
        assert_eq!(std::fs::read(&path).unwrap(), original);
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
