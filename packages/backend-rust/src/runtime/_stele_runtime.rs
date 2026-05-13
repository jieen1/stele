// _stele_runtime.rs — Stele contract management runtime for Rust
//
// This file is embedded into each generated test file via #[path] attribute.
// It provides the dynamic value model, path access, operator implementations,
// failure witness emission, and scenario/checker infrastructure.
//
// Dependencies: serde (derive), serde_json, regex, once_cell

use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// SteleFloat — Ord wrapper for f64
// ---------------------------------------------------------------------------

/// Wrapper around f64 to provide `Ord` via bit-level tiebreaking for NaN.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SteleFloat(pub f64);

impl Eq for SteleFloat {}

impl PartialOrd for SteleFloat {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}

impl Ord for SteleFloat {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.0.partial_cmp(&other.0) {
            Some(ord) => ord,
            None => {
                if self.0.is_nan() && other.0.is_nan() {
                    self.0.to_bits().cmp(&other.0.to_bits())
                } else if self.0.is_nan() {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Less
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// SteleValue — dynamic value enum
// ---------------------------------------------------------------------------

/// Stele dynamic value. Equivalent to Python `object`, JS `unknown`, Go `interface{}`.
#[derive(Debug, Clone, PartialEq, PartialOrd, serde::Serialize, serde::Deserialize)]
pub enum SteleValue {
    Absent,
    Null,
    Bool(bool),
    Int(i64),
    Float(SteleFloat),
    Str(String),
    List(Vec<SteleValue>),
    Map(BTreeMap<String, SteleValue>),
}

impl Eq for SteleValue {}

impl Ord for SteleValue {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.partial_cmp(other).unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl SteleValue {
    /// Extract the string value. Only `Some` when `self` is `SteleValue::Str`.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            SteleValue::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Extract f64 from Int or Float. Returns Err for non-numeric types.
    pub fn to_f64(&self) -> Result<f64, SteleRuntimeError> {
        match self {
            SteleValue::Int(n) => Ok(*n as f64),
            SteleValue::Float(f) => Ok(f.0),
            _ => Err(SteleRuntimeError::new(format!("expected number, got {:?}", self))),
        }
    }

    /// Extract i64 from Int. Returns Err for non-Int types.
    pub fn to_i64(&self) -> Result<i64, SteleRuntimeError> {
        match self {
            SteleValue::Int(n) => Ok(*n),
            _ => Err(SteleRuntimeError::new(format!("expected integer, got {:?}", self))),
        }
    }
}

// ---------------------------------------------------------------------------
// SteleCmp — three-way comparison result
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SteleCmp {
    Less,
    Eq,
    Greater,
}

// ---------------------------------------------------------------------------
// SteleRuntimeError / SteleAssertionError
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct SteleRuntimeError {
    pub message: String,
    pub context: Option<SteleValue>,
}

impl SteleRuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            context: None,
        }
    }

    pub fn with_context(message: impl Into<String>, context: SteleValue) -> Self {
        Self {
            message: message.into(),
            context: Some(context),
        }
    }
}

impl std::fmt::Display for SteleRuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SteleRuntimeError: {}", self.message)
    }
}

impl std::error::Error for SteleRuntimeError {}

#[derive(Debug)]
pub struct SteleAssertionError {
    pub message: String,
    pub witness: FailureWitness,
}

impl SteleAssertionError {
    pub fn new(message: impl Into<String>, witness: FailureWitness) -> Self {
        Self {
            message: message.into(),
            witness,
        }
    }
}

impl std::fmt::Display for SteleAssertionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SteleAssertionError: {}", self.message)
    }
}

impl std::error::Error for SteleAssertionError {}

// ---------------------------------------------------------------------------
// Path access
// ---------------------------------------------------------------------------

/// Navigate a path through nested SteleValue::Map structures.
/// Returns `Err` when the path is not found.
/// Supports kebab-case to snake_case fallback on each segment.
pub fn stele_get_path(obj: &SteleValue, segments: &[&str]) -> Result<SteleValue, SteleRuntimeError> {
    let mut current = obj;
    for &seg in segments {
        if let SteleValue::Map(ref map) = current {
            if let Some(val) = map.get(seg) {
                current = val;
                continue;
            }
            let snake = seg.replace('-', "_");
            if let Some(val) = map.get(&snake) {
                current = val;
                continue;
            }
            return Err(SteleRuntimeError::new(format!(
                "path not found: segment {:?} on Map with keys {:?}",
                seg,
                map.keys().collect::<Vec<_>>()
            )));
        } else {
            return Err(SteleRuntimeError::new(format!(
                "path navigation hit non-Map at segment {:?} (got {:?})",
                seg, current
            )));
        }
    }
    Ok(current.clone())
}

