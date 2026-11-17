use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent,
};

use crate::{
    hides_on_close, resolve_config_from, supervise, tray_action, widget_toggle, SidecarConfig,
    Supervisor, TrayAction, WidgetToggle, MAIN_WINDOW, TRAY_OPEN, TRAY_QUIT, TRAY_WIDGET,
    WIDGET_SHOWN_EVENT, WIDGET_WINDOW,
};

fn resolve_config(handle: &tauri::AppHandle) -> Option<SidecarConfig> {
    let resource_dir: PathBuf = handle.path().resource_dir().ok()?;
    resolve_config_from(&resource_dir, std::env::current_exe())
}

fn show_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_widget<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WIDGET_WINDOW) {
        match widget_toggle(window.is_visible().ok()) {
            WidgetToggle::Hide => {
                let _ = window.hide();
            }
            WidgetToggle::ShowAndAnnounce => {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = app.emit(WIDGET_SHOWN_EVENT, ());
            }
        }
    }
}

#[tauri::command]
fn restart_sidecar(supervisor: tauri::State<'_, Arc<Supervisor>>) -> Result<(), String> {
    supervisor.restart()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![restart_sidecar])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if hides_on_close(window.label()) {
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

            let open_item = MenuItem::with_id(app, TRAY_OPEN, "Open Hub", true, None::<&str>)?;
            let widget_item =
                MenuItem::with_id(app, TRAY_WIDGET, "Show/hide widget", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &widget_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("VBSS CCHUB")
                .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
                    TrayAction::ShowMain => show_main(app),
                    TrayAction::ToggleWidget => toggle_widget(app),
                    TrayAction::Quit => app.exit(0),
                    TrayAction::Ignore => {}
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
