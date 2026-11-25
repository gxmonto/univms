//! Port of src/main/store.js + secrets.js. Same JSON layout and the same password format (`aes:` + base64(iv|tag|ct),
//! AES-256-GCM, key in `univms.key` protected with DPAPI on Windows), so a config exported from UniVMS imports here.
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::RngCore;
use serde_json::{json, Map, Value};

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

fn defaults() -> Value {
    json!({
        "version": 1, "devices": [], "views": [], "groups": [], "maps": [], "users": [], "cameraAliases": {},
        "settings": {
            "snapshotDir": "", "recordDir": "", "ffmpegPath": "", "ffprobePath": "", "defaultStream": "sub",
            "rtspTransport": "tcp", "lowLatency": true, "autoReconnect": true, "alarmPopup": false, "alarmSound": false,
            "alarmTypes": ["VMD", "linedetection", "fielddetection", "IO", "videoloss", "shelteralarm", "cameraMotionEvent", "cameraInputEvent", "cameraDisconnectEvent"],
            "requireLogin": false, "autoLogin": false, "minimizeToTray": false, "startFullscreen": false,
            "autoSwitchInterval": 10, "hwDecode": true, "eventRetention": 2000, "alarmsOptIn": true
        }
    })
}

// ---------- key file ----------
#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        v
    }
    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let desc: Vec<u16> = "UniVMS\0".encode_utf16().collect();
        unsafe {
            let inp = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            if CryptProtectData(&inp, desc.as_ptr(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
                return None;
            }
            Some(take(out))
        }
    }
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let inp = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            if CryptUnprotectData(&inp, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
                return None;
            }
            Some(take(out))
        }
    }
}
#[cfg(not(windows))]
mod dpapi {
    // ponytail: Linux keeps the key file plain (profile permissions); Secret Service keyring when Linux builds matter
    pub fn protect(_: &[u8]) -> Option<Vec<u8>> { None }
    pub fn unprotect(_: &[u8]) -> Option<Vec<u8>> { None }
}

fn load_or_create_key(dir: &Path, log: &dyn Fn(String)) -> [u8; 32] {
    let file = dir.join("univms.key");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let rec: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let raw = B64.decode(rec["key"].as_str().unwrap_or("")).unwrap_or_default();
        let key = match rec["scheme"].as_str() {
            Some("dpapi") => dpapi::unprotect(&raw),
            Some("plain") => Some(raw),
            _ => None,
        };
        if let Some(k) = key.filter(|k| k.len() == 32) {
            return k.try_into().unwrap();
        }
        log("secrets: key file unreadable, creating a new key".into());
        let _ = std::fs::rename(&file, dir.join(format!("univms.key.lost-{}", now_ms())));
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let rec = match dpapi::protect(&key) {
        Some(p) => json!({ "scheme": "dpapi", "key": B64.encode(p) }),
        None => json!({ "scheme": "plain", "key": B64.encode(key) }),
    };
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&file, rec.to_string());
    key
}

pub fn scrypt_hex(password: &str, salt: &[u8], len: usize) -> Vec<u8> {
    // Node's crypto.scryptSync defaults: N=16384, r=8, p=1
    let mut out = vec![0u8; len];
    scrypt::scrypt(password.as_bytes(), salt, &scrypt::Params::new(14, 8, 1, len).unwrap(), &mut out).unwrap();
    out
}

fn gcm_seal(key: &[u8], plain: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let mut ct = Aes256Gcm::new_from_slice(key).unwrap().encrypt(Nonce::from_slice(&iv), plain).unwrap();
    let tag = ct.split_off(ct.len() - 16);
    (iv.to_vec(), tag, ct)
}
fn gcm_open(key: &[u8], iv: &[u8], tag: &[u8], ct: &[u8]) -> Option<Vec<u8>> {
    let mut buf = ct.to_vec();
    buf.extend_from_slice(tag);
    Aes256Gcm::new_from_slice(key).ok()?.decrypt(Nonce::from_slice(iv), buf.as_slice()).ok()
}

