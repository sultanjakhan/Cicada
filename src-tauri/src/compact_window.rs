//! A reversible presentation mode of the existing Windows main window.
use std::sync::Mutex;
use serde::Serialize;
use tauri::{State, WebviewWindow};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, SetWindowPlacement, WINDOWPLACEMENT};

#[derive(Default)]
pub(crate) struct CompactWindow(Mutex<Option<Frame>>);
#[cfg(windows)]
struct Frame {
    size: tauri::PhysicalSize<u32>,
    maximized: bool,
    always_on_top: bool,
    placement: WINDOWPLACEMENT,
}
#[cfg(not(windows))]
struct Frame;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status { supported: bool, compact: bool }

#[tauri::command]
pub(crate) fn get_compact_window_state(state: State<'_, CompactWindow>) -> Result<Status, String> {
    let guard = state.0.lock().map_err(|_| "Не удалось прочитать режим окна.")?;
    Ok(Status { supported: cfg!(windows), compact: guard.is_some() })
}

#[cfg(windows)]
fn restore(window: &WebviewWindow, frame: &Frame) -> tauri::Result<()> {
    window.set_always_on_top(frame.always_on_top)?;
    window.set_min_size(Some(tauri::LogicalSize::new(640., 500.)))?;
    let monitors = window.available_monitors()?;
    let normal = frame.placement.rcNormalPosition;
    let visible = monitors.iter().any(|monitor| {
        let p = monitor.position(); let s = monitor.size();
        visible_title(normal.left, normal.top, (normal.right-normal.left).max(0) as u32, p.x, p.y, s.width, s.height)
    });
    if visible {
        // Preserve the normal frame as well as the maximized state.
        unsafe { SetWindowPlacement(window.hwnd()?, &frame.placement) }
            .map_err(|error| std::io::Error::other(error.to_string()))?;
    } else {
        window.set_size(frame.size)?;
        window.center()?;
        if frame.maximized { window.maximize()?; }
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn visible_title(x: i32, y: i32, width: u32, mx: i32, my: i32, mw: u32, mh: u32) -> bool {
    let (x,y,mx,my)=(i64::from(x),i64::from(y),i64::from(mx),i64::from(my));
    x + i64::from(width) >= mx + 100 && x <= mx + i64::from(mw) - 100
        && y >= my && y <= my + i64::from(mh) - 60
}

#[tauri::command]
pub(crate) fn set_compact_window(window: WebviewWindow, state: State<'_, CompactWindow>, compact: bool) -> Result<Status, String> {
    #[cfg(not(windows))]
    { let _ = (window,state,compact); Err("Компактное окно пока доступно на Windows.".into()) }
    #[cfg(windows)]
    {
        if window.label() != "main" { return Err("Неизвестное окно.".into()); }
        let mut guard = state.0.lock().map_err(|_| "Не удалось изменить режим окна.")?;
        if compact && guard.is_none() {
            if window.is_fullscreen().map_err(|_| "Не удалось прочитать режим окна.")? {
                return Err("Сначала выйди из полноэкранного режима.".into());
            }
            let mut placement = WINDOWPLACEMENT { length: std::mem::size_of::<WINDOWPLACEMENT>() as u32, ..Default::default() };
            unsafe { GetWindowPlacement(window.hwnd().map_err(|_| "Не удалось прочитать окно.")?, &mut placement) }
                .map_err(|_| "Не удалось прочитать положение окна.")?;
            let frame = Frame {
                size: window.inner_size().map_err(|_| "Не удалось прочитать размер окна.")?,
                maximized: window.is_maximized().map_err(|_| "Не удалось прочитать режим окна.")?,
                always_on_top: window.is_always_on_top().map_err(|_| "Не удалось прочитать режим окна.")?,
                placement,
            };
            let change = (|| -> tauri::Result<()> {
                if frame.maximized { window.unmaximize()?; }
                window.set_min_size(Some(tauri::LogicalSize::new(320., 180.)))?;
                window.set_size(tauri::LogicalSize::new(420., 260.))?;
                window.set_always_on_top(true)?;
                Ok(())
            })();
            if change.is_err() {
                // Retain recovery state if rollback fails; the user can retry Expand.
                if restore(&window, &frame).is_err() { *guard = Some(frame); }
                return Err("Не удалось уменьшить окно. Верни полный режим и повтори.".into());
            }
            *guard = Some(frame);
        } else if !compact {
            if let Some(frame) = guard.as_ref() {
                restore(&window, frame).map_err(|_| "Не удалось вернуть размер окна. Повтори «Развернуть».".to_string())?;
                *guard = None;
            }
        }
        Ok(Status { supported: true, compact: guard.is_some() })
    }
}

#[cfg(test)]
mod tests {
    use super::visible_title;
    #[test]
    fn restores_only_where_title_bar_can_be_reached() {
        assert!(visible_title(100,100,760,0,0,1920,1080));
        assert!(visible_title(-600,100,760,0,0,1920,1080));
        assert!(!visible_title(2100,100,760,0,0,1920,1080));
        assert!(!visible_title(100,-40,760,0,0,1920,1080));
        assert!(!visible_title(100,1060,760,0,0,1920,1080));
        assert!(visible_title(-1700,100,760,-1920,0,1920,1080));
    }
}
