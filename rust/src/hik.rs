//! Port of src/main/hikvision.js (ISAPI over HTTP; the SDK transport on port 8000 is not ported yet).
//! Camera id `${deviceId}:${channel}`; stream track = channel*100 + streamNo.
use std::collections::BTreeMap;
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};

use crate::http::{http_error, request, Auth, Resp};
use crate::xml::{self, arr, num, s, truthy};

pub struct Hik {
    pub id: String,
    host: String,
    user: String,
    pass: String,
    pub rtsp_port: u16,
    base: String,
    auth: Auth,
}

fn iso_compact(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y%m%dT%H%M%SZ").to_string()
}

impl Hik {
    pub fn new(cfg: &Value) -> anyhow::Result<Hik> {
        if cfg["transport"] == "sdk" {
            anyhow::bail!("The Hikvision SDK connection (port 8000) is not in the Rust test build yet; switch the device to ISAPI");
        }
        let host = cfg["host"].as_str().unwrap_or("").to_string();
        let port = cfg["port"].as_u64().or_else(|| cfg["port"].as_str().and_then(|p| p.parse().ok())).unwrap_or(80);
        let https = cfg["https"] == true;
        let user = cfg["username"].as_str().unwrap_or("").to_string();
        let pass = cfg["password"].as_str().unwrap_or("").to_string();
        let port_of = |k: &str| cfg[k].as_u64().or_else(|| cfg[k].as_str().and_then(|p| p.parse().ok())).filter(|p| *p > 0);
        Ok(Hik {
            id: cfg["id"].as_str().unwrap_or("tmp").to_string(),
            rtsp_port: port_of("rtspPort").or_else(|| port_of("detectedRtspPort")).unwrap_or(554) as u16,
            base: format!("{}://{host}:{port}", if https { "https" } else { "http" }),
            auth: Auth::Digest(user.clone(), pass.clone()),
            host,
            user,
            pass,
        })
    }

    async fn get(&self, path: &str, timeout_ms: u64) -> anyhow::Result<Resp> {
        let r = request("GET", &(self.base.clone() + path), Some(&self.auth), vec![], None, Duration::from_millis(timeout_ms)).await?;
        if r.status >= 400 {
            return Err(http_error(r.status, &r.text()).into());
        }
        Ok(r)
    }
    pub async fn xml(&self, path: &str) -> anyhow::Result<Value> {
        xml::parse(&self.get(path, 12000).await?.text())
    }

    pub async fn device_info(&self) -> anyhow::Result<Value> {
        let x = self.xml("/ISAPI/System/deviceInfo").await?;
        let d = &x["DeviceInfo"];
        Ok(json!({
            "name": s(&d["deviceName"]), "model": s(&d["model"]), "serial": s(&d["serialNumber"]), "mac": s(&d["macAddress"]),
            "firmware": format!("{} {}", s(&d["firmwareVersion"]), s(&d["firmwareReleasedDate"])).trim(),
            "deviceType": s(&d["deviceType"]), "hardware": s(&d["hardwareVersion"]), "encoder": s(&d["encoderVersion"]),
        }))
    }

    pub async fn probe(&mut self) -> anyhow::Result<Value> {
        let mut info = self.device_info().await?;
        if let Ok(x) = self.xml("/ISAPI/Security/adminAccesses").await {
            for p in arr(&x["AdminAccessProtocolList"]["AdminAccessProtocol"]) {
                let enabled = p["enabled"].is_null() || truthy(&p["enabled"]);
                if s(&p["protocol"]).eq_ignore_ascii_case("rtsp") && enabled {
                    if let Some(n) = num(&p["portNo"]) {
                        self.rtsp_port = n as u16;
                    }
                }
            }
        }
        let o = info.as_object_mut().unwrap();
        o.insert("rtspPort".into(), self.rtsp_port.into());
        o.insert("vendor".into(), "hikvision".into());
        o.insert("transport".into(), "isapi".into());
        Ok(info)
    }

