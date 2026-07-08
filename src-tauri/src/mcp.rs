//! In-process MCP server exposing Meridian's embedded browser tabs to the in-app
//! `claude` CLI — the backend of the `@browser` feature.
//!
//! Why in-process: the browser tabs are native child webviews owned by this
//! Rust process (see the `browser_*` commands in `lib.rs`). A stdio MCP server
//! spawned by `claude` would have no handle to them; an HTTP server hosted here
//! does. So we bind a localhost port and speak MCP's streamable-HTTP transport,
//! and `claude` is launched with `--mcp-config` pointing at it.
//!
//! Security: the port is bound to `127.0.0.1` only and every request must carry a
//! per-install bearer secret (handed to `claude` via the generated config). This
//! matters because browser tools are auto-allowed per project — so the secret,
//! not a per-call permission prompt, is what stops another local process from
//! driving the user's logged-in browser. Each Claude session is further scoped to
//! one project's tabs via the `root` query parameter baked into its config URL.
//!
//! Transport: we implement the minimal valid streamable-HTTP server — a POST of a
//! JSON-RPC message answered with a single `application/json` JSON-RPC response.
//! We don't offer the optional server→client SSE stream (GET returns 405), which
//! a spec-compliant client tolerates.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Url};

use crate::{
    browser_do_history, browser_do_navigate, browser_do_reload, browser_eval_with_result,
    browser_screenshot_png, browser_tab_in_root, browser_tabs_for_root,
};

/// The MCP server's listening port and bearer secret, managed in Tauri state so
/// `claude_browser_mcp_config` can mint configs that point at it.
pub struct McpState {
    pub port: u16,
    pub secret: String,
}

/// MCP protocol version we default to when the client doesn't request one.
const DEFAULT_PROTOCOL: &str = "2025-06-18";
/// Cap on page text/HTML returned to the model, so a huge page can't blow past
/// MCP output limits. Mirrored in the `read_tab` tool's `maxResultSizeChars`.
const MAX_CONTENT_CHARS: usize = 200_000;
/// How long a single page evaluation may take before we give up.
const EVAL_TIMEOUT_MS: u64 = 8_000;

// --- Endpoint persistence ---
//
// The port and secret are persisted so they're stable across restarts: a Claude
// tab restored from saved state re-runs its `claude --mcp-config <file>` command,
// and that file points at this endpoint. A stable port keeps the restored config
// valid without a race to rewrite it before `claude` reads it.

fn endpoint_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("mcp-endpoint.json"))
}

/// 32 hex chars from the OS CSPRNG (falls back to a time-seeded value if the
/// CSPRNG is somehow unavailable — still better than a fixed secret).
fn random_secret() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes.copy_from_slice(&(nanos as u128).to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read the persisted (port, secret), or mint a fresh secret with port 0 (=ask
/// the OS for any free port) on first run.
fn load_endpoint(app: &AppHandle) -> (u16, String) {
    if let Some(path) = endpoint_file(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                let port = v.get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
                if let Some(secret) = v.get("secret").and_then(Value::as_str) {
                    if !secret.is_empty() {
                        return (port, secret.to_string());
                    }
                }
            }
        }
    }
    (0, random_secret())
}

fn save_endpoint(app: &AppHandle, port: u16, secret: &str) {
    if let Some(path) = endpoint_file(app) {
        let _ = std::fs::write(&path, json!({ "port": port, "secret": secret }).to_string());
    }
}