/// Borrowing version of stele_get_path. Returns Err when the path is not found.
pub fn stele_get_path_ref<'a>(
    obj: &'a SteleValue,
    segments: &[&str],
) -> Result<&'a SteleValue, SteleRuntimeError> {
    let mut current = obj;
    for &seg in segments {
        if let SteleValue::Map(ref map) = current {
            if let Some(val) = map.get(seg) {
                current = val;
                continue;
            }
            let snake = seg.replace('-', "_");
            if let Some(val) = map.get(&snake) {
                current = val;
                continue;
            }
            return Err(SteleRuntimeError::new(format!(
                "path not found: segment {:?} on Map with keys {:?}",
                seg,
                map.keys().collect::<Vec<_>>()
            )));
        } else {
            return Err(SteleRuntimeError::new(format!(
                "path navigation hit non-Map at segment {:?} (got {:?})",
                seg, current
            )));
        }
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// Numeric comparison with type lifting
// ---------------------------------------------------------------------------

/// Three-way numeric comparison. Lifts Int to Float when either operand is Float.
/// Uses 1e-9 tolerance for floating-point equality (matches Python/TS/Go backends).
pub fn stele_numeric_cmp(a: &SteleValue, b: &SteleValue) -> Result<SteleCmp, SteleRuntimeError> {
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        return if ai < bi {
            Ok(SteleCmp::Less)
        } else if ai == bi {
            Ok(SteleCmp::Eq)
        } else {
            Ok(SteleCmp::Greater)
        };
    }
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    let diff = af - bf;
    if diff.abs() < 1e-9 {
        Ok(SteleCmp::Eq)
    } else if diff < 0.0 {
        Ok(SteleCmp::Less)
    } else {
        Ok(SteleCmp::Greater)
    }
}

// ---------------------------------------------------------------------------
// Comparison operators
// ---------------------------------------------------------------------------

pub fn stele_eq(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    Ok(stele_numeric_cmp(a, b)? == SteleCmp::Eq)
}

pub fn stele_neq(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    Ok(stele_numeric_cmp(a, b)? != SteleCmp::Eq)
}

pub fn stele_gt(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    Ok(stele_numeric_cmp(a, b)? == SteleCmp::Greater)
}

pub fn stele_gte(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let cmp = stele_numeric_cmp(a, b)?;
    Ok(cmp == SteleCmp::Greater || cmp == SteleCmp::Eq)
}

pub fn stele_lt(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    Ok(stele_numeric_cmp(a, b)? == SteleCmp::Less)
}

pub fn stele_lte(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let cmp = stele_numeric_cmp(a, b)?;
    Ok(cmp == SteleCmp::Less || cmp == SteleCmp::Eq)
}

// ---------------------------------------------------------------------------
// Arithmetic operators
// ---------------------------------------------------------------------------

pub fn stele_add(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        return Ok(SteleValue::Int(ai.saturating_add(*bi)));
    }
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af + bf)))
}

pub fn stele_sub(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        return Ok(SteleValue::Int(ai.saturating_sub(*bi)));
    }
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af - bf)))
}

pub fn stele_mul(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        return Ok(SteleValue::Int(ai.saturating_mul(*bi)));
    }
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af * bf)))
}

pub fn stele_div(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    if let SteleValue::Int(bi) = b {
        if *bi == 0 {
            return Err(SteleRuntimeError::new("division by zero"));
        }
    }
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    if bf == 0.0 {
        return Err(SteleRuntimeError::new("division by zero"));
    }
    Ok(SteleValue::Float(SteleFloat(af / bf)))
}

pub fn stele_neg(a: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    match a {
        SteleValue::Int(n) => Ok(SteleValue::Int(n.saturating_neg())),
        SteleValue::Float(f) => Ok(SteleValue::Float(SteleFloat(-f.0))),
        _ => Err(SteleRuntimeError::new(format!("expected number, got {:?}", a))),
    }
}

pub fn stele_abs(a: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    match a {
        SteleValue::Int(n) => Ok(SteleValue::Int(if *n == i64::MIN { i64::MAX } else { n.abs() })),
        SteleValue::Float(f) => Ok(SteleValue::Float(SteleFloat(f.0.abs()))),
        _ => Err(SteleRuntimeError::new(format!("expected number, got {:?}", a))),
    }
}

