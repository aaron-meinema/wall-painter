use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif"];

/// Read any file and hand the raw bytes to the webview as an ArrayBuffer.
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

/// Write base64-encoded bytes (e.g. a PNG/JPEG from canvas.toDataURL) to disk.
#[tauri::command]
fn write_base64(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("Bad image data: {e}"))?;
    fs::write(&path, bytes).map_err(|e| format!("Could not write {path}: {e}"))
}

/// All images in the same folder as `path` (or in `path` if it is a folder), sorted by name.
#[tauri::command]
fn list_images(path: String) -> Result<Vec<String>, String> {
    let p = Path::new(&path);
    let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
    let mut out: Vec<String> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| IMAGE_EXTS.contains(&x.to_ascii_lowercase().as_str()))
                    .unwrap_or(false)
                && !p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with('.'))
                    .unwrap_or(true)
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort_by_key(|s| natural_key(s));
    Ok(out)
}

/// Sort "2.jpg" before "10.jpg".
fn natural_key(s: &str) -> Vec<(u8, u64, String)> {
    let mut key = Vec::new();
    let mut num = String::new();
    let mut txt = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !txt.is_empty() {
                key.push((1, 0, std::mem::take(&mut txt).to_lowercase()));
            }
            num.push(c);
        } else {
            if !num.is_empty() {
                key.push((0, num.parse().unwrap_or(u64::MAX), String::new()));
                num.clear();
            }
            txt.push(c);
        }
    }
    if !num.is_empty() {
        key.push((0, num.parse().unwrap_or(u64::MAX), String::new()));
    }
    if !txt.is_empty() {
        key.push((1, 0, txt.to_lowercase()));
    }
    key
}

#[tauri::command]
async fn pick_save(app: AppHandle, default_name: String, directory: Option<String>) -> Option<String> {
    let mut dlg = app
        .dialog()
        .file()
        .set_title("Export painted photo")
        .set_file_name(&default_name)
        .add_filter("PNG image", &["png"])
        .add_filter("JPEG image", &["jpg", "jpeg"]);
    if let Some(d) = directory {
        dlg = dlg.set_directory(d);
    }
    dlg.blocking_save_file()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

// ---- Projects: a folder of photos, with its work saved in a project file inside that folder ----

#[tauri::command]
async fn pick_folder(app: AppHandle, directory: Option<String>) -> Option<String> {
    let mut dlg = app.dialog().file().set_title("Open a folder of photos");
    if let Some(d) = directory {
        dlg = dlg.set_directory(d);
    }
    dlg.blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Read a text file; None if it doesn't exist.
#[tauri::command]
fn read_text(path: String) -> Result<Option<String>, String> {
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {path}: {e}")),
    }
}

/// Write a text file atomically (temp file + rename), so a crash never leaves half a project file.
#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    let f = PathBuf::from(&path);
    let tmp = f.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("Could not write {path}: {e}"))?;
    fs::rename(&tmp, &f).map_err(|e| format!("Could not write {path}: {e}"))
}

// ---- Old sessions (before projects): kept per photo in the app data folder. Only read, to import them. ----

fn session_file(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sessions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // FNV-1a: stable across builds, unlike std's DefaultHasher.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Ok(dir.join(format!("{h:016x}.json")))
}

#[tauri::command]
fn save_session(app: AppHandle, key: String, json: String) -> Result<(), String> {
    let f = session_file(&app, &key)?;
    let tmp = f.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let f = session_file(&app, &key)?;
    if !f.exists() {
        return Ok(None);
    }
    fs::read_to_string(&f).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_exists(app: AppHandle, key: String) -> bool {
    session_file(&app, &key).map(|f| f.exists()).unwrap_or(false)
}

#[tauri::command]
fn delete_session(app: AppHandle, key: String) -> Result<(), String> {
    let f = session_file(&app, &key)?;
    if f.exists() {
        fs::remove_file(f).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_base64,
            list_images,
            pick_save,
            pick_folder,
            is_dir,
            read_text,
            write_text,
            save_session,
            load_session,
            session_exists,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Wall Painter");
}