pub struct Store {
    pub file: PathBuf,
    pub data: Value,
    key: [u8; 32],
    pub last_error: Option<String>,
    pub last_flush: Option<i64>,
}

impl Store {
    pub fn open(dir: &Path, log: &dyn Fn(String)) -> Store {
        let file = dir.join("univms-config.json");
        let mut data = defaults();
        if let Ok(text) = std::fs::read_to_string(&file) {
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(raw)) => {
                    let base = data.as_object_mut().unwrap();
                    for (k, v) in raw {
                        if k == "settings" {
                            if let Value::Object(s) = v {
                                for (sk, sv) in s {
                                    base["settings"][&sk] = sv;
                                }
                            }
                        } else {
                            base.insert(k, v);
                        }
                    }
                }
                _ => {
                    log("store: failed to load, starting fresh".into());
                    let _ = std::fs::copy(&file, dir.join(format!("univms-config.json.corrupt-{}", now_ms())));
                }
            }
        }
        if let Some(s) = data["settings"].as_object_mut() {
            s.remove("updates");
        }
        Store { file, data, key: load_or_create_key(dir, log), last_error: None, last_flush: None }
    }

    /// ponytail: writes synchronously on every change (the file is small); debounce if saves ever show up in a profile
    pub fn save(&mut self) {
        let json = serde_json::to_string_pretty(&self.data).unwrap_or_default();
        let tmp = self.file.with_extension("json.tmp");
        let r = std::fs::write(&tmp, &json).and_then(|_| std::fs::rename(&tmp, &self.file).or_else(|_| std::fs::write(&self.file, &json)));
        match r {
            Ok(_) => {
                self.last_error = None;
                self.last_flush = Some(now_ms());
            }
            Err(e) => self.last_error = Some(format!("Configuration could not be saved to {}: {}", self.file.display(), e)),
        }
    }

    // ---------- secrets ----------
    pub fn encrypt(&self, plain: &str) -> String {
        if plain.is_empty() {
            return String::new();
        }
        let (iv, tag, ct) = gcm_seal(&self.key, plain.as_bytes());
        format!("aes:{}", B64.encode([iv, tag, ct].concat()))
    }
    /// Err = the value was encrypted with a key this installation does not have.
    pub fn decrypt(&self, stored: &str) -> Result<String, String> {
        if stored.is_empty() {
            return Ok(String::new());
        }
        if let Some(rest) = stored.strip_prefix("aes:") {
            let raw = B64.decode(rest).map_err(|e| e.to_string())?;
            if raw.len() < 28 {
                return Err("bad secret".into());
            }
            return gcm_open(&self.key, &raw[..12], &raw[12..28], &raw[28..])
                .and_then(|p| String::from_utf8(p).ok())
                .ok_or_else(|| "the saved password was encrypted with a key this installation no longer has".into());
        }
        if let Some(rest) = stored.strip_prefix("b64:") {
            return Ok(String::from_utf8(B64.decode(rest).unwrap_or_default()).unwrap_or_default());
        }
        if stored.starts_with("enc:") {
            return Err("the saved password cannot be decrypted any more (the system encryption key changed)".into());
        }
        Ok(stored.to_string())
    }

    // ---------- devices ----------
    pub fn devices(&self) -> Vec<Value> {
        self.data["devices"].as_array().cloned().unwrap_or_default()
    }
    pub fn public_device(d: &Value) -> Value {
        let mut p = d.clone();
        let o = p.as_object_mut().unwrap();
        let has_pw = o.remove("passwordEnc").map(|v| v.as_str().map_or(false, |s| !s.is_empty())).unwrap_or(false);
        let has_key = o.remove("streamKeyEnc").is_some();
        o.insert("hasPassword".into(), has_pw.into());
        o.insert("hasStreamKey".into(), has_key.into());
        p
    }
    pub fn get_device(&self, id: &str) -> Option<Value> {
        self.data["devices"].as_array()?.iter().find(|d| d["id"] == id).cloned()
    }
    pub fn device_with_secret(&self, id: &str) -> Option<Value> {
        let mut d = self.get_device(id)?;
        let stream_key = self.decrypt(d["streamKeyEnc"].as_str().unwrap_or("")).unwrap_or_default();
        let o = d.as_object_mut().unwrap();
        o.insert("streamKey".into(), stream_key.into());
        match self.decrypt(o.get("passwordEnc").and_then(|v| v.as_str()).unwrap_or("")) {
            Ok(pw) => {
                o.insert("password".into(), pw.into());
                o.insert("secretLost".into(), false.into());
            }
            Err(e) => {
                // never log in with an empty password instead (Hikvision locks the account)
                o.insert("password".into(), "".into());
                o.insert("secretLost".into(), true.into());
                o.insert("secretError".into(), e.into());
            }
        }
        Some(d)
    }
    pub fn upsert_device(&mut self, input: Value) -> Value {
        let id = input["id"].as_str().unwrap_or("").to_string();
        let existing = if id.is_empty() { None } else { self.get_device(&id) };
        let mut dev = existing.clone().unwrap_or_else(|| json!({ "id": format!("dev_{}", rand_hex(6)), "createdAt": now_ms() }));
        let o = dev.as_object_mut().unwrap();
        if let Value::Object(inp) = input {
            for (k, v) in inp {
                match k.as_str() {
                    "password" => {
                        if let Some(p) = v.as_str().filter(|p| !p.is_empty()) {
                            o.insert("passwordEnc".into(), self.encrypt(p).into());
                        }
                    }
                    "streamKey" => {
                        if v.is_null() {
                            o.remove("streamKeyEnc");
                        } else if let Some(p) = v.as_str().filter(|p| !p.is_empty()) {
                            o.insert("streamKeyEnc".into(), self.encrypt(p).into());
                        }
                    }
                    _ => {
                        o.insert(k, v);
                    }
                }
            }
        }
        o.insert("updatedAt".into(), now_ms().into());
        let arr = self.data["devices"].as_array_mut().unwrap();
        match arr.iter().position(|d| d["id"] == dev["id"]) {
            Some(i) => arr[i] = dev.clone(),
            None => arr.push(dev.clone()),
        }
        self.save();
        Self::public_device(&dev)
    }
    pub fn remove_device(&mut self, id: &str) {
        let prefix = format!("{id}:");
        let d = &mut self.data;
        if let Some(a) = d["devices"].as_array_mut() {
            a.retain(|x| x["id"] != id);
        }
        for g in d["groups"].as_array_mut().into_iter().flatten() {
            if let Some(c) = g["cameras"].as_array_mut() {
                c.retain(|c| !c.as_str().unwrap_or("").starts_with(&prefix));
            }
        }
        for v in d["views"].as_array_mut().into_iter().flatten() {
            for c in v["cells"].as_array_mut().into_iter().flatten() {
                if c["cameraId"].as_str().map_or(false, |s| s.starts_with(&prefix)) {
                    *c = Value::Null;
                }
            }
        }
        for m in d["maps"].as_array_mut().into_iter().flatten() {
            if let Some(h) = m["hotspots"].as_array_mut() {
                h.retain(|h| !h["cameraId"].as_str().unwrap_or("").starts_with(&prefix));
            }
        }
        self.save();
    }
    pub fn patch_device(&mut self, id: &str, patch: Value) {
        if let Some(d) = self.data["devices"].as_array_mut().and_then(|a| a.iter_mut().find(|d| d["id"] == id)) {
            if let (Some(o), Value::Object(p)) = (d.as_object_mut(), patch) {
                o.extend(p);
            }
            self.save();
        }
    }

    // ---------- generic collections ----------
    pub fn list(&self, coll: &str) -> Value {
        self.data.get(coll).cloned().unwrap_or(json!([]))
    }
    pub fn upsert(&mut self, coll: &str, mut item: Value) -> Value {
        if item["id"].as_str().map_or(true, |s| s.is_empty()) {
            item["id"] = format!("{}_{}", &coll[..3], rand_hex(5)).into();
        }
        if !self.data[coll].is_array() {
            self.data[coll] = json!([]);
        }
        let arr = self.data[coll].as_array_mut().unwrap();
        let out = match arr.iter().position(|x| x["id"] == item["id"]) {
            Some(i) => {
                if let (Some(o), Value::Object(p)) = (arr[i].as_object_mut(), item) {
                    o.extend(p);
                }
                arr[i].clone()
            }
            None => {
                arr.push(item.clone());
                item
            }
        };
        self.save();
        out
    }
    pub fn remove(&mut self, coll: &str, id: &str) {
        if let Some(a) = self.data[coll].as_array_mut() {
            a.retain(|x| x["id"] != id);
        }
        self.save();
    }

    // ---------- settings ----------
    pub fn settings(&self) -> Value {
        self.data["settings"].clone()
    }
    pub fn set_settings(&mut self, patch: Value) -> Value {
        if let Value::Object(mut p) = patch {
            p.remove("updates");
            self.data["settings"].as_object_mut().unwrap().extend(p);
        }
        self.save();
        self.settings()
    }

    // ---------- app users (same scrypt hashes as the Electron app) ----------
    pub fn hash_password(password: &str, salt: Option<&str>) -> (String, String) {
        let salt = salt.map(str::to_string).unwrap_or_else(|| rand_hex(16));
        let hash = hex::encode(scrypt_hex(password, salt.as_bytes(), 64));
        (salt, hash)
    }
    pub fn verify_user(&self, username: &str, password: &str) -> Option<Value> {
        let u = self.data["users"].as_array()?.iter().find(|u| u["username"].as_str().unwrap_or("").eq_ignore_ascii_case(username))?;
        let (_, hash) = Self::hash_password(password, u["salt"].as_str());
        // constant-time compare
        let a = hash.as_bytes();
        let b = u["hash"].as_str().unwrap_or("").as_bytes();
        if a.len() != b.len() || a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) != 0 {
            return None;
        }
        Some(public_user(u))
    }

    // ---------- export / import ----------
    pub fn export_config(&self, password: &str) -> Value {
        let devices: Vec<Value> = self
            .devices()
            .into_iter()
            .map(|mut d| {
                let pw = self.decrypt(d["passwordEnc"].as_str().unwrap_or("")).unwrap_or_default();
                let sk = self.decrypt(d["streamKeyEnc"].as_str().unwrap_or("")).unwrap_or_default();
                let o = d.as_object_mut().unwrap();
                o.remove("passwordEnc");
                o.remove("streamKeyEnc");
                o.insert("password".into(), pw.into());
                if !sk.is_empty() {
                    o.insert("streamKey".into(), sk.into());
                }
                d
            })
            .collect();
        let maps: Vec<Value> = self.list("maps").as_array().cloned().unwrap_or_default().into_iter().map(|mut m| { m.as_object_mut().map(|o| o.remove("image")); m }).collect();
        let payload = json!({
            "exportedAt": chrono::Utc::now().to_rfc3339(), "devices": devices, "views": self.data["views"], "groups": self.data["groups"],
            "maps": maps, "cameraAliases": self.data["cameraAliases"], "settings": self.data["settings"],
        });
        if password.is_empty() {
            return json!({ "format": "univms-config", "encrypted": false, "data": payload });
        }
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let key = scrypt_hex(password, &salt, 32);
        let (iv, tag, ct) = gcm_seal(&key, payload.to_string().as_bytes());
        json!({ "format": "univms-config", "encrypted": true, "salt": B64.encode(salt), "iv": B64.encode(iv), "tag": B64.encode(tag), "data": B64.encode(ct) })
    }
    pub fn import_config(&mut self, obj: &Value, password: &str, merge: bool) -> Result<Value, String> {
        if obj["format"] != "univms-config" {
            return Err("Not a UniVMS configuration file".into());
        }
        let payload: Value = if obj["encrypted"] == true {
            if password.is_empty() {
                return Err("This configuration file is encrypted; a password is required".into());
            }
            let d = |k: &str| B64.decode(obj[k].as_str().unwrap_or("")).unwrap_or_default();
            let key = scrypt_hex(password, &d("salt"), 32);
            let plain = gcm_open(&key, &d("iv"), &d("tag"), &d("data")).ok_or("Wrong password or corrupted file")?;
            serde_json::from_slice(&plain).map_err(|_| "Wrong password or corrupted file")?
        } else {
            obj["data"].clone()
        };
        if !merge {
            for c in ["devices", "views", "groups", "maps"] {
                self.data[c] = json!([]);
            }
        }
        let devices = payload["devices"].as_array().cloned().unwrap_or_default();
        for d in &devices {
            let mut rest = d.clone();
            let o = rest.as_object_mut().unwrap();
            let pw = o.remove("password").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            let sk = o.remove("streamKey").and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
            if !pw.is_empty() {
                o.insert("passwordEnc".into(), self.encrypt(&pw).into());
            }
            if !sk.is_empty() {
                o.insert("streamKeyEnc".into(), self.encrypt(&sk).into());
            }
            let arr = self.data["devices"].as_array_mut().unwrap();
            match arr.iter().position(|x| x["id"] == rest["id"]) {
                Some(i) => arr[i].as_object_mut().unwrap().extend(rest.as_object().unwrap().clone()),
                None => arr.push(rest),
            }
        }
        for c in ["views", "groups", "maps"] {
            for it in payload[c].as_array().cloned().unwrap_or_default() {
                self.upsert(c, it);
            }
        }
        if let (Some(a), Some(b)) = (self.data["cameraAliases"].as_object_mut(), payload["cameraAliases"].as_object()) {
            a.extend(b.clone());
        }
        self.set_settings(payload["settings"].clone());
        Ok(json!({ "devices": devices.len(), "views": payload["views"].as_array().map_or(0, |v| v.len()) }))
    }
}

