//! Jira Cloud integration.
//!
//! Phase 1 ships exactly one user-facing feature — turning a typed issue key
//! (e.g. `OWS-12345`) into a Jira-style branch name (`OWS-12345-the-summary`)
//! — but the connection layer is built to be reused by later features.
//!
//! Auth is OAuth 2.0 (3LO). Meridian ships its *own* Atlassian OAuth app —
//! its client id + secret are baked in at build time from `src-tauri/.env`
//! (see `build.rs` / `built_in_app`) — so end users connect with one click and
//! never handle credentials. The connect flow is a standard loopback redirect:
//! we open the system browser to Atlassian's consent screen, catch the `?code=…`
//! callback on a one-shot localhost server, exchange it for tokens (Atlassian's
//! 3LO token endpoint requires the client secret even with PKCE, so the secret
//! must be present here), and discover the site's cloud id.
//!
//! The only per-user secret is the rotating refresh token, which lives in the
//! OS keychain. Non-secret metadata (cloud id, site URL, account name, reconnect
//! flag) lives in `jira.json` in the app-data dir — kept separate from
//! `state.json`, which the frontend `persist` layer rewrites wholesale and would
//! otherwise clobber.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

/// Keychain service; the same identifier as the app bundle.
const KEYRING_SERVICE: &str = "com.meridian.ade";
/// Keychain entry prefix for the (rotating) OAuth refresh token. Windows
/// Credential Manager caps one credential blob at 2560 bytes and Atlassian
/// refresh tokens routinely exceed that, so the token is split into
/// `jira.refresh_token.0`, `.1`, … with `jira.refresh_token.count` recording how
/// many chunks. Always go through `store_refresh`/`load_refresh`/`clear_refresh`.
const KEY_REFRESH: &str = "jira.refresh_token";
const KEY_REFRESH_COUNT: &str = "jira.refresh_token.count";
/// Chunk size in chars (~2000 UTF-16 bytes), comfortably under the 2560 cap.
const REFRESH_CHUNK_CHARS: usize = 1000;
/// Fixed loopback port. Must match the callback URL registered in Meridian's
/// Atlassian app (`http://localhost:33418/callback`), so it can't be ephemeral.
const REDIRECT_PORT: u16 = 33418;
/// `offline_access` is what makes Atlassian return a refresh token.
const SCOPES: &str = "read:jira-work read:jira-user offline_access";
/// How long the connect flow waits for the browser callback before giving up.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);

fn callback_url() -> String {
    format!("http://localhost:{REDIRECT_PORT}/callback")
}

/// Meridian's own OAuth app credentials, baked in at build time from
/// `src-tauri/.env` (see `build.rs`). `None` when the build wasn't configured
/// with them — the Connections card then reports Jira as unconfigured.
fn built_in_app() -> Option<(&'static str, &'static str)> {
    let id = option_env!("MERIDIAN_JIRA_CLIENT_ID")?;
    let secret = option_env!("MERIDIAN_JIRA_CLIENT_SECRET")?;
    if id.is_empty() || secret.is_empty() {
        return None;
    }
    Some((id, secret))
}

// --- In-memory access-token cache ---------------------------------------------

/// A short-lived access token plus the instant it should be considered stale.
#[derive(Clone)]
struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

/// Managed state: the access token is cached in memory only (refresh tokens are
/// the durable credential and live in the keychain). Mirrors the `PtyManager` /
/// `BrowserManager` pattern of a `Default` struct registered via `.manage(...)`.
#[derive(Default)]
pub struct JiraState {
    token: Mutex<Option<CachedToken>>,
}

// --- Persisted, non-secret metadata -------------------------------------------

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct JiraMeta {
    #[serde(default)]
    cloud_id: String,
    #[serde(default)]
    site_url: String,
    #[serde(default)]
    account_name: String,
    /// Set when a token refresh fails with `invalid_grant` — the refresh token
    /// expired or was revoked and the user must re-authorize.
    #[serde(default)]
    needs_reconnect: bool,
}

fn meta_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("jira.json"))
}

