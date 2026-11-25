//! Port of src/main/ipc.js: one Tauri command, dispatched by the Electron channel name. Channels not ported yet answer
//! with an error the renderer shows as a toast.
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;

use crate::hik::Hik;
use crate::http::DevError;
use crate::store::{now_ms, public_user, Store};
use crate::streams::{ffmpeg_bin, StartOpts};
use crate::App;

type R = anyhow::Result<Value>;

const TYPES: &[(&str, &str, u16)] = &[
    ("hikvision", "Hikvision / LTS / ENS NVR, DVR, IPC", 80),
    ("dahua", "Dahua / Amcrest / Lorex NVR, XVR, IPC (HTTP API)", 80),
    ("uniview", "Uniview / UNV NVR, IPC (LAPI)", 80),
    ("hanwha", "Hanwha / Wisenet NVR, camera (SUNAPI)", 80),
    ("reolink", "Reolink camera / NVR", 80),
    ("reolinkuid", "Reolink via UID (P2P relay)", 0),
    ("dwspectrum", "DW Spectrum / Nx Witness / Wisenet WAVE server", 7001),
    ("exacq", "exacqVision recorder (via exacqVision Web Service)", 22609),
];
const PORTED: &[&str] = &["hikvision"];

#[tauri::command]
pub async fn ipc(window: tauri::Window, app: tauri::State<'_, Arc<App>>, channel: String, args: Vec<Value>) -> Result<Value, String> {
    let app = app.inner().clone();
    match dispatch(&app, &window, &channel, args).await {
        Ok(v) => Ok(v),
        Err(e) => {
            app.log(format!("ipc error {channel} {e}"));
            Err(e.to_string())
        }
    }
}

fn arg(args: &[Value], i: usize) -> Value {
    args.get(i).cloned().unwrap_or(Value::Null)
}
fn sv(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| if v.is_null() { String::new() } else { v.to_string() })
}

pub fn dirs(app: &App) -> (PathBuf, PathBuf) {
    let s = app.store.lock().settings();
    let snap = Some(sv(&s["snapshotDir"])).filter(|x| !x.is_empty()).map(PathBuf::from).or_else(dirs::picture_dir).unwrap_or_else(|| app.dir.clone());
    let rec = Some(sv(&s["recordDir"])).filter(|x| !x.is_empty()).map(PathBuf::from).unwrap_or_else(|| dirs::video_dir().or_else(dirs::document_dir).unwrap_or_else(|| app.dir.clone()).join("UniVMS").join("Recordings"));
    (snap, rec)
}

// ---------- device status (port of the EventHub status part) ----------
pub fn set_status(app: &App, id: &str, patch: Value) {
    let next = {
        let mut st = app.status.lock();
        let cur = st.entry(id.to_string()).or_insert_with(|| json!({}));
        if let (Some(o), Value::Object(p)) = (cur.as_object_mut(), patch) {
            o.extend(p);
            o.insert("lastCheck".into(), now_ms().into());
        }
        cur.clone()
    };
    let mut payload = next;
    payload["deviceId"] = id.into();
    app.bus.broadcast("devices:status", vec![payload]);
}
/// After a rejected login nothing logs in to that device automatically until it is edited (Hikvision locks accounts).
pub fn auth_blocked(app: &App, id: &str) -> bool {
    let st = app.status.lock().get(id).cloned().unwrap_or(Value::Null);
    let updated = app.store.lock().get_device(id).and_then(|d| d["updatedAt"].as_i64()).unwrap_or(0);
    st["authFailed"] == true && st["authFailedAt"].as_i64().unwrap_or(0) >= updated
}
fn note_failure(app: &App, id: &str, e: &anyhow::Error) {
    match e.downcast_ref::<DevError>() {
        Some(d) if d.auth_failure => set_status(app, id, json!({ "online": false, "error": e.to_string(), "authFailed": true, "authFailedAt": now_ms() })),
        _ => set_status(app, id, json!({ "online": false, "error": e.to_string() })),
    }
}

fn driver(app: &App, id: &str) -> anyhow::Result<Hik> {
    let d = app.store.lock().device_with_secret(id).ok_or_else(|| anyhow::anyhow!("Unknown device {id}"))?;
    if d["secretLost"] == true {
        return Err(DevError { msg: format!("The saved password of {} could not be read ({}). Edit the device and enter the password again.", sv(&d["name"]), sv(&d["secretError"])), auth_failure: true }.into());
    }
    make_driver(&d)
}
fn make_driver(cfg: &Value) -> anyhow::Result<Hik> {
    match cfg["type"].as_str().unwrap_or("") {
        "hikvision" => Hik::new(cfg),
        t => anyhow::bail!("{t} devices are not in the Rust test build yet"),
    }
}