/// Start the MCP server: bind localhost (reusing the persisted port when free),
/// spawn the accept loop, and return the live endpoint. Returns `None` if no port
/// could be bound (the feature then simply stays off — config generation errors).
pub fn start(app: AppHandle) -> Option<McpState> {
    let (preferred, secret) = load_endpoint(&app);

    // Reuse the persisted port when it's free; otherwise let the OS pick one.
    let server = if preferred != 0 {
        tiny_http::Server::http(("127.0.0.1", preferred))
            .or_else(|_| tiny_http::Server::http(("127.0.0.1", 0)))
            .ok()?
    } else {
        tiny_http::Server::http(("127.0.0.1", 0)).ok()?
    };

    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(preferred);
    save_endpoint(&app, port, &secret);
    log::info!("MCP browser server listening on 127.0.0.1:{port}");

    let app_thread = app.clone();
    let secret_thread = secret.clone();
    std::thread::spawn(move || loop {
        match server.recv() {
            Ok(request) => {
                let app_req = app_thread.clone();
                let secret_req = secret_thread.clone();
                // One thread per request so a slow page evaluation can't stall
                // the next request. Volume is tiny (one local Claude).
                std::thread::spawn(move || handle_request(app_req, &secret_req, request));
            }
            Err(e) => {
                log::warn!("MCP server recv error, stopping: {e}");
                break;
            }
        }
    });

    Some(McpState { port, secret })
}

// --- HTTP request handling ---

fn header_value(request: &tiny_http::Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

/// Parse `?root=...&eval=1` from the request line. `root` scopes which tabs this
/// Claude session sees; `eval` enables the `eval_js` tool.
fn parse_query(url: &str) -> (Option<String>, bool) {
    // tiny_http gives a path+query (e.g. "/mcp?root=..."); give Url a dummy base.
    let Ok(parsed) = Url::parse(&format!("http://localhost{url}")) else {
        return (None, false);
    };
    let mut root = None;
    let mut eval = false;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "root" => root = Some(v.into_owned()),
            "eval" => eval = v == "1" || v == "true",
            _ => {}
        }
    }
    (root, eval)
}

fn respond_json(request: tiny_http::Request, status: u16, body: String) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header");
    let response = tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(header);
    let _ = request.respond(response);
}

fn respond_empty(request: tiny_http::Request, status: u16) {
    let _ = request.respond(tiny_http::Response::from_string("").with_status_code(status));
}

fn handle_request(app: AppHandle, secret: &str, mut request: tiny_http::Request) {
    // Only POST is supported (both the JSON-RPC endpoint and the /attention hook
    // callback POST); we don't offer the optional server→client SSE stream, so
    // GET (and everything else) is 405.
    if request.method() != &tiny_http::Method::Post {
        respond_empty(request, 405);
        return;
    }

    // Bearer-secret gate, shared by the MCP endpoint and the /attention callback.
    // The secret is the security boundary (browser tools are auto-allowed, and
    // /attention drives system notifications), so reject anything without the
    // exact token before doing any work.
    let authorized = header_value(&request, "Authorization")
        .map(|v| v.trim() == format!("Bearer {secret}"))
        .unwrap_or(false);
    if !authorized {
        respond_empty(request, 401);
        return;
    }

    // Route on the path (tiny_http gives path+query, e.g. "/attention?tab=..").
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("");

    // Claude Code hook callback: a Stop/Notification hook registered by
    // `claude_hooks_config` (see lib.rs) POSTs here so the app can flag the tab's
    // attention dot and, when the window is unfocused, raise a notification.
    if path == "/attention" {
        handle_attention(&app, &url);
        respond_empty(request, 204);
        return;
    }

    // --- MCP endpoint (the @browser feature) ---
    let (root, eval_enabled) = parse_query(request.url());
    let Some(root) = root else {
        respond_json(
            request,
            400,
            json!({ "error": "missing project root in MCP endpoint URL" }).to_string(),
        );
        return;
    };

    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        respond_empty(request, 400);
        return;
    }

    let Ok(parsed) = serde_json::from_str::<Value>(&body) else {
        respond_json(
            request,
            400,
            json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": { "code": -32700, "message": "parse error" }
            })
            .to_string(),
        );
        return;
    };

    // A JSON-RPC message may be a single object or a batch array.
    let out = match parsed {
        Value::Array(items) => {
            let responses: Vec<Value> = items
                .into_iter()
                .filter_map(|m| handle_rpc(&app, &root, eval_enabled, m))
                .collect();
            if responses.is_empty() {
                // All notifications — nothing to return.
                respond_empty(request, 202);
                return;
            }
            Value::Array(responses)
        }
        single => match handle_rpc(&app, &root, eval_enabled, single) {
            Some(resp) => resp,
            None => {
                respond_empty(request, 202);
                return;
            }
        },
    };

    respond_json(request, 200, out.to_string());
}