pub fn public_user(u: &Value) -> Value {
    let mut p: Map<String, Value> = u.as_object().cloned().unwrap_or_default();
    p.remove("hash");
    p.remove("salt");
    Value::Object(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_roundtrip_and_export_import() {
        let dir = std::env::temp_dir().join(format!("univms-store-{}", rand_hex(4)));
        let mut s = Store::open(&dir, &|_| {});
        let d = s.upsert_device(json!({ "name": "nvr", "type": "hikvision", "host": "10.0.0.1", "password": "pa$$" }));
        let id = d["id"].as_str().unwrap().to_string();
        assert_eq!(d["hasPassword"], true);
        assert!(d.get("passwordEnc").is_none());
        assert_eq!(s.device_with_secret(&id).unwrap()["password"], "pa$$");
        // a second Store on the same folder reads the key file back
        let s2 = Store::open(&dir, &|_| {});
        assert_eq!(s2.device_with_secret(&id).unwrap()["password"], "pa$$");
        let exp = s.export_config("pw");
        let mut other = Store::open(&dir.join("other"), &|_| {});
        assert!(other.import_config(&exp, "wrong", true).is_err());
        other.import_config(&exp, "pw", true).unwrap();
        assert_eq!(other.device_with_secret(&id).unwrap()["password"], "pa$$");
        let (salt, hash) = Store::hash_password("x", None);
        s.data["users"] = json!([{ "id": "u1", "username": "Admin", "salt": salt, "hash": hash }]);
        assert!(s.verify_user("admin", "x").is_some());
        assert!(s.verify_user("admin", "y").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