fn load_meta(app: &AppHandle) -> JiraMeta {
    meta_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_meta(app: &AppHandle, meta: &JiraMeta) -> Result<(), String> {
    let path = meta_path(app)?;
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

// --- Keychain helpers ---------------------------------------------------------

fn kc_get(key: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, key)
        .ok()?
        .get_password()
        .ok()
}

fn kc_set(key: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

fn kc_delete(key: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key) {
        // NoEntry (nothing stored) is fine; ignore either way.
        let _ = entry.delete_credential();
    }
}

/// Store the refresh token split across keychain entries so each stays under
/// the Windows credential blob size limit. Clears any prior token first.
fn store_refresh(token: &str) -> Result<(), String> {
    clear_refresh();
    let chars: Vec<char> = token.chars().collect();
    let chunks: Vec<&[char]> = chars.chunks(REFRESH_CHUNK_CHARS).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        let part: String = chunk.iter().collect();
        kc_set(&format!("{KEY_REFRESH}.{i}"), &part)?;
    }
    kc_set(KEY_REFRESH_COUNT, &chunks.len().to_string())
}

/// Reassemble the chunked refresh token, or None if none is stored.
fn load_refresh() -> Option<String> {
    let count: usize = kc_get(KEY_REFRESH_COUNT)?.parse().ok()?;
    let mut token = String::new();
    for i in 0..count {
        token.push_str(&kc_get(&format!("{KEY_REFRESH}.{i}"))?);
    }
    Some(token)
}

/// Remove every refresh-token chunk (and any legacy single-entry value).
fn clear_refresh() {
    if let Some(count) = kc_get(KEY_REFRESH_COUNT).and_then(|c| c.parse::<usize>().ok()) {
        for i in 0..count {
            kc_delete(&format!("{KEY_REFRESH}.{i}"));
        }
    }
    kc_delete(KEY_REFRESH_COUNT);
    kc_delete(KEY_REFRESH);
}

// --- Status -------------------------------------------------------------------

/// Connection state surfaced to the Connections settings UI.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraStatus {
    /// Authorized and ready to make API calls.
    connected: bool,
    /// Was connected, but the refresh token expired/was revoked — re-auth needed.
    needs_reconnect: bool,
    /// This build shipped with Jira app credentials (can connect at all).
    has_app: bool,
    site_url: Option<String>,
    account_name: Option<String>,
    /// Last connect error, if any (transient; only set by `jira_connect`).
    error: Option<String>,
}

fn build_status(app: &AppHandle, error: Option<String>) -> JiraStatus {
    let meta = load_meta(app);
    let has_refresh = load_refresh().is_some();
    let connected = has_refresh && !meta.cloud_id.is_empty() && !meta.needs_reconnect;
    JiraStatus {
        connected,
        needs_reconnect: meta.needs_reconnect && has_refresh,
        has_app: built_in_app().is_some(),
        site_url: (!meta.site_url.is_empty()).then(|| meta.site_url.clone()),
        account_name: (!meta.account_name.is_empty()).then(|| meta.account_name.clone()),
        error,
    }
}

#[tauri::command]
pub fn jira_status(app: AppHandle) -> JiraStatus {
    build_status(&app, None)
}

#[tauri::command]
pub fn jira_disconnect(app: AppHandle, state: State<'_, JiraState>) -> Result<JiraStatus, String> {
    // Forget the authorization (clears every refresh-token chunk).
    clear_refresh();
    let mut meta = load_meta(&app);
    meta.cloud_id.clear();
    meta.site_url.clear();
    meta.account_name.clear();
    meta.needs_reconnect = false;
    save_meta(&app, &meta)?;
    if let Ok(mut guard) = state.token.lock() {
        *guard = None;
    }
    Ok(build_status(&app, None))
}

// --- Connect (OAuth 3LO loopback) ---------------------------------------------

#[tauri::command]
pub async fn jira_connect(
    app: AppHandle,
    state: State<'_, JiraState>,
) -> Result<JiraStatus, String> {
    let (client_id, client_secret) = match built_in_app() {
        Some(creds) => creds,
        None => {
            return Err("This build of Meridian isn't configured with Jira credentials.".into())
        }
    };

    let app2 = app.clone();
    // The whole flow (browser open + blocking accept loop + token exchange) runs
    // off-thread so the UI never stalls, matching `claude_usage`'s pattern.
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_oauth_flow(&app2, client_id, client_secret)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(token) => {
            if let Ok(mut guard) = state.token.lock() {
                *guard = Some(token);
            }
            Ok(build_status(&app, None))
        }
        // Surface the failure in the status payload rather than as a hard reject,
        // so the UI can render it next to the (still not connected) Jira card.
        Err(e) => Ok(build_status(&app, Some(e))),
    }
}

