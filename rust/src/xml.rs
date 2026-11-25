//! XML → JSON shaped like fast-xml-parser's output in the JS drivers (`ignoreAttributes: false`, `@_` attribute prefix,
//! `parseTagValue: false`, trimmed): leaf elements become strings, repeated elements arrays, attributes `@_name`.
use serde_json::{Map, Value};

pub fn parse(text: &str) -> anyhow::Result<Value> {
    let doc = roxmltree::Document::parse(text)?;
    let root = doc.root_element();
    let mut out = Map::new();
    out.insert(root.tag_name().name().to_string(), node(root));
    Ok(Value::Object(out))
}

fn node(n: roxmltree::Node) -> Value {
    let mut map = Map::new();
    for a in n.attributes() {
        map.insert(format!("@_{}", a.name()), a.value().into());
    }
    let mut text = String::new();
    for c in n.children() {
        if c.is_element() {
            let k = c.tag_name().name().to_string();
            let v = node(c);
            match map.get_mut(&k) {
                Some(Value::Array(a)) => a.push(v),
                Some(old) => *old = Value::Array(vec![old.take(), v]),
                None => {
                    map.insert(k, v);
                }
            }
        } else if c.is_text() {
            text.push_str(c.text().unwrap_or(""));
        }
    }
    let text = text.trim();
    if map.is_empty() {
        return Value::String(text.to_string());
    }
    if !text.is_empty() {
        map.insert("#text".into(), text.into());
    }
    Value::Object(map)
}

/// fast-xml-parser's single-or-array: `asArray(x)` in the JS drivers.
pub fn arr(v: &Value) -> Vec<Value> {
    match v {
        Value::Null => vec![],
        Value::Array(a) => a.clone(),
        x => vec![x.clone()],
    }
}
pub fn s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.get("#text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
        Value::Null => String::new(),
        x => x.to_string(),
    }
}
pub fn num(v: &Value) -> Option<f64> {
    s(v).trim().parse().ok()
}
pub fn truthy(v: &Value) -> bool {
    s(v).eq_ignore_ascii_case("true")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shapes_like_fast_xml_parser() {
        let v = parse(r#"<List version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><Ch><id>1</id></Ch><Ch><id>2</id><name size="32"> a </name></Ch></List>"#).unwrap();
        let chs = arr(&v["List"]["Ch"]);
        assert_eq!(chs.len(), 2);
        assert_eq!(chs[0]["id"], "1");
        assert_eq!(v["List"]["@_version"], "2.0");
        assert_eq!(s(&chs[1]["name"]), "a");
        assert_eq!(chs[1]["name"]["@_size"], "32");
    }
}
