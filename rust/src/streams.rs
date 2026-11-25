//! Port of StreamManager.start in src/main/streams.js: ffmpeg remuxes RTSP/HTTP to fragmented MP4, the bytes go to the
//! window that asked (bus.data_to), and 'stream:end' follows when ffmpeg exits.
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;

use crate::bus::Bus;
use crate::store::now_ms;

pub fn sanitize_url(u: &str) -> String {
    // rtsp://user:pass@host -> rtsp://***@host (ffmpeg repeats the URL with the password in its errors)
    let mut out = String::with_capacity(u.len());
    let mut rest = u;
    while let Some(i) = rest.find("//") {
        out.push_str(&rest[..i + 2]);
        rest = &rest[i + 2..];
        let end = rest.find(|c: char| c == '/' || c.is_whitespace()).unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            out.push_str("***");
            rest = &rest[at..];
        }
    }
    out.push_str(rest);
    out
}

/// settings path → bundled `ffmpeg/` beside the exe → UNIVMS_FFMPEG → repo vendor (dev) → PATH
pub fn ffmpeg_bin(settings: &Value) -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let plat = if cfg!(windows) { "win32-x64" } else { "linux-x64" };
    let mut c: Vec<PathBuf> = vec![];
    if let Some(p) = settings["ffmpegPath"].as_str().filter(|p| !p.is_empty()) {
        c.push(p.into());
    }
    if let Ok(me) = std::env::current_exe() {
        if let Some(d) = me.parent() {
            c.push(d.join("ffmpeg").join(exe));
        }
    }
    if let Ok(p) = std::env::var("UNIVMS_FFMPEG") {
        c.push(p.into());
    }
    c.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("ffmpeg").join(plat).join(exe));
    c.into_iter().find(|p| p.is_file()).or_else(|| which(exe))
}
fn which(exe: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe)).find(|f| f.is_file()))
}

struct Entry {
    stop: Option<oneshot::Sender<()>>,
    info: Value,
    started: i64,
    bytes: Arc<std::sync::atomic::AtomicU64>,
}

#[derive(Default)]
pub struct Streams {
    map: Mutex<HashMap<String, Entry>>,
}

pub struct StartOpts {
    pub id: String,
    pub camera_id: String,
    pub url: String,
    pub kind: String, // live | playback
    pub transcode: bool,
    pub audio: bool,
    pub fast_probe: bool,
    pub aspect: Option<String>,
}

impl Streams {
    pub fn stop(&self, id: &str) -> bool {
        match self.map.lock().remove(id) {
            Some(mut e) => {
                if let Some(s) = e.stop.take() {
                    let _ = s.send(());
                }
                true
            }
            None => false,
        }
    }
    pub fn stop_all(&self) {
        let ids: Vec<String> = self.map.lock().keys().cloned().collect();
        for id in ids {
            self.stop(&id);
        }
    }
    pub fn stats(&self) -> Value {
        Value::Array(
            self.map
                .lock()
                .iter()
                .map(|(id, e)| json!({ "id": id, "info": e.info, "bytes": e.bytes.load(std::sync::atomic::Ordering::Relaxed), "uptime": now_ms() - e.started }))
                .collect(),
        )
    }

    pub fn start(self: &Arc<Self>, bus: Arc<Bus>, label: String, settings: &Value, o: StartOpts, log: Arc<dyn Fn(String) + Send + Sync>) -> anyhow::Result<Value> {
        self.stop(&o.id);
        let bin = ffmpeg_bin(settings).ok_or_else(|| anyhow::anyhow!("ffmpeg not found. Install ffmpeg or set its path in System Config."))?;
        let transport = settings["rtspTransport"].as_str().unwrap_or("tcp").to_string();
        let mut args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-nostdin"].map(String::from).to_vec();
        let push = |a: &mut Vec<String>, xs: &[&str]| a.extend(xs.iter().map(|s| s.to_string()));
        if settings["lowLatency"] != false && o.kind != "playback" {
            push(&mut args, &["-fflags", "nobuffer", "-flags", "low_delay"]);
        } else {
            push(&mut args, &["-fflags", "+genpts"]);
        }
        if o.fast_probe {
            push(&mut args, &["-analyzeduration", "500000", "-probesize", "100000"]);
        }
        if o.url.starts_with("http") {
            push(&mut args, &["-tls_verify", "0", "-timeout", "15000000", "-i", &o.url]);
        } else {
            push(&mut args, &["-rtsp_transport", &transport, "-timeout", "15000000", "-i", &o.url]);
        }
        push(&mut args, &["-map", "0:v:0"]);
        if o.audio {
            push(&mut args, &["-map", "0:a:0?", "-c:a", "aac", "-ar", "16000", "-ac", "1", "-b:a", "48k"]);
        } else {
            push(&mut args, &["-an"]);
        }
        if o.transcode {
            push(&mut args, &["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "25", "-b:v", "2M"]);
        } else {
            push(&mut args, &["-c:v", "copy"]);
        }
        if let Some(a) = &o.aspect {
            push(&mut args, &["-aspect", a]);
        }
        let movflags = if o.fast_probe { "empty_moov+default_base_moof+frag_every_frame" } else { "empty_moov+default_base_moof+frag_keyframe" };
        let frag = if o.kind == "playback" { "500000" } else { "300000" };
        push(&mut args, &["-f", "mp4", "-movflags", movflags, "-frag_duration", frag, "-avoid_negative_ts", "make_zero", "pipe:1"]);

        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn()?;
        let mut stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        let bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let started = now_ms();
        self.map.lock().insert(o.id.clone(), Entry { stop: Some(stop_tx), info: json!({ "cameraId": o.camera_id, "kind": o.kind, "url": sanitize_url(&o.url) }), started, bytes: bytes.clone() });

        let errors = Arc::new(Mutex::new(VecDeque::<String>::new()));
        let errs = errors.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut e = errs.lock();
                e.push_back(sanitize_url(&l));
                if e.len() > 20 {
                    e.pop_front();
                }
            }
        });

        let me = self.clone();
        let id = o.id.clone();
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 256 * 1024];
            let pump = async {
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            bytes.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
                            bus.data_to(&label, &id, &buf[..n]);
                        }
                    }
                }
            };
            let stopped = tokio::select! { _ = pump => false, _ = &mut stop_rx => true };
            if stopped {
                let _ = child.start_kill();
            }
            let code = child.wait().await.ok().and_then(|s| s.code());
            {
                let mut m = me.map.lock();
                if m.get(&id).map_or(false, |e| e.started == started) {
                    m.remove(&id);
                }
            }
            let total = bytes.load(std::sync::atomic::Ordering::Relaxed);
            let tail: Vec<String> = errors.lock().iter().rev().take(3).rev().cloned().collect();
            if code != Some(0) || total == 0 {
                log(format!("stream ended {} {} code={:?} bytes={} {}", o.camera_id, o.kind, code, total, tail.join(" | ")));
            }
            bus.emit_to(&label, "stream:end", vec![id.into(), json!({ "code": code, "error": tail.join("\n"), "bytes": total, "uptime": now_ms() - started })]);
        });
        Ok(json!({ "ok": true, "args": args.iter().map(|a| sanitize_url(a)).collect::<Vec<_>>() }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hides_passwords() {
        assert_eq!(super::sanitize_url("rtsp://admin:p%40ss@10.0.0.1:554/Streaming/Channels/102"), "rtsp://***@10.0.0.1:554/Streaming/Channels/102");
        assert_eq!(super::sanitize_url("Error opening rtsp://a:b@h/x and http://h/y"), "Error opening rtsp://***@h/x and http://h/y");
    }
}