/// Handle a Claude Code hook callback carrying `?tab=<content id>&event=<name>`
/// (event is `stop` or `notification`). Emits `claude://attention` so the
/// frontend can flag the tab and decide whether to raise a system notification.
/// Best-effort: a malformed URL or missing tab id is silently ignored (the hook
/// is a side-effect channel — nothing depends on its response).
fn handle_attention(app: &AppHandle, url: &str) {
    let Ok(parsed) = Url::parse(&format!("http://localhost{url}")) else {
        return;
    };
    let mut tab = None;
    let mut event = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "tab" => tab = Some(v.into_owned()),
            "event" => event = Some(v.into_owned()),
            _ => {}
        }
    }
    let Some(tab) = tab else { return };
    let event = event.unwrap_or_else(|| "stop".to_string());
    let _ = app.emit("claude://attention", json!({ "tab": tab, "event": event }));
}

// --- JSON-RPC dispatch ---

fn ok_result(id: Value, result: Value) -> Option<Value> {
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn rpc_error(id: Value, code: i64, message: &str) -> Option<Value> {
    Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    }))
}

/// Handle one JSON-RPC message. Returns `Some(response)` for a request, or `None`
/// for a notification (no `id`) — the caller answers those with `202 Accepted`.
fn handle_rpc(app: &AppHandle, root: &str, eval_enabled: bool, msg: Value) -> Option<Value> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    // No id → notification: act if relevant, never respond.
    let Some(id) = id else {
        return None;
    };

    match method {
        "initialize" => {
            let protocol = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL)
                .to_string();
            ok_result(
                id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": { "tools": {}, "resources": {} },
                    "serverInfo": { "name": "meridian-browser", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
        }
        "ping" => ok_result(id, json!({})),
        "tools/list" => ok_result(id, json!({ "tools": tool_defs(eval_enabled) })),
        "tools/call" => match call_tool(app, root, eval_enabled, &params) {
            Ok(content) => ok_result(id, json!({ "content": content, "isError": false })),
            // Tool errors are reported as a result with isError, not a protocol
            // error, so the model can read and react to them.
            Err(e) => ok_result(
                id,
                json!({ "content": [text_content(&e)], "isError": true }),
            ),
        },
        "resources/list" => ok_result(id, json!({ "resources": resource_list(app, root) })),
        "resources/templates/list" => ok_result(id, json!({ "resourceTemplates": [] })),
        "resources/read" => match read_resource(app, root, &params) {
            Ok(contents) => ok_result(id, json!({ "contents": contents })),
            Err(e) => rpc_error(id, -32602, &e),
        },
        _ => rpc_error(id, -32601, "method not found"),
    }
}

// --- Tools ---

