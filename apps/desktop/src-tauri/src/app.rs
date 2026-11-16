use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent,
};

use crate::{resolve_config_from, supervise, SidecarConfig, Supervisor};

fn resolve_config(handle: &tauri::AppHandle) -> Option<SidecarConfig> {
    let resource_dir: PathBuf = handle.path().resource_dir().ok()?;
    resolve_config_from(&resource_dir, std::env::current_exe())
}

#[tauri::command]
fn restart_sidecar(supervisor: tauri::State<'_, Arc<Supervisor>>) -> Result<(), String> {
    supervisor.restart()
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
        .invoke_handler(tauri::generate_handler![restart_sidecar])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let supervisor = Arc::new(Supervisor::new(resolve_config(app.handle())));
            supervisor.begin();
            supervise(Arc::clone(&supervisor));
            app.manage(supervisor);

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
                                let _ = app.emit("widget:shown", ());
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
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(supervisor) = app_handle.try_state::<Arc<Supervisor>>() {
                    supervisor.shutdown();
                }
            }
        });
}