    pub async fn cameras(&self) -> anyhow::Result<Vec<Value>> {
        // stream metadata (codec/resolution) per video input channel
        let mut stream_info: BTreeMap<i64, BTreeMap<i64, Value>> = BTreeMap::new();
        if let Ok(sx) = self.xml("/ISAPI/Streaming/channels").await {
            for sc in arr(&sx["StreamingChannelList"]["StreamingChannel"]) {
                let id = num(&sc["id"]).unwrap_or(0.0) as i64;
                let v = &sc["Video"];
                let mut e = json!({
                    "codec": s(&v["videoCodecType"]), "width": num(&v["videoResolutionWidth"]), "height": num(&v["videoResolutionHeight"]),
                    "enabled": sc["enabled"].is_null() || truthy(&sc["enabled"]), "name": s(&sc["channelName"]),
                });
                if let Some(f) = num(&v["maxFrameRate"]) {
                    e["fps"] = (f / 100.0).into();
                }
                stream_info.entry(id / 100).or_default().insert(id % 100, e);
            }
        }
        let mut cams: BTreeMap<i64, Value> = BTreeMap::new();
        if let Ok(vx) = self.xml("/ISAPI/System/Video/inputs/channels").await {
            for vc in arr(&vx["VideoInputChannelList"]["VideoInputChannel"]) {
                let ch = num(&vc["id"]).unwrap_or(0.0) as i64;
                let name = Some(s(&vc["name"])).filter(|n| !n.is_empty()).unwrap_or(format!("Camera {ch}"));
                cams.insert(ch, json!({ "channel": ch, "name": name, "kind": "analog", "online": true, "ip": null }));
            }
        }
        let proxies = self.xml("/ISAPI/ContentMgmt/InputProxy/channels").await.map(|x| arr(&x["InputProxyChannelList"]["InputProxyChannel"])).unwrap_or_default();
        if !proxies.is_empty() {
            for pc in &proxies {
                let ch = num(&pc["id"]).unwrap_or(0.0) as i64;
                let d = &pc["sourceInputPortDescriptor"];
                let ip = Some(s(&d["ipAddress"])).filter(|x| !x.is_empty()).or_else(|| Some(s(&d["hostName"])).filter(|x| !x.is_empty()));
                let name = Some(s(&pc["name"])).filter(|n| !n.is_empty()).unwrap_or(format!("Camera {ch}"));
                cams.insert(ch, json!({ "channel": ch, "name": name, "kind": "ip", "online": null, "ip": ip, "protocol": s(&d["proxyProtocol"]) }));
            }
            if let Ok(st) = self.xml("/ISAPI/ContentMgmt/InputProxy/channels/status").await {
                for x in arr(&st["InputProxyChannelStatusList"]["InputProxyChannelStatus"]) {
                    if let Some(c) = cams.get_mut(&(num(&x["id"]).unwrap_or(0.0) as i64)) {
                        c["online"] = truthy(&x["online"]).into();
                        let ip = s(&x["sourceInputPortDescriptor"]["ipAddress"]);
                        if !ip.is_empty() {
                            c["ip"] = ip.into();
                        }
                    }
                }
            }
        }
        let mut out = vec![];
        for (ch, mut c) in cams {
            let si = stream_info.get(&ch);
            let stream = |n: i64| si.and_then(|m| m.get(&n)).map(|e| { let mut e = e.clone(); e["track"] = (ch * 100 + n).into(); e });
            let main = stream(1).unwrap_or_else(|| json!({ "track": ch * 100 + 1 }));
            if c["online"].is_null() {
                c["online"] = (main["enabled"] == true).into();
            }
            c["streams"] = json!({ "main": main, "sub": stream(2), "third": stream(3) });
            c["id"] = format!("{}:{ch}", self.id).into();
            c["deviceId"] = self.id.clone().into();
            c["vendor"] = "hikvision".into();
            out.push(c);
        }
        Ok(out)
    }

    fn creds(&self) -> String {
        format!("{}:{}@", utf8_percent_encode(&self.user, NON_ALPHANUMERIC), utf8_percent_encode(&self.pass, NON_ALPHANUMERIC))
    }
    pub fn live_url(&self, channel: i64, stream: &str) -> String {
        let n = match stream { "main" => 1, "third" => 3, _ => 2 };
        format!("rtsp://{}{}:{}/Streaming/Channels/{}", self.creds(), self.host, self.rtsp_port, channel * 100 + n)
    }
    pub fn playback_url(&self, channel: i64, start_ms: i64, end_ms: Option<i64>) -> String {
        let mut u = format!("rtsp://{}{}:{}/Streaming/tracks/{}?starttime={}", self.creds(), self.host, self.rtsp_port, channel * 100 + 1, iso_compact(start_ms));
        if let Some(e) = end_ms {
            u += &format!("&endtime={}", iso_compact(e));
        }
        u
    }
    pub async fn snapshot(&self, channel: i64, stream: &str) -> anyhow::Result<Resp> {
        let n = if stream == "main" { 1 } else { 2 };
        self.get(&format!("/ISAPI/Streaming/channels/{}/picture", channel * 100 + n), 15000).await
    }
}
