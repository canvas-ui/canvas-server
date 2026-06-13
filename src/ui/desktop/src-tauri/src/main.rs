// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF renderer is broken on the NVIDIA proprietary driver and
    // falls back to slow software compositing (~8fps scroll). Must be set before
    // WebKit initializes. https://github.com/tauri-apps/tauri/issues/9304
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    desktop_lib::run()
}