pub async fn refresh_device(app: &Arc<App>, id: &str) -> R {
    let mut drv = driver(app, id)?;
    let info = match drv.probe().await {
        Ok(i) => i,
        Err(e) => {
            note_failure(app, id, &e);
            return Err(e);
        }
    };
    let cams = drv.cameras().await?;
    app.cams.lock().insert(id.to_string(), Value::Array(cams.clone()));
    {
        let mut st = app.store.lock();
        st.patch_device(id, json!({ "info": info, "cameras": cams, "lastRefresh": now_ms() }));
        if info["rtspPort"].is_number() && st.get_device(id).map_or(false, |d| d["rtspPort"].is_null()) {
            st.patch_device(id, json!({ "detectedRtspPort": info["rtspPort"] }));
        }
    }
    set_status(app, id, json!({ "online": true, "error": null, "info": info }));
    app.bus.broadcast("devices:changed", vec![]);
    Ok(json!({ "info": info, "cameras": cams }))
}

pub async fn health_check(app: &Arc<App>) {
    let ids: Vec<String> = app.store.lock().devices().iter().filter_map(|d| d["id"].as_str().map(str::to_string)).collect();
    for id in ids {
        if auth_blocked(app, &id) {
            continue;
        }
        let r = match driver(app, &id) {
            Ok(mut d) => d.probe().await,
            Err(e) => Err(e),
        };
        match r {
            Ok(info) => set_status(app, &id, json!({ "online": true, "error": null, "info": info, "authFailed": false })),
            Err(e) => note_failure(app, &id, &e),
        }
    }
}

struct Cam {
    dev: Value,
    cam: Value,
    channel: i64,
}
fn cam_info(app: &App, camera_id: &str) -> anyhow::Result<Cam> {
    let (dev_id, ch) = camera_id.split_once(':').ok_or_else(|| anyhow::anyhow!("Bad camera id {camera_id}"))?;
    let st = app.store.lock();
    let dev = st.get_device(dev_id).ok_or_else(|| anyhow::anyhow!("Device not found for camera {camera_id}"))?;
    let cams = app.cams.lock().get(dev_id).cloned().unwrap_or_else(|| dev["cameras"].clone());
    let mut cam = cams.as_array().and_then(|a| a.iter().find(|c| sv(&c["channel"]) == ch).cloned()).unwrap_or_else(|| json!({ "channel": ch, "name": format!("Channel {ch}") }));
    if let Some(n) = st.data["cameraAliases"][camera_id]["name"].as_str().filter(|n| !n.is_empty()) {
        cam["name"] = n.into();
    }
    Ok(Cam { dev, cam, channel: ch.parse().unwrap_or(0) })
}

fn snap_file(app: &App, name: &str, ms: i64, ext: &str, suffix: &str) -> PathBuf {
    let t = chrono::DateTime::from_timestamp_millis(if ms > 0 { ms } else { now_ms() }).unwrap_or_default().with_timezone(&chrono::Local);
    let clean: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).collect::<String>().trim().chars().take(80).collect();
    let clean = if clean.is_empty() { "camera".to_string() } else { clean };
    let base = format!("{clean} {}{suffix}", t.format("%Y-%m-%d %H.%M.%S"));
    let dir = dirs(app).0;
    let _ = std::fs::create_dir_all(&dir);
    let mut file = dir.join(format!("{base}.{ext}"));
    let mut k = 2;
    while file.exists() {
        file = dir.join(format!("{base} ({k}).{ext}"));
        k += 1;
    }
    file
}

fn changelog_section(version: &str) -> Value {
    let text = include_str!("../../CHANGELOG.md").replace("\r\n", "\n");
    let head = format!("## {version}");
    let Some(i) = text.lines().position(|l| l.starts_with(&head)) else { return Value::Null };
    let body: Vec<&str> = text.lines().skip(i + 1).take_while(|l| !l.starts_with("## ")).collect();
    body.join("\n").trim().to_string().into()
}

