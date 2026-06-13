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

// Merge a partial patch into the existing config. Callers (React state +
// window-bounds persistence) write disjoint keys, so a shallow merge keeps
// them from clobbering each other. A null value deletes the key.
#[tauri::command]
pub fn save_config(config: serde_json::Value) -> Result<(), String> {
    let path = config_file();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut current = load_config();
    match (current.as_object_mut(), config.as_object()) {
        (Some(cur), Some(patch)) => {
            for (k, v) in patch {
                if v.is_null() {
                    cur.remove(k);
                } else {
                    cur.insert(k.clone(), v.clone());
                }
            }
        }
        _ => current = config,
    }
    let json = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}