fn text_content(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

/// The advertised tool set. `eval_js` is included only when the session enabled
/// it (the per-project Settings opt-in), so it's invisible otherwise.
fn tool_defs(eval_enabled: bool) -> Vec<Value> {
    let optional = json!({ "type": "string", "description": "Tab id from list_tabs; omit to target the active tab." });
    let mut tools = vec![
        json!({
            "name": "list_tabs",
            "description": "List the embedded browser tabs open in this project (id, title, URL, and which is active).",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "read_tab",
            "description": "Read a browser tab's current page. mode 'text' (default) returns visible text; 'html' returns the full DOM HTML.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tab_id": optional,
                    "mode": { "type": "string", "enum": ["text", "html"], "description": "text (default) or html" }
                },
                "additionalProperties": false
            },
            "_meta": { "anthropic/maxResultSizeChars": MAX_CONTENT_CHARS }
        }),
        json!({
            "name": "navigate",
            "description": "Navigate a browser tab to a URL.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": optional, "url": { "type": "string", "description": "Absolute URL to load." } },
                "required": ["url"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "reload",
            "description": "Reload a browser tab.",
            "inputSchema": { "type": "object", "properties": { "tab_id": optional }, "additionalProperties": false }
        }),
        json!({
            "name": "back",
            "description": "Go back in a browser tab's history.",
            "inputSchema": { "type": "object", "properties": { "tab_id": optional }, "additionalProperties": false }
        }),
        json!({
            "name": "forward",
            "description": "Go forward in a browser tab's history.",
            "inputSchema": { "type": "object", "properties": { "tab_id": optional }, "additionalProperties": false }
        }),
        json!({
            "name": "click",
            "description": "Click the first element matching a CSS selector in a browser tab. Returns whether an element was found.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": optional, "selector": { "type": "string", "description": "CSS selector." } },
                "required": ["selector"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "wait_for_load",
            "description": "Wait until a browser tab's document.readyState is 'complete' (or timeout).",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": optional, "timeout_ms": { "type": "integer", "description": "Default 10000." } },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "screenshot_tab",
            "description": "Capture a PNG screenshot of a browser tab's current viewport.",
            "inputSchema": { "type": "object", "properties": { "tab_id": optional }, "additionalProperties": false }
        }),
    ];
    if eval_enabled {
        tools.push(json!({
            "name": "eval_js",
            "description": "Evaluate JavaScript in a browser tab's top frame and return the last expression's value (JSON). Powerful — can read page secrets; enabled per project in Settings.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": optional, "code": { "type": "string", "description": "JavaScript to evaluate." } },
                "required": ["code"],
                "additionalProperties": false
            },
            "_meta": { "anthropic/maxResultSizeChars": MAX_CONTENT_CHARS }
        }));
    }
    tools
}

/// Resolve which tab a call targets: an explicit `tab_id` (validated to belong to
/// this project), else the active tab, else the only tab — erroring if ambiguous.
fn resolve_tab(app: &AppHandle, root: &str, args: &Value) -> Result<String, String> {
    let tabs = browser_tabs_for_root(app, root);
    if tabs.is_empty() {
        return Err("no browser tabs are open in this project".to_string());
    }
    match args.get("tab_id").and_then(Value::as_str) {
        Some(id) => {
            if browser_tab_in_root(app, id, root) {
                Ok(id.to_string())
            } else {
                Err(format!("no browser tab '{id}' in this project (see list_tabs)"))
            }
        }
        None => {
            if let Some(active) = tabs.iter().find(|t| t.active) {
                Ok(active.id.clone())
            } else if tabs.len() == 1 {
                Ok(tabs[0].id.clone())
            } else {
                Err("multiple tabs open — pass tab_id (see list_tabs)".to_string())
            }
        }
    }
}

/// Unquote WebView2's JSON-string result (e.g. `"\"hello\""` → `hello`); if it
/// isn't a JSON string, return it verbatim.
fn unquote_json(raw: &str) -> String {
    serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string())
}

fn truncate_chars(s: String) -> (String, bool) {
    if s.chars().count() > MAX_CONTENT_CHARS {
        (s.chars().take(MAX_CONTENT_CHARS).collect(), true)
    } else {
        (s, false)
    }
}