/// Runs the full authorization-code flow and persists the results. Returns the
/// fresh in-memory access token on success.
fn run_oauth_flow(
    app: &AppHandle,
    client_id: &str,
    client_secret: &str,
) -> Result<CachedToken, String> {
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).map_err(|e| {
        format!(
            "Couldn't start the local callback server on port {REDIRECT_PORT} ({e}). \
             Close whatever is using that port and try again."
        )
    })?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let csrf = gen_state();
    let auth_url = format!(
        "https://auth.atlassian.com/authorize?audience=api.atlassian.com\
         &client_id={cid}&scope={scope}&redirect_uri={redirect}\
         &state={state}&response_type=code&prompt=consent",
        cid = urlencode(client_id),
        scope = urlencode(SCOPES),
        redirect = urlencode(&callback_url()),
        state = urlencode(&csrf),
    );
    log::info!("jira: opening browser for authorization");
    open_url(app, &auth_url)?;

    let (code, returned_state) = wait_for_callback(&listener, CALLBACK_TIMEOUT)?;
    if returned_state != csrf {
        return Err("Authorization failed the CSRF state check. Please try again.".into());
    }

    let token_json = exchange_code(client_id, client_secret, &code)?;
    let access_token = token_json
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Token response contained no access_token.")?
        .to_string();
    let refresh_token = token_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or(
            "No refresh token was returned. Make sure the 'offline_access' scope \
             is enabled on your Atlassian app.",
        )?
        .to_string();
    let expires_in = token_json
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);

    let (cloud_id, site_url) = first_accessible_site(&access_token)?;
    let account_name = fetch_account_name(&access_token, &cloud_id).unwrap_or_default();

    store_refresh(&refresh_token)?;
    let mut meta = load_meta(app);
    meta.cloud_id = cloud_id;
    meta.site_url = site_url;
    meta.account_name = account_name;
    meta.needs_reconnect = false;
    save_meta(app, &meta)?;

    Ok(CachedToken {
        access_token,
        expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
    })
}

/// Accept connections on the loopback listener until one carries the OAuth
/// `code` (or an `error`), ignoring incidental requests (e.g. favicon). Returns
/// `(code, state)`.
fn wait_for_callback(
    listener: &TcpListener,
    timeout: Duration,
) -> Result<(String, String), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return Err("Timed out waiting for Jira authorization. Please try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                // Accepted sockets don't reliably inherit non-blocking mode
                // across platforms — force blocking + a read timeout.
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("");

                if let Some(query) = target.split('?').nth(1) {
                    let params = parse_query(query);
                    if let Some(err) = params.get("error") {
                        let desc = params.get("error_description").cloned().unwrap_or_default();
                        let _ = respond(&mut stream, "Authorization failed. You can close this tab.");
                        return Err(format!("Jira denied authorization: {err} {desc}")
                            .trim()
                            .to_string());
                    }
                    if let (Some(code), Some(state)) = (params.get("code"), params.get("state")) {
                        let _ = respond(
                            &mut stream,
                            "Meridian is now connected to Jira. You can close this tab and return to the app.",
                        );
                        return Ok((code.clone(), state.clone()));
                    }
                }
                // Not the callback we want; acknowledge and keep waiting.
                let _ = respond(&mut stream, "Waiting for Jira authorization…");
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn respond(stream: &mut TcpStream, message: &str) -> std::io::Result<()> {
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <title>Meridian · Jira</title><style>\
         body{{font-family:system-ui,-apple-system,sans-serif;background:#1c1c1c;\
         color:#e6e6e6;display:flex;min-height:100vh;align-items:center;\
         justify-content:center;margin:0}}p{{max-width:30rem;text-align:center;\
         line-height:1.5;font-size:15px}}</style></head>\
         <body><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes())
}

// --- Token exchange / refresh / API calls -------------------------------------

fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": callback_url(),
    });
    post_json("https://auth.atlassian.com/oauth/token", &body)
}

/// Return a valid access token, reusing the cached one when fresh and otherwise
/// refreshing it (persisting the rotated refresh token). Flags `needs_reconnect`
/// in metadata when the refresh token itself is rejected.
fn ensure_token(app: &AppHandle, cached: Option<CachedToken>) -> Result<CachedToken, String> {
    if let Some(token) = cached {
        if token.expires_at > Instant::now() {
            return Ok(token);
        }
    }

    let meta = load_meta(app);
    let (client_id, client_secret) =
        built_in_app().ok_or("Jira isn't configured in this build of Meridian.")?;
    let refresh = load_refresh().ok_or("Not connected to Jira.")?;

    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh,
    });

    match post_json("https://auth.atlassian.com/oauth/token", &body) {
        Ok(json) => {
            let access_token = json
                .get("access_token")
                .and_then(|v| v.as_str())
                .ok_or("Refresh response contained no access_token.")?
                .to_string();
            let expires_in = json
                .get("expires_in")
                .and_then(|v| v.as_u64())
                .unwrap_or(3600);
            // Atlassian rotates refresh tokens — store the new one.
            if let Some(new_refresh) = json.get("refresh_token").and_then(|v| v.as_str()) {
                let _ = store_refresh(new_refresh);
            }
            if meta.needs_reconnect {
                let mut m = load_meta(app);
                m.needs_reconnect = false;
                let _ = save_meta(app, &m);
            }
            Ok(CachedToken {
                access_token,
                expires_at: Instant::now() + Duration::from_secs(expires_in.saturating_sub(60)),
            })
        }
        Err(e) => {
            // An expired/revoked refresh token shows up as invalid_grant (400).
            if e.contains("invalid_grant") || e.contains("HTTP 400") || e.contains("HTTP 403") {
                let mut m = load_meta(app);
                m.needs_reconnect = true;
                let _ = save_meta(app, &m);
                Err("Your Jira authorization has expired. Reconnect in Settings → Connections."
                    .into())
            } else {
                Err(e)
            }
        }
    }
}

