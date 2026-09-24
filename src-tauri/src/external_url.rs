//! Opens a validated http(s) link in the system browser (wish links and
//! Markdown links call `open_url`). The link is one argument of a fixed
//! program, never shell text. Mobile has no launcher yet: the command reports
//! `open_url_unsupported` and the interface offers to copy the link instead.
use std::process::Command;

const MAX_URL_LENGTH: usize = 2000;

/// Accepts only an absolute http(s) URL with a host and without whitespace,
/// control characters, quotes, angle brackets, backslashes or backticks.
pub(crate) fn validated_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or("open_url_invalid")?;
    let host_missing = rest.is_empty() || rest.starts_with(['/', '?', '#']);
    let unsafe_char = url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '<' | '>' | '\\' | '`'));
    if url.len() > MAX_URL_LENGTH || host_missing || unsafe_char {
        return Err("open_url_invalid".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let url = validated_url(&url)?;
    let mut command = launcher(&url)?;
    let mut child = command.spawn().map_err(|_| "open_url_failed".to_string())?;
    // Reap the short-lived launcher without blocking the command thread.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn launcher(url: &str) -> Result<Command, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let program = std::env::var_os("SystemRoot")
        .map(|root| {
            std::path::PathBuf::from(root)
                .join("System32")
                .join("rundll32.exe")
        })
        .unwrap_or_else(|| "rundll32.exe".into());
    let mut command = Command::new(program);
    command
        .args(["url.dll,FileProtocolHandler", url])
        .creation_flags(CREATE_NO_WINDOW);
    Ok(command)
}

#[cfg(target_os = "macos")]
fn launcher(url: &str) -> Result<Command, String> {
    let mut command = Command::new("/usr/bin/open");
    command.arg(url);
    Ok(command)
}

#[cfg(all(
    unix,
    not(target_os = "macos"),
    not(target_os = "android"),
    not(target_os = "ios")
))]
fn launcher(url: &str) -> Result<Command, String> {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    Ok(command)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn launcher(_: &str) -> Result<Command, String> {
    Err("open_url_unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::validated_url;

    #[test]
    fn accepts_http_and_https_links_with_a_host() {
        for url in [
            "https://example.com",
            "http://example.com/path?q=1&b=2#part",
            "HTTPS://Example.com/it's",
            "  https://example.com/a%20b  ",
        ] {
            assert!(validated_url(url).is_ok(), "{url}");
        }
        assert_eq!(
            validated_url("  https://example.com/x ").unwrap(),
            "https://example.com/x"
        );
    }

    #[test]
    fn rejects_other_schemes_missing_hosts_and_unsafe_characters() {
        let long = format!("https://example.com/{}", "a".repeat(2000));
        for url in [
            "",
            "example.com",
            "file:///C:/Windows/system32",
            "javascript:alert(1)",
            "ftp://example.com",
            "https://",
            "https:///path",
            "https://?q",
            "https://example.com/a b",
            "https://example.com/\"quoted\"",
            "https://example.com/<tag>",
            "https://example.com\\evil",
            "https://example.com/`cmd`",
            "https://example.com/\nnext",
            long.as_str(),
        ] {
            assert_eq!(
                validated_url(url).unwrap_err(),
                "open_url_invalid",
                "{url:?}"
            );
        }
    }
}