async fn pick(app: &App, folder: bool, current: Option<String>) -> Option<String> {
    let mut d = app.handle.dialog().file();
    if let Some(c) = current.filter(|c| !c.is_empty()) {
        d = d.set_directory(c);
    }
    tokio::task::spawn_blocking(move || if folder { d.blocking_pick_folder() } else { d.blocking_pick_file() })
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

fn walk(dir: &Path, root: &Path, depth: u32, recordings: bool, out: &mut Vec<Value>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if depth < 3 && (recordings || depth < 1) {
                walk(&p, root, depth + 1, recordings, out);
            }
            continue;
        }
        let lower = name.to_lowercase();
        let video = [".mp4", ".mkv", ".avi"].iter().any(|e| lower.ends_with(e));
        let image = [".jpg", ".jpeg", ".png"].iter().any(|e| lower.ends_with(e));
        if (recordings && video) || (!recordings && image) {
            let md = ent.metadata().ok();
            let mtime = md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
            out.push(json!({
                "path": p.display().to_string(), "name": name, "folder": p.parent().and_then(|d| d.strip_prefix(root).ok()).map(|d| d.display().to_string()).unwrap_or_default(),
                "size": md.map_or(0, |m| m.len()), "mtime": mtime, "type": if image { "image" } else { "video" },
            }));
        }
    }
}

