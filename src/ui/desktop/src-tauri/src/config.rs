// Desktop config persistence. Mirrors src/env.js getUserHome():
//   CANVAS_USER_HOME override → else ~/.canvas (unix) / ~/Canvas (windows).
// Config lives at <userHome>/config/desktop.json.
use std::fs;
use std::path::PathBuf;

fn user_home() -> PathBuf {
    if let Ok(env_home) = std::env::var("CANVAS_USER_HOME") {
        if !env_home.is_empty() {
            return PathBuf::from(env_home);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    if cfg!(target_os = "windows") {
        home.join("Canvas")
    } else {
        home.join(".canvas")
    }
}

fn config_file() -> PathBuf {
    user_home().join("config").join("desktop.json")
}

#[tauri::command]
pub fn config_path() -> String {
    config_file().to_string_lossy().to_string()
}

#[tauri::command]
pub fn load_config() -> serde_json::Value {
    match fs::read_to_string(config_file()) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

#[tauri::command]
pub fn save_config(config: serde_json::Value) -> Result<(), String> {
    let path = config_file();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}