pub fn stele_mod(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    if let (SteleValue::Int(ai), SteleValue::Int(bi)) = (a, b) {
        if *bi == 0 {
            return Err(SteleRuntimeError::new("modulo by zero"));
        }
        let result = ((ai % bi) + bi) % bi;
        return Ok(SteleValue::Int(result));
    }
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    if bf == 0.0 {
        return Err(SteleRuntimeError::new("modulo by zero"));
    }
    let result = ((af % bf) + bf) % bf;
    Ok(SteleValue::Float(SteleFloat(result)))
}

pub fn stele_pow(a: &SteleValue, b: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let af = a.to_f64()?;
    let bf = b.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af.powf(bf))))
}

pub fn stele_round(a: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let af = a.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af.round())))
}

pub fn stele_ceil(a: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let af = a.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af.ceil())))
}

pub fn stele_floor(a: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let af = a.to_f64()?;
    Ok(SteleValue::Float(SteleFloat(af.floor())))
}

// ---------------------------------------------------------------------------
// Aggregate operators
// ---------------------------------------------------------------------------

pub fn stele_sum(items: &SteleValue, path: &[&str]) -> Result<SteleValue, SteleRuntimeError> {
    let vec = match items {
        SteleValue::List(v) => v,
        _ => return Err(SteleRuntimeError::new("expected list for sum")),
    };
    let mut int_total: i64 = 0;
    let mut float_total: f64 = 0.0;
    let mut has_float = false;
    let mut is_first = true;

    for item in vec {
        let val = match stele_get_path(item, path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match val {
            SteleValue::Int(n) => {
                if has_float {
                    float_total += n as f64;
                } else {
                    int_total = int_total.saturating_add(n);
                }
            }
            _ => {
                if is_first && !has_float {
                    float_total = int_total as f64 + val.to_f64()?;
                    has_float = true;
                } else {
                    float_total += val.to_f64()?;
                    has_float = true;
                }
            }
        }
        is_first = false;
    }

    if has_float {
        Ok(SteleValue::Float(SteleFloat(float_total)))
    } else {
        Ok(SteleValue::Int(int_total))
    }
}

pub fn stele_count(items: &SteleValue) -> usize {
    match items {
        SteleValue::List(v) => v.len(),
        _ => 0,
    }
}

pub fn stele_avg(items: &SteleValue, path: &[&str]) -> Result<SteleValue, SteleRuntimeError> {
    let vec = match items {
        SteleValue::List(v) => v,
        _ => return Ok(SteleValue::Int(0)),
    };
    let mut sum = 0.0;
    let mut count = 0usize;
    for item in vec {
        let val = match stele_get_path(item, path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        sum += val.to_f64()?;
        count += 1;
    }
    if count == 0 {
        return Ok(SteleValue::Int(0));
    }
    Ok(SteleValue::Float(SteleFloat(sum / count as f64)))
}

pub fn stele_min(items: &SteleValue, path: &[&str]) -> Result<SteleValue, SteleRuntimeError> {
    let vec = match items {
        SteleValue::List(v) => v,
        _ => return Err(SteleRuntimeError::new("expected list for min")),
    };
    let mut min_val: Option<SteleValue> = None;
    for item in vec {
        let val = match stele_get_path(item, path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match min_val {
            None => min_val = Some(val),
            Some(ref current) => {
                if stele_numeric_cmp(&val, current)? == SteleCmp::Less {
                    min_val = Some(val);
                }
            }
        }
    }
    min_val.ok_or_else(|| SteleRuntimeError::new("cannot find min of empty collection"))
}

pub fn stele_max(items: &SteleValue, path: &[&str]) -> Result<SteleValue, SteleRuntimeError> {
    let vec = match items {
        SteleValue::List(v) => v,
        _ => return Err(SteleRuntimeError::new("expected list for max")),
    };
    let mut max_val: Option<SteleValue> = None;
    for item in vec {
        let val = match stele_get_path(item, path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match max_val {
            None => max_val = Some(val),
            Some(ref current) => {
                if stele_numeric_cmp(&val, current)? == SteleCmp::Greater {
                    max_val = Some(val);
                }
            }
        }
    }
    max_val.ok_or_else(|| SteleRuntimeError::new("cannot find max of empty collection"))
}

pub fn stele_distinct(items: &SteleValue, path: &[&str]) -> Vec<SteleValue> {
    let vec = match items {
        SteleValue::List(v) => v,
        _ => return Vec::new(),
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut result = Vec::new();
    for item in vec {
        let val = match stele_get_path(item, path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if seen.insert(val.clone()) {
            result.push(val);
        }
    }
    result
}

pub fn stele_has_length(items: &[SteleValue], expected: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let exp = expected.to_i64()? as usize;
    Ok(items.len() == exp)
}

pub fn stele_is_empty(items: &[SteleValue]) -> bool {
    items.is_empty()
}

pub fn stele_exists_in(value: &SteleValue, items: &[SteleValue]) -> bool {
    items.iter().any(|item| {
        if let SteleValue::Map(ref map) = item {
            map.values().any(|v| stele_numeric_cmp(v, value).is_ok_and(|c| c == SteleCmp::Eq)
                || v == value)
        } else {
            stele_numeric_cmp(item, value).is_ok_and(|c| c == SteleCmp::Eq)
                || item == value
        }
    })
}

/// Check that all elements in the collection are unique.
/// Returns true if all values are distinct, false if there are duplicates.
pub fn stele_unique(items: &[SteleValue], path: &[&str]) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let val = match stele_get_path_ref(item, path) {
            Ok(v) => v.clone(),
            Err(_) => continue,
        };
        if !seen.insert(val) {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// String operators
// ---------------------------------------------------------------------------

pub fn stele_contains(value: &SteleValue, substr: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let sub = substr.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(s.contains(sub))
}

pub fn stele_starts_with(value: &SteleValue, prefix: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let p = prefix.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(s.starts_with(p))
}

pub fn stele_ends_with(value: &SteleValue, suffix: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let sfx = suffix.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(s.ends_with(sfx))
}

pub fn stele_matches(value: &SteleValue, pattern: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let p = pattern.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    if has_redos_pattern(p) {
        return Err(SteleRuntimeError::new(format!(
            "potentially dangerous regex pattern: {}",
            p
        )));
    }
    let re = regex::Regex::new(p).map_err(|e| SteleRuntimeError::new(e.to_string()))?;
    Ok(re.is_match(s))
}

pub fn stele_trim(value: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(SteleValue::Str(s.trim().to_string()))
}

pub fn stele_lower(value: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(SteleValue::Str(s.to_lowercase()))
}

pub fn stele_upper(value: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    Ok(SteleValue::Str(s.to_uppercase()))
}

pub fn stele_split(value: &SteleValue, sep: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let s = value.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let separator = sep.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let parts: Vec<SteleValue> = s.split(separator).map(|s| SteleValue::Str(s.to_string())).collect();
    Ok(SteleValue::List(parts))
}

pub fn stele_join(items: &[SteleValue], sep: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let separator = sep.as_str().ok_or_else(|| SteleRuntimeError::new("expected string"))?;
    let parts: Result<Vec<&str>, _> = items
        .iter()
        .map(|v| v.as_str().ok_or_else(|| SteleRuntimeError::new("expected string in join items")))
        .collect();
    Ok(SteleValue::Str(parts?.join(separator)))
}

/// Extract a value from a JSON string using a simplified JSONPath expression.
pub fn stele_json_path(data: &SteleValue, path_expr: &SteleValue) -> Result<SteleValue, SteleRuntimeError> {
    let data_s = data.as_str().ok_or_else(|| SteleRuntimeError::new("json-path: expected string for data"))?;
    let path_s = path_expr.as_str().ok_or_else(|| SteleRuntimeError::new("json-path: expected string for path"))?;
    let root: serde_json::Value = serde_json::from_str(data_s)
        .map_err(|e| SteleRuntimeError::new(&format!("json-path: invalid JSON: {}", e)))?;
    let results = _stele_eval_json_path(&root, path_s);
    if results.len() == 1 {
        return Ok(SteleValue::Str(results[0].to_string()));
    }
    Ok(SteleValue::Str(serde_json::to_string(&results).unwrap_or_default()))
}

fn _stele_eval_json_path(data: &serde_json::Value, path: &str) -> Vec<String> {
    if path.is_empty() {
        return vec![data.to_string()];
    }
    let tokens = _stele_tokenize_path(path);
    if tokens.is_empty() {
        return vec![data.to_string()];
    }
    let rest: String = tokens[1..].iter().map(|t| match t {
        _JsonPathToken::Field(f) => format!(".{}", f),
        _JsonPathToken::Index(i) => format!("[{}]", i),
        _JsonPathToken::Wildcard => "[*]".to_string(),
    }).collect();
    match &tokens[0] {
        _JsonPathToken::Field(f) => {
            if let Some(v) = data.get(f) {
                return _stele_eval_json_path(v, &rest);
            }
            return vec![];
        }
        _JsonPathToken::Index(i) => {
            if let Some(arr) = data.as_array() {
                if let Some(v) = arr.get(*i as usize) {
                    return _stele_eval_json_path(v, &rest);
                }
            }
            return vec![];
        }
        _JsonPathToken::Wildcard => {
            if let Some(arr) = data.as_array() {
                let mut all = Vec::new();
                for item in arr {
                    all.extend(_stele_eval_json_path(item, &rest));
                }
                return all;
            }
            return vec![];
        }
    }
}

enum _JsonPathToken {
    Field(String),
    Index(i64),
    Wildcard,
}

fn _stele_tokenize_path(path: &str) -> Vec<_JsonPathToken> {
    let mut tokens = Vec::new();
    let mut chars = path.chars().peekable();
    while chars.peek().is_some() {
        if chars.peek() == Some(&'.') {
            chars.next();
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            let mut inner = String::new();
            while let Some(&c) = chars.peek() {
                if c == ']' {
                    chars.next();
                    break;
                }
                inner.push(chars.next().unwrap());
            }
            if inner == "*" {
                tokens.push(_JsonPathToken::Wildcard);
            } else if let Ok(idx) = inner.parse::<i64>() {
                tokens.push(_JsonPathToken::Index(idx));
            }
            continue;
        }
        let mut name = String::new();
        while let Some(&c) = chars.peek() {
            if c == '.' || c == '[' {
                break;
            }
            name.push(chars.next().unwrap());
        }
        if !name.is_empty() {
            tokens.push(_JsonPathToken::Field(name));
        }
    }
    tokens
}

// ---------------------------------------------------------------------------
// Control operators
// ---------------------------------------------------------------------------

pub fn stele_not_null(value: &SteleValue) -> bool {
    !matches!(value, SteleValue::Null | SteleValue::Absent)
}

pub fn stele_between(
    value: &SteleValue,
    low: &SteleValue,
    high: &SteleValue,
) -> Result<bool, SteleRuntimeError> {
    let cmp_low = stele_numeric_cmp(value, low)?;
    let cmp_high = stele_numeric_cmp(value, high)?;
    Ok(
        (cmp_low == SteleCmp::Greater || cmp_low == SteleCmp::Eq)
            && (cmp_high == SteleCmp::Less || cmp_high == SteleCmp::Eq),
    )
}

pub fn stele_approx_eq(
    value: &SteleValue,
    target: &SteleValue,
    tolerance: &SteleValue,
) -> Result<bool, SteleRuntimeError> {
    let v = value.to_f64()?;
    let t = target.to_f64()?;
    let tol = tolerance.to_f64()?;
    Ok((v - t).abs() <= tol)
}

/// Compare two numbers with exact decimal precision, avoiding floating point errors.
pub fn stele_decimal_eq(
    left: &SteleValue,
    right: &SteleValue,
) -> Result<bool, SteleRuntimeError> {
    let l = left.to_f64()?;
    let r = right.to_f64()?;
    let l_str = format_decimal(l);
    let r_str = format_decimal(r);
    Ok(l_str == r_str)
}

fn format_decimal(v: f64) -> String {
    if v == v as i64 as f64 {
        return format!("{}", v as i64);
    }
    let s = format!("{:.20}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    s
}

// ---------------------------------------------------------------------------
// Collection operators (EP04)
// ---------------------------------------------------------------------------

pub fn stele_length(items: &[SteleValue]) -> SteleValue {
    SteleValue::Int(items.len() as i64)
}

pub fn stele_concat(collections: &[&[SteleValue]]) -> Vec<SteleValue> {
    let mut result = Vec::new();
    for coll in collections {
        result.extend(coll.iter().cloned());
    }
    result
}

pub fn stele_sort_by(items: &[SteleValue], path: &[&str]) -> Vec<SteleValue> {
    let mut sorted: Vec<&SteleValue> = items.iter().collect();
    sorted.sort_by(|a, b| {
        let va = stele_get_path(a, path).unwrap_or(SteleValue::Absent);
        let vb = stele_get_path(b, path).unwrap_or(SteleValue::Absent);
        va.cmp(&vb)
    });
    sorted.into_iter().cloned().collect()
}

pub fn stele_sort_by_desc(items: &[SteleValue], path: &[&str]) -> Vec<SteleValue> {
    let mut sorted: Vec<&SteleValue> = items.iter().collect();
    sorted.sort_by(|a, b| {
        let va = stele_get_path(a, path).unwrap_or(SteleValue::Absent);
        let vb = stele_get_path(b, path).unwrap_or(SteleValue::Absent);
        vb.cmp(&va)
    });
    sorted.into_iter().cloned().collect()
}

pub fn stele_map(items: &[SteleValue], path: &[&str]) -> Vec<SteleValue> {
    items.iter().map(|item| stele_get_path(item, path).unwrap_or(SteleValue::Absent)).collect()
}

pub fn stele_first(items: &[SteleValue]) -> SteleValue {
    items.first().cloned().unwrap_or(SteleValue::Absent)
}

pub fn stele_last(items: &[SteleValue]) -> SteleValue {
    items.last().cloned().unwrap_or(SteleValue::Absent)
}

pub fn stele_type_of(value: &SteleValue) -> SteleValue {
    match value {
        SteleValue::Absent => SteleValue::Str("absent".to_string()),
        SteleValue::Null => SteleValue::Str("null".to_string()),
        SteleValue::Bool(_) => SteleValue::Str("boolean".to_string()),
        SteleValue::Int(_) => SteleValue::Str("integer".to_string()),
        SteleValue::Float(_) => SteleValue::Str("float".to_string()),
        SteleValue::Str(_) => SteleValue::Str("string".to_string()),
        SteleValue::List(_) => SteleValue::Str("list".to_string()),
        SteleValue::Map(_) => SteleValue::Str("map".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Quantifier operators (forall / exists / where / none)
// ---------------------------------------------------------------------------

thread_local! {
    static WITNESS_INDEX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
}

fn next_witness_index() -> usize {
    WITNESS_INDEX.with(|idx| idx.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

#[derive(Debug, serde::Serialize)]
pub struct FailureWitness {
    pub operator: String,
    pub collection_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_at_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_item: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicate_source: Option<String>,
    pub truncated: bool,
}

pub fn emit_witness(witness: &FailureWitness, test_name: &str) {
    let dir = match std::env::var("STELE_WITNESS_DIR") {
        Ok(d) => d,
        Err(_) => return,
    };
    let index = next_witness_index();
    let filename = format!("witness-{}-{}-{}.json", test_name, witness.operator, index);
    let path = std::path::Path::new(&dir).join(filename);
    match serde_json::to_string(witness) {
        Ok(json) => {
            let _ = std::fs::write(&path, json);
        }
        Err(_) => {}
    }
}

pub fn stele_forall<F>(
    items: &[SteleValue],
    pred: F,
    pred_source: &str,
    test_name: &str,
) -> Result<(), SteleAssertionError>
where
    F: Fn(&SteleValue) -> bool,
{
    for (i, item) in items.iter().enumerate() {
        if !pred(item) {
            let witness = FailureWitness {
                operator: "forall".to_string(),
                collection_size: items.len(),
                failed_at_index: Some(i),
                failed_item: Some(safe_serialize(item, 2)),
                predicate_source: Some(pred_source.to_string()),
                truncated: false,
            };
            emit_witness(&witness, test_name);
            return Err(SteleAssertionError::new(format!("forall failed at index {}", i), witness));
        }
    }
    Ok(())
}

pub fn stele_exists<F>(
    items: &[SteleValue],
    pred: F,
    pred_source: &str,
    test_name: &str,
) -> Result<(), SteleAssertionError>
where
    F: Fn(&SteleValue) -> bool,
{
    for (_i, item) in items.iter().enumerate() {
        if pred(item) {
            return Ok(());
        }
    }
    let witness = FailureWitness {
        operator: "exists".to_string(),
        collection_size: items.len(),
        failed_at_index: None,
        failed_item: None,
        predicate_source: Some(pred_source.to_string()),
        truncated: false,
    };
    emit_witness(&witness, test_name);
    Err(SteleAssertionError::new("exists: no element satisfied predicate", witness))
}

pub fn stele_where<F>(items: &[SteleValue], pred: F) -> Vec<SteleValue>
where
    F: Fn(&SteleValue) -> bool,
{
    items.iter().filter(|item| pred(item)).cloned().collect()
}

pub fn stele_none<F>(
    items: &[SteleValue],
    pred: F,
    pred_source: &str,
    test_name: &str,
) -> Result<(), SteleAssertionError>
where
    F: Fn(&SteleValue) -> bool,
{
    for (i, item) in items.iter().enumerate() {
        if pred(item) {
            let witness = FailureWitness {
                operator: "none".to_string(),
                collection_size: items.len(),
                failed_at_index: Some(i),
                failed_item: Some(safe_serialize(item, 2)),
                predicate_source: Some(pred_source.to_string()),
                truncated: false,
            };
            emit_witness(&witness, test_name);
            return Err(SteleAssertionError::new(format!("none failed at index {}", i), witness));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Temporal operators
// ---------------------------------------------------------------------------

pub fn stele_is_modified(ctx: &SteleValue, path: &[&str]) -> bool {
    let before = match stele_get_path(ctx, &["state_before"]) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let after = match stele_get_path(ctx, &["state_after"]) {
        Ok(v) => v,
        Err(_) => return false,
    };

    let before_val = match before {
        SteleValue::Map(_) => stele_get_path(&before, path).unwrap_or(SteleValue::Absent),
        _ => return false,
    };

    let after_val = match after {
        SteleValue::Map(_) => stele_get_path(&after, path).unwrap_or(SteleValue::Absent),
        _ => return false,
    };

    before_val != after_val
}

pub fn stele_state_before(ctx: &SteleValue) -> SteleValue {
    stele_get_path(ctx, &["state_before"]).unwrap_or(SteleValue::Absent)
}

pub fn stele_state_after(ctx: &SteleValue) -> SteleValue {
    stele_get_path(ctx, &["state_after"]).unwrap_or(SteleValue::Absent)
}

pub fn stele_within(event_timestamp: &SteleValue, duration_seconds: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let ts = event_timestamp.to_f64()?;
    let dur = duration_seconds.to_f64()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| SteleRuntimeError::new(e.to_string()))?
        .as_secs_f64();
    Ok(now - ts <= dur)
}

pub fn stele_before(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let va = a.to_f64()?;
    let vb = b.to_f64()?;
    Ok(va < vb)
}

pub fn stele_after(a: &SteleValue, b: &SteleValue) -> Result<bool, SteleRuntimeError> {
    let va = a.to_f64()?;
    let vb = b.to_f64()?;
    Ok(va > vb)
}

// ---------------------------------------------------------------------------
// Scenario / Checker
// ---------------------------------------------------------------------------

pub type CheckerFn = Box<dyn Fn(&[SteleValue], &SteleValue) -> CheckerResult + Send + Sync>;

pub struct CheckerResult {
    pub ok: bool,
    pub message: Option<String>,
    pub details: Option<SteleValue>,
}

pub fn stele_call_checker(
    checkers: &BTreeMap<String, CheckerFn>,
    name: &str,
    args: &[SteleValue],
    ctx: &SteleValue,
) -> Result<CheckerResult, SteleRuntimeError> {
    checkers
        .get(name)
        .map(|f| f(args, ctx))
        .ok_or_else(|| SteleRuntimeError::new(format!("checker {:?} not registered", name)))
}

/// Scenario step definition matching the conformance fixture schema.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ScenarioStep {
    #[serde(rename = "type")]
    pub step_type: String,
    pub path: Option<String>,
    pub expected: Option<SteleValue>,
    pub args: Vec<SteleValue>,
    #[serde(default)]
    pub function: String,
    #[serde(default)]
    pub module: String,
}

pub trait ScenarioRegistry {
    fn execute_step(
        &self,
        name: &str,
        args: &[SteleValue],
        ctx: &SteleValue,
    ) -> Result<SteleValue, SteleRuntimeError>;
}

pub fn stele_run_scenario<R: ScenarioRegistry>(
    registry: &R,
    steps: &[ScenarioStep],
    ctx: &mut SteleValue,
) -> Result<SteleValue, SteleRuntimeError> {
    for step in steps {
        match step.step_type.as_str() {
            "execute" => {
                let result = registry.execute_step(&step.function, &step.args, ctx)?;
                *ctx = merge_context(ctx, &result);
            }
            "capture-state" => {
                // Snapshot current state — the result is merged back into ctx
                let snapshot = SteleValue::Map(BTreeMap::from([
                    (
                        step.function.clone(),
                        ctx.clone(),
                    ),
                ]));
                *ctx = merge_context(ctx, &snapshot);
            }
            "import" => {
                assert_import_allowed(&step.module)?;
            }
            _ => {
                return Err(SteleRuntimeError::new(format!(
                    "unknown scenario step type: {:?}",
                    step.step_type
                )));
            }
        }
    }
    Ok(ctx.clone())
}

// ---------------------------------------------------------------------------
// Import allowlist
// ---------------------------------------------------------------------------

static STELE_ALLOWED_CRATES: once_cell::sync::Lazy<std::collections::HashSet<&'static str>> =
    once_cell::sync::Lazy::new(|| {
        [
            "stele_runtime",
            "serde",
            "serde_json",
            "std",
        ]
        .into_iter()
        .collect()
    });

static STELE_USER_CRATES: once_cell::sync::Lazy<std::collections::HashSet<String>> =
    once_cell::sync::Lazy::new(|| {
        std::env::var("STELE_USER_CRATES")
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
            .map(|s| s.trim().to_string())
            .collect()
    });

fn assert_import_allowed(module: &str) -> Result<(), SteleRuntimeError> {
    let crate_name = module.split("::").next().unwrap_or(module);
    if STELE_USER_CRATES.contains(crate_name) {
        return Ok(());
    }
    if !STELE_ALLOWED_CRATES.contains(crate_name) {
        return Err(SteleRuntimeError::new(format!(
            "Module {:?} is not in the Stele allowlist.",
            module
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/// Safe serialization with depth limiting. Returns JSON-like string.
pub fn safe_serialize(value: &SteleValue, max_depth: usize) -> String {
    safe_serialize_inner(value, max_depth, 0)
}

fn safe_serialize_inner(value: &SteleValue, max_depth: usize, current_depth: usize) -> String {
    if current_depth > max_depth {
        return "[truncated]".to_string();
    }
    match value {
        SteleValue::Absent => "null".to_string(),
        SteleValue::Null => "null".to_string(),
        SteleValue::Bool(b) => b.to_string(),
        SteleValue::Int(n) => n.to_string(),
        SteleValue::Float(f) => f.0.to_string(),
        SteleValue::Str(s) => {
            format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
        }
        SteleValue::List(items) => {
            let elems: Vec<String> = items
                .iter()
                .map(|item| safe_serialize_inner(item, max_depth, current_depth + 1))
                .collect();
            format!("[{}]", elems.join(", "))
        }
        SteleValue::Map(map) => {
            let pairs: Vec<String> = map
                .iter()
                .map(|(k, v)| {
                    format!(
                        "\"{}\": {}",
                        k.replace('\\', "\\\\").replace('"', "\\\""),
                        safe_serialize_inner(v, max_depth, current_depth + 1)
                    )
                })
                .collect();
            format!("{{{}}}", pairs.join(", "))
        }
    }
}

/// ReDoS heuristic: checks for nested quantifiers like `(a+)+` or `(a*)*`.
pub fn has_redos_pattern(pattern: &str) -> bool {
    pattern.contains("(+") || pattern.contains("(*)")
}

/// Shallow merge of two Map contexts (right wins). Falls back to right if not both Maps.
pub fn merge_context(left: &SteleValue, right: &SteleValue) -> SteleValue {
    match (left, right) {
        (SteleValue::Map(lm), SteleValue::Map(rm)) => {
            let mut merged = lm.clone();
            merged.extend(rm.clone());
            SteleValue::Map(merged)
        }
        (_, other) => other.clone(),
    }
}

/// Merge two contexts: steleMergeContexts equivalent.
pub fn stele_merge_contexts(left: &SteleValue, right: &SteleValue) -> SteleValue {
    merge_context(left, right)
}

// ---------------------------------------------------------------------------
// Context initialization
// ---------------------------------------------------------------------------

/// Type alias for the Stele context used in generated tests.
pub type SteleContext = SteleValue;

/// Load fixture data from `.stele_fixture.json` in the test directory,
/// or return an empty context if no fixture file exists.
/// The conformance runner writes this file via `writeFixtureBootstrap()`.
fn load_fixture_context() -> SteleContext {
    // Try to find the fixture file relative to the test directory.
    // `std::env::current_exe()` points to the cargo test runner binary.
    // The fixture lives at `tests/contract/.stele_fixture.json` from project root.
    let fixture_path = std::path::PathBuf::from(".stele_fixture.json");
    if fixture_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&fixture_path) {
            if let Ok(value) = serde_json::from_str::<SteleValue>(&data) {
                return value;
            }
        }
    }
    // Fallback: also check the parent `tests/contract/` directory
    let alt_path = std::path::PathBuf::from("tests/contract/.stele_fixture.json");
    if alt_path.exists() {
        if let Ok(data) = std::fs::read_to_string(&alt_path) {
            if let Ok(value) = serde_json::from_str::<SteleValue>(&data) {
                return value;
            }
        }
    }
    SteleValue::Map(BTreeMap::new())
}

/// Create a Stele context, loading fixture data if available.
/// Used by generated tests as the starting context for assertions.
pub fn stele_context() -> SteleContext {
    load_fixture_context()
}

/// Assert and return the context (used by generated checker tests).
pub fn stele_assert_context(ctx: &SteleValue) -> &SteleValue {
    ctx
}
