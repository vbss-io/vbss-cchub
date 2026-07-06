use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent,
};

struct Sidecar(Mutex<Option<Child>>);

fn spawn_sidecar(app: &tauri::App) -> Option<Child> {
    let resource_dir = app.path().resource_dir().ok()?;
    // Tauri returns an extended-length (\\?\) path on Windows; Node/better-sqlite3 cannot
    // resolve it (fs.lstat fails), so strip the verbatim prefix before spawning.
    let resource_dir = {
        let s = resource_dir.to_string_lossy();
        std::path::PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
    };
    let sidecar = resource_dir.join("sidecar");
    let node = sidecar.join("node.exe");
    let server = sidecar.join("server.cjs");
    if !node.exists() || !server.exists() {
        return None;
    }
    let mut cmd = Command::new(&node);
    cmd.arg(&server)
        .env("HUB_RESOURCE_DIR", &sidecar)
        .env("HUB_PARENT_PID", std::process::id().to_string());
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let dir = std::path::PathBuf::from(profile).join(".vbss-cchub");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(log) = std::fs::File::create(dir.join("server.log")) {
            if let Ok(log2) = log.try_clone() {
                cmd.stdout(log).stderr(log2);
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().ok()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let child = spawn_sidecar(app);
            app.manage(Sidecar(Mutex::new(child)));

            let open_item = MenuItem::with_id(app, "open", "Open Hub", true, None::<&str>)?;
            let widget_item =
                MenuItem::with_id(app, "widget", "Show/hide widget", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &widget_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("VBSS CCHUB")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "widget" => {
                        if let Some(window) = app.get_webview_window("widget") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting VBSS CCHUB")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
