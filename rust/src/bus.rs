//! Events and video to the windows over one local WebSocket per window (bridge.js is the client).
//! A window gets a one-time token through `app:hello` (the Tauri IPC) and must send it first; other local
//! processes cannot attach without it.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

pub struct Bus {
    pub port: u16,
    tokens: Mutex<HashMap<String, String>>, // token -> window label
    clients: Mutex<Vec<(String, u64, UnboundedSender<Message>)>>,
    next: AtomicU64,
}

impl Bus {
    pub fn start() -> anyhow::Result<Arc<Bus>> {
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        std_listener.set_nonblocking(true)?;
        let bus = Arc::new(Bus { port: std_listener.local_addr()?.port(), tokens: Default::default(), clients: Default::default(), next: AtomicU64::new(1) });
        let b = bus.clone();
        tauri::async_runtime::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(std_listener).expect("bus listener");
            while let Ok((sock, _)) = listener.accept().await {
                let _ = sock.set_nodelay(true);
                tokio::spawn(b.clone().client(sock));
            }
        });
        Ok(bus)
    }

    pub fn token_for(&self, label: &str) -> String {
        let mut b = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
        let t = hex::encode(b);
        self.tokens.lock().insert(t.clone(), label.to_string());
        t
    }

    async fn client(self: Arc<Self>, sock: tokio::net::TcpStream) {
        let Ok(ws) = tokio_tungstenite::accept_async(sock).await else { return };
        let (mut tx, mut rx) = ws.split();
        let label = match tokio::time::timeout(Duration::from_secs(5), rx.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => self.tokens.lock().remove(t.as_str()),
            _ => None,
        };
        let Some(label) = label else { return };
        let (out, mut out_rx) = unbounded_channel::<Message>();
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.clients.lock().push((label, id, out.clone()));
        let _ = out.send(Message::text(r#"["__ready"]"#));
        let writer = async {
            while let Some(m) = out_rx.recv().await {
                if tx.send(m).await.is_err() {
                    break;
                }
            }
        };
        let reader = async { while let Some(Ok(_)) = rx.next().await {} };
        tokio::select! { _ = writer => {}, _ = reader => {} }
        self.clients.lock().retain(|c| c.1 != id);
    }

    fn send(&self, label: Option<&str>, m: Message) {
        for (l, _, tx) in self.clients.lock().iter() {
            if label.map_or(true, |x| x == l) {
                let _ = tx.send(m.clone());
            }
        }
    }
    /// `[channel, ...args]` to every window.
    pub fn broadcast(&self, channel: &str, args: Vec<Value>) {
        self.send(None, Message::text(frame(channel, args)));
    }
    pub fn emit_to(&self, label: &str, channel: &str, args: Vec<Value>) {
        self.send(Some(label), Message::text(frame(channel, args)));
    }
    /// 'stream:data' (id, bytes) to one window.
    pub fn data_to(&self, label: &str, id: &str, data: &[u8]) {
        let idb = id.as_bytes();
        let mut v = Vec::with_capacity(1 + idb.len() + data.len());
        v.push(idb.len().min(255) as u8);
        v.extend_from_slice(&idb[..idb.len().min(255)]);
        v.extend_from_slice(data);
        self.send(Some(label), Message::binary(v));
    }
}

fn frame(channel: &str, args: Vec<Value>) -> String {
    let mut a = vec![Value::String(channel.to_string())];
    a.extend(args);
    Value::Array(a).to_string()
}