fn call_tool(
    app: &AppHandle,
    root: &str,
    eval_enabled: bool,
    params: &Value,
) -> Result<Vec<Value>, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("missing tool name")?;
    let args = params.get("arguments").cloned().unwrap_or(json!({}));

    match name {
        "list_tabs" => {
            let mut tabs = browser_tabs_for_root(app, root);
            tabs.sort_by(|a, b| a.id.cmp(&b.id));
            let list: Vec<Value> = tabs
                .iter()
                .map(|t| json!({ "id": t.id, "title": t.title, "url": t.url, "active": t.active }))
                .collect();
            Ok(vec![text_content(
                &serde_json::to_string_pretty(&json!({ "tabs": list })).unwrap_or_default(),
            )])
        }
        "read_tab" => {
            let id = resolve_tab(app, root, &args)?;
            let mode = args.get("mode").and_then(Value::as_str).unwrap_or("text");
            let script = if mode == "html" {
                "(function(){try{return document.documentElement.outerHTML}catch(e){return ''}})()"
            } else {
                "(function(){try{return document.body?document.body.innerText:''}catch(e){return ''}})()"
            };
            let raw = browser_eval_with_result(app, &id, script, EVAL_TIMEOUT_MS)?;
            let (text, truncated) = truncate_chars(unquote_json(&raw));
            let text = if truncated {
                format!("{text}\n\n[truncated to {MAX_CONTENT_CHARS} characters]")
            } else {
                text
            };
            Ok(vec![text_content(&text)])
        }
        "navigate" => {
            let id = resolve_tab(app, root, &args)?;
            let url = args
                .get("url")
                .and_then(Value::as_str)
                .ok_or("missing 'url'")?;
            browser_do_navigate(app, &id, url)?;
            Ok(vec![text_content(&format!("navigating tab {id} to {url}"))])
        }
        "reload" => {
            let id = resolve_tab(app, root, &args)?;
            browser_do_reload(app, &id)?;
            Ok(vec![text_content(&format!("reloaded tab {id}"))])
        }
        "back" => {
            let id = resolve_tab(app, root, &args)?;
            browser_do_history(app, &id, false)?;
            Ok(vec![text_content(&format!("tab {id} went back"))])
        }
        "forward" => {
            let id = resolve_tab(app, root, &args)?;
            browser_do_history(app, &id, true)?;
            Ok(vec![text_content(&format!("tab {id} went forward"))])
        }
        "click" => {
            let id = resolve_tab(app, root, &args)?;
            let selector = args
                .get("selector")
                .and_then(Value::as_str)
                .ok_or("missing 'selector'")?;
            // JSON-encode the selector so it's a safe JS string literal.
            let sel = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
            let script = format!(
                "(function(){{try{{var el=document.querySelector({sel});if(!el)return false;el.click();return true;}}catch(e){{return false}}}})()"
            );
            let raw = browser_eval_with_result(app, &id, &script, EVAL_TIMEOUT_MS)?;
            let found = raw.trim() == "true";
            Ok(vec![text_content(if found {
                "clicked"
            } else {
                "no element matched that selector"
            })])
        }
        "wait_for_load" => {
            let id = resolve_tab(app, root, &args)?;
            let timeout = args
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(10_000)
                .min(60_000);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
            loop {
                let raw =
                    browser_eval_with_result(app, &id, "document.readyState", 2_000).unwrap_or_default();
                if unquote_json(&raw) == "complete" {
                    return Ok(vec![text_content("page loaded")]);
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(vec![text_content("timed out waiting for load")]);
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
        "screenshot_tab" => {
            let id = resolve_tab(app, root, &args)?;
            let png = browser_screenshot_png(app, &id, EVAL_TIMEOUT_MS)?;
            use base64::Engine;
            let data = base64::engine::general_purpose::STANDARD.encode(&png);
            Ok(vec![json!({ "type": "image", "data": data, "mimeType": "image/png" })])
        }
        "eval_js" => {
            if !eval_enabled {
                return Err("eval_js is disabled (enable it per project in Meridian Settings)".to_string());
            }
            let id = resolve_tab(app, root, &args)?;
            let code = args
                .get("code")
                .and_then(Value::as_str)
                .ok_or("missing 'code'")?;
            let raw = browser_eval_with_result(app, &id, code, EVAL_TIMEOUT_MS)?;
            let (text, _) = truncate_chars(raw);
            Ok(vec![text_content(&text)])
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

// --- Resources (back the `@browser` mention) ---

fn resource_list(app: &AppHandle, root: &str) -> Vec<Value> {
    let mut tabs = browser_tabs_for_root(app, root);
    tabs.sort_by(|a, b| a.id.cmp(&b.id));
    let mut out: Vec<Value> = vec![json!({
        "uri": "browser://tabs",
        "name": "Open browser tabs",
        "description": "Summary list of this project's embedded browser tabs.",
        "mimeType": "application/json"
    })];
    for t in &tabs {
        let name = if t.title.is_empty() { t.url.clone() } else { t.title.clone() };
        out.push(json!({
            "uri": format!("browser://tab/{}", t.id),
            "name": name,
            "description": t.url,
            "mimeType": "text/plain"
        }));
    }
    out
}

fn read_resource(app: &AppHandle, root: &str, params: &Value) -> Result<Vec<Value>, String> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .ok_or("missing 'uri'")?;

    if uri == "browser://tabs" {
        let mut tabs = browser_tabs_for_root(app, root);
        tabs.sort_by(|a, b| a.id.cmp(&b.id));
        let list: Vec<Value> = tabs
            .iter()
            .map(|t| json!({ "id": t.id, "title": t.title, "url": t.url, "active": t.active }))
            .collect();
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string_pretty(&json!({ "tabs": list })).unwrap_or_default()
        })]);
    }

    if let Some(id) = uri.strip_prefix("browser://tab/") {
        if !browser_tab_in_root(app, id, root) {
            return Err(format!("no browser tab '{id}' in this project"));
        }
        let raw = browser_eval_with_result(
            app,
            id,
            "(function(){try{return document.body?document.body.innerText:''}catch(e){return ''}})()",
            EVAL_TIMEOUT_MS,
        )?;
        let (text, _) = truncate_chars(unquote_json(&raw));
        return Ok(vec![json!({ "uri": uri, "mimeType": "text/plain", "text": text })]);
    }

    Err(format!("unknown resource '{uri}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_root_and_eval_from_query() {
        // Windows root with drive letter + backslashes, percent-encoded.
        let (root, eval) = parse_query("/mcp?root=C%3A%5CUsers%5Cme%5Cproj&eval=1");
        assert_eq!(root.as_deref(), Some(r"C:\Users\me\proj"));
        assert!(eval);
    }

    #[test]
    fn eval_defaults_off_and_root_optional() {
        let (root, eval) = parse_query("/mcp?root=%2Fhome%2Fme");
        assert_eq!(root.as_deref(), Some("/home/me"));
        assert!(!eval);

        let (root, eval) = parse_query("/mcp");
        assert!(root.is_none());
        assert!(!eval);
    }

    #[test]
    fn unquotes_webview2_json_strings() {
        // WebView2 returns the result JSON-encoded; a string value is quoted.
        assert_eq!(unquote_json("\"complete\""), "complete");
        assert_eq!(unquote_json("\"line one\\nline two\""), "line one\nline two");
        // Non-string JSON (booleans, etc.) comes back verbatim.
        assert_eq!(unquote_json("true"), "true");
        assert_eq!(unquote_json("null"), "null");
    }

    #[test]
    fn eval_js_tool_is_gated() {
        let names = |eval| {
            tool_defs(eval)
                .into_iter()
                .filter_map(|t| t.get("name").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        };
        assert!(!names(false).iter().any(|n| n == "eval_js"));
        assert!(names(true).iter().any(|n| n == "eval_js"));
        // Read-only + interaction tools are always present.
        assert!(names(false).iter().any(|n| n == "list_tabs"));
        assert!(names(false).iter().any(|n| n == "screenshot_tab"));
    }
}
