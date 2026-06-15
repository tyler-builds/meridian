fn main() {
    inject_jira_credentials();
    tauri_build::build()
}

/// Bake Meridian's own Jira OAuth app credentials (from `src-tauri/.env`, which
/// is gitignored) into the binary as compile-time env vars, so end users
/// connect with one click and never handle a client id/secret. A build without
/// `.env` (or with blank values) ships with Jira unconfigured.
fn inject_jira_credentials() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let env_path = std::path::Path::new(&manifest).join(".env");
    // Re-run when the file appears/changes so edited credentials take effect.
    println!("cargo:rerun-if-changed={}", env_path.display());

    let Ok(contents) = std::fs::read_to_string(&env_path) else {
        return;
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key == "MERIDIAN_JIRA_CLIENT_ID" || key == "MERIDIAN_JIRA_CLIENT_SECRET" {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            println!("cargo:rustc-env={key}={value}");
        }
    }
}
