//! UniVMS, Rust build: Tauri 2 shell around the unchanged renderer in src/renderer.
//! Port of src/main/main.js. Own identity and profile (`UniVMS Rust`), so it installs beside UniVMS without touching it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bus;
mod hik;
mod http;
mod ipc;
mod store;
mod streams;
mod xml;

use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub struct App {
    pub dir: PathBuf,
    pub store: Mutex<store::Store>,
    pub bus: Arc<bus::Bus>,
    pub streams: Arc<streams::Streams>,
    pub status: Mutex<Map<String, Value>>,
    pub cams: Mutex<HashMap<String, Value>>,
    pub logbuf: Mutex<VecDeque<String>>,
    pub user: Mutex<Option<Value>>,
    pub locked: AtomicBool,
    pub handle: AppHandle,
    win_state: Mutex<HashMap<String, (bool, bool)>>,
}

impl App {
    pub fn log(&self, msg: impl AsRef<str>) {
        let line = format!("{} {}", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f"), msg.as_ref());
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("logs").join("main.log")) {
            let _ = writeln!(f, "{line}");
        }
        let mut b = self.logbuf.lock();
        b.push_back(line);
        if b.len() > 2000 {
            b.pop_front();
        }
    }
    pub fn logger(self: &Arc<Self>) -> Arc<dyn Fn(String) + Send + Sync> {
        let me = self.clone();
        Arc::new(move |m| me.log(m))
    }
}

fn profile_dir() -> PathBuf {
    if let Some(d) = std::env::args().find_map(|a| a.strip_prefix("--user-data-dir=").map(PathBuf::from)) {
        return d;
    }
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("UniVMS Rust")
}

fn bridge_script() -> String {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        o => o,
    };
    include_str!("bridge.js").replace("__PLATFORM__", platform).replace("__TAURI_VERSION__", tauri::VERSION)
}

/// Main window (`main`) or an extra live-view window (`aux-N`), frameless like the Electron app.
pub fn open_window(app: &AppHandle, params: &Value) -> tauri::Result<()> {
    let aux = params["aux"] == true;
    let label = if aux { format!("aux-{}", store::now_ms()) } else { "main".into() };
    let mut q: Vec<String> = vec![];
    if aux {
        q.push("aux=1".into());
    }
    if let Some(v) = params["view"].as_str() {
        q.push(format!("view={v}"));
    }
    let url = if q.is_empty() { "index.html".to_string() } else { format!("index.html?{}", q.join("&")) };
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("UniVMS")
        .decorations(false)
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .initialization_script(&bridge_script())
        .build()?;
    if !aux {
        let _ = w.maximize();
    }
    Ok(())
}

fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::Resized(_) = event {
        let app = window.state::<Arc<App>>();
        let (max, full) = (window.is_maximized().unwrap_or(false), window.is_fullscreen().unwrap_or(false));
        let prev = app.win_state.lock().insert(window.label().to_string(), (max, full)).unwrap_or((false, false));
        let ev = if full != prev.1 {
            if full { "enter-full-screen" } else { "leave-full-screen" }
        } else if max != prev.0 {
            if max { "maximize" } else { "unmaximize" }
        } else {
            return;
        };
        app.bus.emit_to(window.label(), "window:state", vec![json!({ "event": ev, "maximized": max, "fullscreen": full })]);
    }
    if let tauri::WindowEvent::Destroyed = event {
        if window.label() == "main" {
            let app = window.state::<Arc<App>>();
            app.streams.stop_all();
            window.app_handle().exit(0);
        }
    }
}

fn main() {
    let dir = profile_dir();
    let _ = std::fs::create_dir_all(dir.join("logs"));
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![ipc::ipc])
        .on_window_event(on_window_event)
        .setup(move |tapp| {
            let handle = tapp.handle().clone();
            let pending: Arc<Mutex<Vec<String>>> = Default::default();
            let p2 = pending.clone();
            let store = store::Store::open(&dir, &move |m| p2.lock().push(m));
            let app = Arc::new(App {
                dir: dir.clone(),
                store: Mutex::new(store),
                bus: bus::Bus::start()?,
                streams: Default::default(),
                status: Default::default(),
                cams: Default::default(),
                logbuf: Default::default(),
                user: Default::default(),
                locked: AtomicBool::new(false),
                handle: handle.clone(),
                win_state: Default::default(),
            });
            app.log(format!("UniVMS Rust {} starting ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH));
            for m in pending.lock().drain(..) {
                app.log(m);
            }
            tapp.manage(app.clone());
            open_window(&handle, &json!({}))?;
            // device health: probe every device now and every 60 s (never one whose login was rejected; see ipc::auth_blocked)
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                loop {
                    ipc::health_check(&app).await;
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("UniVMS failed to start");
}
