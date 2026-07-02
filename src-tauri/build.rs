fn main() {
    inject_jira_credentials();
    // Re-embed the Windows .exe icon whenever the app icon changes. Cargo does
    // not rebuild on icon-only changes otherwise, so `tauri dev` keeps running a
    // stale binary with the old taskbar icon after the icons are regenerated.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}

/// Bake Meridian's own Jira OAuth app credentials into the binary as
/// compile-time env vars, so end users connect with one click and never handle
/// a client id/secret. Values come from `src-tauri/.env` (gitignored, local
/// dev) or, when a key is absent there, from the process environment (CI
/// passes them as GitHub Actions secrets — see release.yml). A build with
/// neither ships with Jira unconfigured.
fn inject_jira_credentials() {
    const KEYS: [&str; 2] = ["MERIDIAN_JIRA_CLIENT_ID", "MERIDIAN_JIRA_CLIENT_SECRET"];

    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let env_path = std::path::Path::new(&manifest).join(".env");
    // Re-run when the file or the ambient values change so edited credentials
    // take effect (and so a cached CI target dir rebuilds once secrets exist).
    println!("cargo:rerun-if-changed={}", env_path.display());
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let mut from_file = std::collections::HashMap::new();
    if let Ok(contents) = std::fs::read_to_string(&env_path) {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if KEYS.contains(&key) {
                let value = value.trim().trim_matches('"').trim_matches('\'');
                from_file.insert(key.to_string(), value.to_string());
            }
        }
    }

    for key in KEYS {
        let value = from_file
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .unwrap_or_default();
        if !value.is_empty() {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}
