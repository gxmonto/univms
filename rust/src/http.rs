//! Port of src/main/httpclient.js: Digest/Basic/Bearer, self-signed TLS accepted, digest challenge cached per host.
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use md5::{Digest, Md5};
use parking_lot::Mutex;
use rand::RngCore;

/// Device error; `auth_failure` stops automatic logins (Hikvision locks accounts after a few failures).
#[derive(Debug)]
pub struct DevError {
    pub msg: String,
    pub auth_failure: bool,
}
impl std::fmt::Display for DevError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.msg)
    }
}
impl std::error::Error for DevError {}

pub fn http_error(status: u16, text: &str) -> DevError {
    let lock = if regex_lite_lock(text) { find_between(text, "<unlockTime>", "</unlockTime>").and_then(|s| s.trim().parse::<u64>().ok()) } else { None };
    let plain = if !text.trim_start().starts_with('<') { text.chars().take(160).collect::<String>() } else { String::new() };
    let msg = if status == 401 {
        format!(
            "Login rejected by the device (401{}){}. Check the username and password.",
            if plain.is_empty() { String::new() } else { format!(": {plain}") },
            lock.map(|s| format!(" — account locked for {} more minute(s) after repeated failed logins", s.div_ceil(60))).unwrap_or_default()
        )
    } else {
        format!("HTTP {status}{}", if text.is_empty() { String::new() } else { format!(": {}", text.chars().take(300).collect::<String>()) })
    };
    DevError { msg, auth_failure: status == 401 || status == 403 }
}
fn regex_lite_lock(t: &str) -> bool {
    find_between(t, "<lockStatus>", "</lockStatus>").map_or(false, |s| s.trim().eq_ignore_ascii_case("lock"))
}
pub fn find_between<'a>(t: &'a str, a: &str, b: &str) -> Option<&'a str> {
    let i = t.find(a)? + a.len();
    let j = t[i..].find(b)? + i;
    Some(&t[i..j])
}

#[derive(Clone)]
pub enum Auth {
    Digest(String, String),
    Basic(String, String),
    Bearer(String),
}

pub struct Resp {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}
impl Resp {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Clone, Default)]
struct Challenge {
    realm: String,
    nonce: String,
    qop: Option<String>,
    opaque: Option<String>,
    algorithm: Option<String>,
    nc: u32,
}

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            // own connection per request (DW: a kept-alive socket the server had closed failed every second request)
            .pool_max_idle_per_host(0)
            .user_agent("UniVMS/1.0")
            .build()
            .expect("http client")
    })
}
fn challenges() -> &'static Mutex<HashMap<String, Challenge>> {
    static M: OnceLock<Mutex<HashMap<String, Challenge>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn md5_hex(s: &str) -> String {
    hex::encode(Md5::digest(s.as_bytes()))
}

fn parse_challenge(header: &str) -> Challenge {
    let s = header.trim_start().trim_start_matches(|c: char| c.is_ascii_alphabetic()).trim_start(); // "Digest "
    let mut map = HashMap::new();
    let mut rest = s;
    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].trim().trim_start_matches(',').trim().to_ascii_lowercase();
        rest = &rest[eq + 1..];
        let value;
        if let Some(r) = rest.strip_prefix('"') {
            let end = r.find('"').unwrap_or(r.len());
            value = r[..end].to_string();
            rest = r.get(end + 1..).unwrap_or("");
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            value = rest[..end].trim().to_string();
            rest = &rest[end..];
        }
        map.insert(key, value);
    }
    Challenge {
        realm: map.remove("realm").unwrap_or_default(),
        nonce: map.remove("nonce").unwrap_or_default(),
        qop: map.remove("qop"),
        opaque: map.remove("opaque"),
        algorithm: map.remove("algorithm"),
        nc: 0,
    }
}

