//! Windows-only source. Never asks for window titles, executable paths or pixels.
//! WinEvent hooks retain only a continuity counter, not handles or event history.
use super::{Sample, IDLE_LIMIT_MS};
use ::windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE, HWND},
        System::{
            ProcessStatus::K32GetModuleBaseNameW,
            RemoteDesktop::{
                ProcessIdToSessionId, WTSActive, WTSConnectState, WTSFreeMemory,
                WTSQuerySessionInformationW, WTS_CONNECTSTATE_CLASS,
            },
            StationsAndDesktops::{
                CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS,
                DESKTOP_READOBJECTS, UOI_NAME,
            },
            SystemInformation::GetTickCount64,
            Threading::{
                GetCurrentProcessId, OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
            },
            WindowsProgramming::QueryUnbiasedInterruptTime,
        },
        UI::{
            Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK},
            Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
            WindowsAndMessaging::{
                DispatchMessageW, GetForegroundWindow, GetWindowThreadProcessId, PeekMessageW,
                TranslateMessage, EVENT_SYSTEM_DESKTOPSWITCH, EVENT_SYSTEM_FOREGROUND, MSG,
                PM_REMOVE, WINEVENT_OUTOFCONTEXT,
            },
        },
    },
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const UNAVAILABLE: &str = "personal_activity_source_unavailable";
static CONTINUITY: AtomicU64 = AtomicU64::new(0);

unsafe extern "system" fn changed(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    CONTINUITY.fetch_add(1, Ordering::Relaxed);
}

pub(super) struct Observer {
    hooks: [HWINEVENTHOOK; 2],
}

impl Observer {
    pub(super) fn new() -> Result<Self, String> {
        // OUTOFCONTEXT callbacks are delivered on this creating thread's message
        // loop. No DLL injection, object accessibility reads or keyboard hook.
        let mut hooks = [HWINEVENTHOOK::default(); 2];
        for (index, event) in [EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_DESKTOPSWITCH]
            .into_iter()
            .enumerate()
        {
            hooks[index] = unsafe {
                SetWinEventHook(
                    event,
                    event,
                    None,
                    Some(changed),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hooks[index].is_invalid() {
                for hook in hooks.into_iter().filter(|v| !v.is_invalid()) {
                    unsafe {
                        let _ = UnhookWinEvent(hook);
                    }
                }
                return Err(UNAVAILABLE.into());
            }
        }
        Ok(Self { hooks })
    }

    pub(super) fn pump(&mut self) -> bool {
        let mut message = MSG::default();
        for _ in 0..256 {
            if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                return true;
            }
            unsafe {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        false
    }

    pub(super) fn sample(&mut self, allowlist: &[String]) -> Result<Sample, String> {
        if !self.pump() {
            return Err(UNAVAILABLE.into());
        }
        let before = CONTINUITY.load(Ordering::Relaxed);
        let unlocked = session_active()? && default_input_desktop()?;
        let tick = unsafe { GetTickCount64() };
        let mut last_input = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !unsafe { GetLastInputInfo(&mut last_input) }.as_bool() {
            return Err(UNAVAILABLE.into());
        }
        // LASTINPUTINFO uses a wrapping 32-bit tick. An anomalous or future
        // timestamp becomes a very large idle age and fails closed.
        let idle_ms = (tick as u32).wrapping_sub(last_input.dwTime) as u64;
        let executable = if unlocked && idle_ms < IDLE_LIMIT_MS {
            foreground_basename(allowlist)?
        } else {
            None
        };
        let mut awake = 0;
        if !unsafe { QueryUnbiasedInterruptTime(&mut awake) }.as_bool() {
            return Err(UNAVAILABLE.into());
        }
        if !self.pump() {
            return Err(UNAVAILABLE.into());
        }
        let continuity = CONTINUITY.load(Ordering::Relaxed);
        Ok(Sample {
            utc_ms: i64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| UNAVAILABLE)?
                    .as_millis(),
            )
            .map_err(|_| UNAVAILABLE)?,
            tick_ms: tick,
            awake_ms: awake / 10_000,
            continuity,
            executable,
            idle_ms,
            // A switch during source acquisition invalidates this sample too.
            unlocked: unlocked && before == continuity,
        })
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        for hook in self.hooks {
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
    }
}

fn session_active() -> Result<bool, String> {
    unsafe {
        let mut session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut session).map_err(|_| UNAVAILABLE)?;
        let mut buffer = PWSTR::null();
        let mut bytes = 0;
        WTSQuerySessionInformationW(None, session, WTSConnectState, &mut buffer, &mut bytes)
            .map_err(|_| UNAVAILABLE)?;
        if buffer.is_null() {
            return Err(UNAVAILABLE.into());
        }
        let state = if bytes as usize >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>() {
            Some(std::ptr::read_unaligned(
                buffer.0.cast::<WTS_CONNECTSTATE_CLASS>(),
            ))
        } else {
            None
        };
        WTSFreeMemory(buffer.0.cast());
        Ok(state.ok_or(UNAVAILABLE)? == WTSActive)
    }
}

fn default_input_desktop() -> Result<bool, String> {
    unsafe {
        // A secure/locked/UAC desktop either differs from Default or denies this
        // minimal read. Denial is unknown and cannot produce a gaming interval.
        let desktop = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            .map_err(|_| UNAVAILABLE)?;
        let mut name = [0u16; 64];
        let mut bytes = 0;
        let result = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            std::mem::size_of_val(&name) as u32,
            Some(&mut bytes),
        );
        let _ = CloseDesktop(desktop);
        result.map_err(|_| UNAVAILABLE)?;
        if bytes as usize > std::mem::size_of_val(&name) {
            return Err(UNAVAILABLE.into());
        }
        let end = name.iter().position(|v| *v == 0).ok_or(UNAVAILABLE)?;
        Ok(name[..end] == "Default".encode_utf16().collect::<Vec<_>>())
    }
}

fn foreground_basename(allowlist: &[String]) -> Result<Option<String>, String> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_invalid() {
            return Err(UNAVAILABLE.into());
        }
        let mut pid = 0;
        if GetWindowThreadProcessId(window, Some(&mut pid)) == 0 || pid == 0 {
            return Err(UNAVAILABLE.into());
        }
        let process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            .map_err(|_| UNAVAILABLE)?;
        let mut name = [0u16; 260];
        // A basename API avoids even transient acquisition of a private path.
        // Access-denied/protected games are unknown, never guessed from titles.
        let count = K32GetModuleBaseNameW(process, None, &mut name) as usize;
        let _ = CloseHandle(process);
        if count == 0 || count >= name.len() {
            return Err(UNAVAILABLE.into());
        }
        let basename = String::from_utf16(&name[..count])
            .map_err(|_| UNAVAILABLE)?
            .to_lowercase();
        // Validate foreground stability before permitting persistence. Hooks also
        // break away-and-back switches occurring entirely between sampling ticks.
        if GetForegroundWindow() != window {
            return Err(UNAVAILABLE.into());
        }
        Ok(allowlist
            .iter()
            .find(|allowed| **allowed == basename)
            .cloned())
    }
}