async fn dispatch(app: &Arc<App>, window: &tauri::Window, channel: &str, args: Vec<Value>) -> R {
    let a0 = arg(&args, 0);
    Ok(match channel {
        // ---------- app / window ----------
        "app:hello" => json!({ "port": app.bus.port, "token": app.bus.token_for(window.label()) }),
        "app:info" => {
            let (snap, rec) = dirs(app);
            let settings = app.store.lock().settings();
            json!({
                "version": env!("CARGO_PKG_VERSION"), "name": "UniVMS Rust", "platform": if cfg!(windows) { "win32" } else { std::env::consts::OS },
                "userData": app.dir.display().to_string(), "ffmpeg": { "ffmpeg": ffmpeg_bin(&settings).map(|p| p.display().to_string()), "ffmpegVersion": null, "hwaccels": [] },
                "snapshotDir": snap.display().to_string(), "recordDir": rec.display().to_string(), "locked": app.locked.load(Ordering::Relaxed),
                "hiksdk": { "available": false }, "neolink": false,
            })
        }
        "app:changelog" => changelog_section(&sv(&a0)),
        "app:openPath" => {
            tauri_plugin_opener::open_path(sv(&a0), None::<&str>)?;
            json!("")
        }
        "app:showInFolder" => {
            tauri_plugin_opener::reveal_item_in_dir(sv(&a0))?;
            Value::Null
        }
        "updates:status" => Value::Null,
        "updates:check" | "updates:download" => Value::Null,
        "updates:install" => json!({ "ok": false, "reason": "Test builds are installed by hand" }),
        "window:minimize" => {
            window.minimize()?;
            Value::Null
        }
        "window:toggleMaximize" => {
            if window.is_maximized()? { window.unmaximize()? } else { window.maximize()? }
            Value::Null
        }
        "window:close" => {
            window.close()?;
            Value::Null
        }
        "window:isMaximized" => window.is_maximized()?.into(),
        "window:fullscreen" => {
            let on = if a0.is_null() { !window.is_fullscreen()? } else { a0 == true };
            window.set_fullscreen(on)?;
            on.into()
        }
        "window:openAux" => {
            let mut p = if a0.is_object() { a0 } else { json!({}) };
            p["aux"] = true.into();
            crate::open_window(&app.handle, &p)?;
            true.into()
        }

        // ---------- settings ----------
        "settings:get" => {
            let (snap, rec) = dirs(app);
            let mut s = app.store.lock().settings();
            s["snapshotDir"] = snap.display().to_string().into();
            s["recordDir"] = rec.display().to_string().into();
            s
        }
        "settings:set" => app.store.lock().set_settings(a0),
        "settings:pickDir" => pick(app, true, a0.as_str().map(str::to_string)).await.into(),
        "settings:pickFile" => pick(app, false, None).await.into(),

        // ---------- users ----------
        "users:list" => Value::Array(app.store.lock().list("users").as_array().cloned().unwrap_or_default().iter().map(public_user).collect()),
        "users:create" => {
            let (u, p) = (sv(&a0["username"]), sv(&a0["password"]));
            if u.is_empty() || p.is_empty() {
                anyhow::bail!("Username and password are required");
            }
            let mut st = app.store.lock();
            let users = st.list("users").as_array().cloned().unwrap_or_default();
            if users.iter().any(|x| sv(&x["username"]).eq_ignore_ascii_case(&u)) {
                anyhow::bail!("User already exists");
            }
            let (salt, hash) = Store::hash_password(&p, None);
            let role = a0["role"].as_str().map(str::to_string).unwrap_or_else(|| if users.is_empty() { "admin".into() } else { "operator".into() });
            public_user(&st.upsert("users", json!({ "username": u, "role": role, "salt": salt, "hash": hash, "createdAt": now_ms() })))
        }
        "users:remove" => {
            app.store.lock().remove("users", &sv(&a0));
            true.into()
        }
        "users:setPassword" => {
            let mut st = app.store.lock();
            let id = sv(&a0["id"]);
            let (salt, hash) = Store::hash_password(&sv(&a0["password"]), None);
            let u = st.data["users"].as_array_mut().and_then(|a| a.iter_mut().find(|u| u["id"] == id.as_str())).ok_or_else(|| anyhow::anyhow!("User not found"))?;
            u["salt"] = salt.into();
            u["hash"] = hash.into();
            st.save();
            true.into()
        }
        "users:login" => {
            let u = app.store.lock().verify_user(&sv(&a0["username"]), &sv(&a0["password"])).ok_or_else(|| anyhow::anyhow!("Invalid username or password"))?;
            app.locked.store(false, Ordering::Relaxed);
            *app.user.lock() = Some(u.clone());
            u
        }
        "users:lock" => {
            app.locked.store(true, Ordering::Relaxed);
            *app.user.lock() = None;
            true.into()
        }
        "users:current" => app.user.lock().clone().unwrap_or(Value::Null),

        // ---------- devices ----------
        "devices:types" => Value::Array(TYPES.iter().map(|(id, label, port)| json!({ "id": id, "label": label, "defaultPort": port, "available": PORTED.contains(id) })).collect()),
        "devices:list" => {
            let st = app.store.lock();
            let status = app.status.lock();
            Value::Array(st.devices().iter().map(|d| { let mut p = Store::public_device(d); p["status"] = status.get(d["id"].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null); p }).collect())
        }
        "devices:test" => {
            let mut cfg = a0;
            if cfg["id"].is_string() && sv(&cfg["password"]).is_empty() {
                if let Some(stored) = app.store.lock().device_with_secret(&sv(&cfg["id"])) {
                    if stored["secretLost"] == true {
                        anyhow::bail!("The saved password could not be read any more. Enter the password to test the connection.");
                    }
                    cfg["password"] = stored["password"].clone();
                }
            }
            let mut drv = make_driver(&cfg)?;
            let info = drv.probe().await?;
            let cams = drv.cameras().await?;
            json!({ "info": info, "cameraCount": cams.len(), "cameras": cams.into_iter().take(200).collect::<Vec<_>>() })
        }
        "devices:save" => {
            let dev = app.store.lock().upsert_device(a0);
            let id = sv(&dev["id"]);
            set_status(app, &id, json!({ "authFailed": false, "error": null }));
            let a = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh_device(&a, &id).await;
            });
            app.bus.broadcast("devices:changed", vec![]);
            dev
        }
        "devices:remove" => {
            let id = sv(&a0);
            app.cams.lock().remove(&id);
            app.status.lock().remove(&id);
            app.store.lock().remove_device(&id);
            app.bus.broadcast("devices:changed", vec![]);
            true.into()
        }
        "devices:refresh" => refresh_device(app, &sv(&a0)).await?,
        "devices:refreshAll" => {
            let ids: Vec<String> = app.store.lock().devices().iter().map(|d| sv(&d["id"])).collect();
            let mut out = serde_json::Map::new();
            for id in ids {
                let v = match refresh_device(app, &id).await {
                    Ok(r) => r["cameras"].as_array().map_or(0, |c| c.len()).into(),
                    Err(e) => format!("error: {e}").into(),
                };
                out.insert(id, v);
            }
            Value::Object(out)
        }
        "devices:status" => Value::Object(app.status.lock().clone()),
        "devices:setCameraAlias" => {
            let id = sv(&a0["cameraId"]);
            let mut st = app.store.lock();
            if !st.data["cameraAliases"][&id].is_object() {
                st.data["cameraAliases"][&id] = json!({});
            }
            for k in ["name", "hidden", "dewarp", "talkChannel"] {
                if !a0[k].is_null() {
                    st.data["cameraAliases"][&id][k] = a0[k].clone();
                }
            }
            st.save();
            let r = st.data["cameraAliases"][&id].clone();
            drop(st);
            app.bus.broadcast("devices:changed", vec![]);
            r
        }
        "devices:setStreamKey" => {
            let key = if sv(&a0["key"]).is_empty() { Value::Null } else { a0["key"].clone() };
            let r = app.store.lock().upsert_device(json!({ "id": a0["deviceId"], "streamKey": key }));
            app.bus.broadcast("devices:changed", vec![]);
            r
        }

        // ---------- cameras / streams ----------
        "cameras:list" => {
            let st = app.store.lock();
            let cache = app.cams.lock();
            let mut out = vec![];
            for d in st.devices() {
                let id = sv(&d["id"]);
                let cams = cache.get(&id).cloned().unwrap_or_else(|| d["cameras"].clone());
                for c in cams.as_array().cloned().unwrap_or_default() {
                    let alias = &st.data["cameraAliases"][sv(&c["id"])];
                    let mut x = c.clone();
                    x["name"] = if alias["name"].as_str().map_or(false, |n| !n.is_empty()) { alias["name"].clone() } else { c["name"].clone() };
                    x["originalName"] = c["name"].clone();
                    x["hidden"] = (alias["hidden"] == true).into();
                    x["dewarp"] = alias["dewarp"].clone();
                    x["talkChannel"] = alias["talkChannel"].clone();
                    x["deviceName"] = d["name"].clone();
                    x["deviceType"] = d["type"].clone();
                    out.push(x);
                }
            }
            Value::Array(out)
        }
        "cameras:snapshot" => {
            let c = cam_info(app, &sv(&a0["cameraId"]))?;
            let r = driver(app, &sv(&c.dev["id"]))?.snapshot(c.channel, a0["stream"].as_str().unwrap_or("main")).await?;
            json!({ "contentType": if r.content_type.is_empty() { "image/jpeg".to_string() } else { r.content_type }, "data": B64.encode(&r.body) })
        }
        "stream:start" => {
            let o = a0;
            let c = cam_info(app, &sv(&o["cameraId"]))?;
            let drv = driver(app, &sv(&c.dev["id"]))?;
            let settings = app.store.lock().settings();
            let kind = o["kind"].as_str().unwrap_or("live").to_string();
            let url = if kind == "playback" {
                drv.playback_url(c.channel, o["startMs"].as_i64().unwrap_or(0), o["endMs"].as_i64())
            } else {
                drv.live_url(c.channel, o["stream"].as_str().or(settings["defaultStream"].as_str()).unwrap_or("sub"))
            };
            app.streams.start(
                app.bus.clone(),
                window.label().to_string(),
                &settings,
                StartOpts {
                    id: sv(&o["id"]),
                    camera_id: sv(&o["cameraId"]),
                    url,
                    kind,
                    transcode: o["transcode"] == true,
                    audio: o["audio"] == true,
                    fast_probe: false,
                    aspect: c.cam["aspect"].as_str().map(str::to_string).or_else(|| c.cam["aspect"].as_f64().map(|f| f.to_string())),
                },
                app.logger(),
            )?
        }
        "stream:stop" => app.streams.stop(&sv(&a0)).into(),
        "stream:stats" => app.streams.stats(),

        // ---------- files ----------
        "files:saveSnapshot" => {
            let c = cam_info(app, &sv(&a0["cameraId"]))?;
            let data = sv(&a0["dataUrl"]);
            let (head, b64) = data.split_once(";base64,").ok_or_else(|| anyhow::anyhow!("Bad image data"))?;
            let ext = match head.trim_start_matches("data:image/") { "jpeg" => "jpg", e => e }.to_string();
            let file = snap_file(app, &sv(&c.cam["name"]), a0["time"].as_i64().unwrap_or(0), &ext, &sv(&a0["suffix"]));
            std::fs::write(&file, B64.decode(b64)?)?;
            json!({ "file": file.display().to_string() })
        }
        "files:saveDeviceSnapshot" => {
            let c = cam_info(app, &sv(&a0["cameraId"]))?;
            let r = driver(app, &sv(&c.dev["id"]))?.snapshot(c.channel, "main").await?;
            let file = snap_file(app, &sv(&c.cam["name"]), now_ms(), "jpg", " (device)");
            std::fs::write(&file, &r.body)?;
            json!({ "file": file.display().to_string() })
        }
        "files:list" => {
            let rec = a0["kind"] == "recordings";
            let (snap, recd) = dirs(app);
            let dir = if rec { recd } else { snap };
            let mut out = vec![];
            walk(&dir, &dir, 0, rec, &mut out);
            out.sort_by_key(|f| -f["mtime"].as_i64().unwrap_or(0));
            json!({ "dir": dir.display().to_string(), "files": out })
        }
        "files:read" => {
            let p = PathBuf::from(sv(&a0));
            if std::fs::metadata(&p)?.len() > 50 * 1024 * 1024 {
                anyhow::bail!("File too large to preview");
            }
            let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let mime = match ext.as_str() { "mp4" => "video/mp4", "png" => "image/png", _ => "image/jpeg" };
            format!("data:{mime};base64,{}", B64.encode(std::fs::read(&p)?)).into()
        }
        "record:status" => json!({}),

        // ---------- views / groups / maps ----------
        "views:import" => {
            let items = a0.as_array().cloned().unwrap_or_default();
            let mut st = app.store.lock();
            for it in &items {
                st.upsert("views", it.clone());
            }
            drop(st);
            app.bus.broadcast("views:changed", vec![]);
            items.len().into()
        }
        "views:list" | "groups:list" => app.store.lock().list(&channel[..channel.len() - 5]),
        "views:save" | "groups:save" => {
            let r = app.store.lock().upsert(&channel[..channel.len() - 5], a0);
            app.bus.broadcast("views:changed", vec![]);
            r
        }
        "views:remove" | "groups:remove" => {
            app.store.lock().remove(&channel[..channel.len() - 7], &sv(&a0));
            app.bus.broadcast("views:changed", vec![]);
            true.into()
        }
        // ponytail: e-map images need the univms-map:// protocol; maps list without pictures until then
        "maps:list" => Value::Array(app.store.lock().list("maps").as_array().cloned().unwrap_or_default().into_iter().map(|mut m| { m["imageUrl"] = Value::Null; m }).collect()),

        // ---------- events (no alarm subscriptions in the Rust build yet) ----------
        "events:list" => json!([]),
        "events:ack" | "events:clear" => true.into(),

        // ---------- config import / export ----------
        "config:export" => {
            let file = tokio::task::spawn_blocking({
                let d = app.handle.dialog().file().set_file_name(format!("univms-config-{}.json", chrono::Local::now().format("%Y%m%d_%H%M%S"))).add_filter("UniVMS config", &["json"]);
                move || d.blocking_save_file()
            })
            .await?
            .and_then(|p| p.into_path().ok());
            let Some(file) = file else { return Ok(Value::Null) };
            let exp = app.store.lock().export_config(&sv(&a0["password"]));
            std::fs::write(&file, serde_json::to_string_pretty(&exp)?)?;
            file.display().to_string().into()
        }
        "config:import" => {
            let file = tokio::task::spawn_blocking({
                let d = app.handle.dialog().file().add_filter("UniVMS config", &["json"]);
                move || d.blocking_pick_file()
            })
            .await?
            .and_then(|p| p.into_path().ok());
            let Some(file) = file else { return Ok(Value::Null) };
            let obj: Value = serde_json::from_str(&std::fs::read_to_string(file)?)?;
            let r = app.store.lock().import_config(&obj, &sv(&a0["password"]), a0["merge"] != false).map_err(anyhow::Error::msg)?;
            app.bus.broadcast("devices:changed", vec![]);
            let a = app.clone();
            tauri::async_runtime::spawn(async move {
                let ids: Vec<String> = a.store.lock().devices().iter().map(|d| sv(&d["id"])).collect();
                for id in ids {
                    let _ = refresh_device(&a, &id).await;
                }
            });
            r
        }
        "config:status" => {
            let st = app.store.lock();
            json!({ "file": st.file.display().to_string(), "lastFlush": st.last_flush, "lastError": st.last_error })
        }

        // ---------- log ----------
        "log:recent" => Value::Array(app.logbuf.lock().iter().rev().take(500).rev().map(|l| l.clone().into()).collect()),
        "log:openFolder" => {
            tauri_plugin_opener::open_path(app.dir.join("logs").display().to_string(), None::<&str>)?;
            json!("")
        }

        _ => anyhow::bail!("Not in the Rust test build yet ({channel})"),
    })
}