fn digest_header(ch: &mut Challenge, method: &str, uri: &str, user: &str, pass: &str) -> String {
    ch.nc += 1;
    let nc = format!("{:08x}", ch.nc);
    let mut cb = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut cb);
    let cnonce = hex::encode(cb);
    let algorithm = ch.algorithm.clone().unwrap_or_else(|| "MD5".into()).to_ascii_uppercase();
    let mut ha1 = md5_hex(&format!("{user}:{}:{pass}", ch.realm));
    if algorithm == "MD5-SESS" {
        ha1 = md5_hex(&format!("{ha1}:{}:{cnonce}", ch.nonce));
    }
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let qop = ch.qop.as_ref().map(|q| {
        let list: Vec<&str> = q.split(',').map(str::trim).collect();
        if list.contains(&"auth") { "auth".to_string() } else { list[0].to_string() }
    });
    let response = match &qop {
        Some(q) => md5_hex(&format!("{ha1}:{}:{nc}:{cnonce}:{q}:{ha2}", ch.nonce)),
        None => md5_hex(&format!("{ha1}:{}:{ha2}", ch.nonce)),
    };
    let mut h = format!(r#"Digest username="{user}", realm="{}", nonce="{}", uri="{uri}", response="{response}""#, ch.realm, ch.nonce);
    if let Some(q) = qop {
        h += &format!(r#", qop={q}, nc={nc}, cnonce="{cnonce}""#);
    }
    if let Some(o) = &ch.opaque {
        h += &format!(r#", opaque="{o}""#);
    }
    if let Some(a) = &ch.algorithm {
        h += &format!(", algorithm={a}");
    }
    h
}

async fn raw(method: &str, url: &str, headers: &[(String, String)], body: Option<&[u8]>, timeout: Duration) -> anyhow::Result<(u16, String, String, Vec<u8>)> {
    let mut rb = client().request(reqwest::Method::from_bytes(method.as_bytes())?, url).timeout(timeout).header("Connection", "close");
    for (k, v) in headers {
        rb = rb.header(k, v);
    }
    if let Some(b) = body {
        rb = rb.body(b.to_vec());
    }
    let res = rb.send().await.map_err(|e| anyhow::anyhow!("{}", describe(&e)))?;
    let status = res.status().as_u16();
    let www = res.headers().get_all("www-authenticate").iter().filter_map(|v| v.to_str().ok()).collect::<Vec<_>>().join(", ");
    let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = res.bytes().await?.to_vec();
    Ok((status, www, ct, body))
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return "Request timed out".into();
    }
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(x) = src {
        s = x.to_string();
        src = x.source();
    }
    s
}

pub async fn request(method: &str, url: &str, auth: Option<&Auth>, mut headers: Vec<(String, String)>, body: Option<&[u8]>, timeout: Duration) -> anyhow::Result<Resp> {
    let u = reqwest::Url::parse(url)?;
    let key = format!("{}://{}:{}", u.scheme(), u.host_str().unwrap_or(""), u.port_or_known_default().unwrap_or(0));
    let uri = match u.query() {
        Some(q) => format!("{}?{}", u.path(), q),
        None => u.path().to_string(),
    };
    let set_auth = |headers: &mut Vec<(String, String)>, v: String| {
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
        headers.push(("Authorization".into(), v));
    };
    match auth {
        Some(Auth::Basic(u, p)) => {
            use base64::Engine as _;
            set_auth(&mut headers, format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}"))))
        }
        Some(Auth::Bearer(t)) => set_auth(&mut headers, format!("Bearer {t}")),
        Some(Auth::Digest(u, p)) => {
            if let Some(ch) = challenges().lock().get_mut(&key) {
                let h = digest_header(ch, method, &uri, u, p);
                set_auth(&mut headers, h);
            }
        }
        None => {}
    }
    let (mut status, mut www, mut ct, mut body_out) = raw(method, url, &headers, body, timeout).await?;
    if status == 401 {
        if let Some(Auth::Digest(user, pass)) = auth {
            for _ in 0..2 {
                if !www.to_ascii_lowercase().contains("digest") {
                    break;
                }
                let part = www.split(", Basic").next().unwrap_or(&www).to_string();
                let mut ch = parse_challenge(&part);
                let h = digest_header(&mut ch, method, &uri, user, pass);
                challenges().lock().insert(key.clone(), ch);
                set_auth(&mut headers, h);
                let r = raw(method, url, &headers, body, timeout).await?;
                (status, www, ct, body_out) = r;
                if status != 401 || !www.to_ascii_lowercase().contains("stale=true") {
                    break;
                }
            }
        }
    }
    Ok(Resp { status, content_type: ct, body: body_out })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn digest_matches_rfc2617_example() {
        let mut ch = parse_challenge(r#"Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#);
        assert_eq!(ch.realm, "testrealm@host.com");
        let h = digest_header(&mut ch, "GET", "/dir/index.html", "Mufasa", "Circle Of Life");
        assert!(h.contains("qop=auth"));
        assert!(h.contains("nc=00000001"));
        assert!(h.contains(r#"opaque="5ccc069c403ebaf9f0171e9517f40e41""#));
    }
    #[test]
    fn lock_message() {
        let e = http_error(401, "<userCheck><lockStatus>lock</lockStatus><unlockTime>125</unlockTime></userCheck>");
        assert!(e.auth_failure);
        assert!(e.msg.contains("3 more minute"));
    }
}