fn post_json(url: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    match ureq::post(url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body.to_string())
    {
        Ok(resp) => resp
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(format!("HTTP {code}: {text}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn get_json(url: &str, access_token: &str) -> Result<serde_json::Value, String> {
    match ureq::get(url)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Accept", "application/json")
        .call()
    {
        Ok(resp) => resp
            .into_string()
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())),
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(format!("HTTP {code}: {text}"))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// First Jira site this app can access: `(cloud_id, site_url)`.
fn first_accessible_site(access_token: &str) -> Result<(String, String), String> {
    let value = get_json(
        "https://api.atlassian.com/oauth/token/accessible-resources",
        access_token,
    )?;
    let sites = value
        .as_array()
        .ok_or("Unexpected response from Atlassian (accessible-resources).")?;
    let site = sites
        .first()
        .ok_or("This Atlassian account has no Jira sites accessible to the app.")?;
    let cloud_id = site
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("No cloud id in the accessible-resources response.")?
        .to_string();
    let site_url = site
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok((cloud_id, site_url))
}

fn fetch_account_name(access_token: &str, cloud_id: &str) -> Option<String> {
    let url = format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/myself");
    let value = get_json(&url, access_token).ok()?;
    value
        .get("displayName")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

// --- Resolve an issue key to a branch name ------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraBranch {
    key: String,
    summary: String,
    branch: String,
}

#[tauri::command]
pub async fn jira_resolve_branch(
    app: AppHandle,
    state: State<'_, JiraState>,
    issue_key: String,
) -> Result<JiraBranch, String> {
    let key = normalize_key(&issue_key).ok_or("That doesn't look like a Jira issue key.")?;
    // Snapshot the cached token; State isn't Send, so it can't cross the
    // spawn_blocking boundary — we re-store the (possibly refreshed) token after.
    let cached = state.token.lock().ok().and_then(|g| g.clone());

    let app2 = app.clone();
    let key2 = key.clone();
    let (token, summary) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(CachedToken, String), String> {
            let token = ensure_token(&app2, cached)?;
            let meta = load_meta(&app2);
            if meta.cloud_id.is_empty() {
                return Err("Not connected to Jira.".into());
            }
            let url = format!(
                "https://api.atlassian.com/ex/jira/{}/rest/api/3/issue/{}?fields=summary",
                meta.cloud_id, key2
            );
            let value = get_json(&url, &token.access_token).map_err(|e| issue_error(&e, &key2))?;
            let summary = value
                .get("fields")
                .and_then(|f| f.get("summary"))
                .and_then(|s| s.as_str())
                .unwrap_or_default()
                .to_string();
            Ok((token, summary))
        },
    )
    .await
    .map_err(|e| e.to_string())??;

    if let Ok(mut guard) = state.token.lock() {
        *guard = Some(token);
    }
    let branch = build_branch_name(&key, &summary);
    Ok(JiraBranch { key, summary, branch })
}

/// Map a raw HTTP error from the issue lookup to something a user can act on.
fn issue_error(raw: &str, key: &str) -> String {
    if raw.contains("HTTP 404") {
        format!("Issue {key} wasn't found in Jira.")
    } else if raw.contains("HTTP 401") || raw.contains("HTTP 403") {
        "Jira rejected the request. Try reconnecting in Settings → Connections.".into()
    } else {
        raw.to_string()
    }
}

/// Validate + normalize a Jira issue key (`abc-12` → `ABC-12`). Project keys are
/// 2–10 chars, start with a letter, and are alphanumeric; the number follows a
/// dash. Returns None when the input isn't a plausible key.
fn normalize_key(input: &str) -> Option<String> {
    let s = input.trim();
    let (project, number) = s.rsplit_once('-')?;
    if project.len() < 2 || project.len() > 10 {
        return None;
    }
    let mut chars = project.chars();
    if !chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    if !project.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}-{}", project.to_ascii_uppercase(), number))
}

/// Longest branch name we'll emit. Matches git's 255-byte ref limit; it's high
/// enough that realistic Jira summaries pass through untouched (Jira keeps the
/// full slugified summary too), and only pathological titles get trimmed.
const MAX_BRANCH_LEN: usize = 255;

/// Build `KEY-lowercase-summary-with-dashes`, matching Jira's branch naming.
/// Runs of non-alphanumerics collapse to a single dash and the summary is kept
/// in full; only an over-long result is trimmed, and then at a dash boundary so
/// it never ends mid-word. Falls back to the bare key for an empty summary.
fn build_branch_name(key: &str, summary: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in summary.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        return key.to_string();
    }

    let full = format!("{key}-{slug}");
    if full.len() <= MAX_BRANCH_LEN {
        return full;
    }
    // Too long: trim the slug to fit, cutting back to the last dash so we don't
    // leave a half-word. (slug is ASCII, so byte slicing is safe.)
    let budget = MAX_BRANCH_LEN.saturating_sub(key.len() + 1);
    let mut trimmed = &slug[..budget.min(slug.len())];
    if let Some(i) = trimmed.rfind('-') {
        trimmed = &trimmed[..i];
    }
    let trimmed = trimmed.trim_matches('-');
    if trimmed.is_empty() {
        key.to_string()
    } else {
        format!("{key}-{trimmed}")
    }
}

// --- Open a URL in the system browser -----------------------------------------

/// Open `url` in the default browser via the OS shell-open handler (the opener
/// plugin → ShellExecute on Windows / `open` on macOS / `xdg-open` on Linux).
/// Used by the OAuth flow and external links. This is the reliable path:
/// hand-rolled `cmd /C start` truncates URLs at `&`, and `explorer.exe` can
/// open a folder instead of the browser.
pub fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Refusing to open a non-http(s) URL.".into());
    }
    open_url(&app, &url)
}

// --- Small URL/string utilities -----------------------------------------------

/// A weak CSRF nonce for the loopback flow — the real protection is binding to
/// 127.0.0.1, but pairing the request to a per-attempt value is cheap.
fn gen_state() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}{:x}", std::process::id())
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let key = it.next()?;
            if key.is_empty() {
                return None;
            }
            let value = it.next().unwrap_or("");
            Some((urldecode(key), urldecode(value)))
        })
        .collect()
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                match (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push(h * 16 + l);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
