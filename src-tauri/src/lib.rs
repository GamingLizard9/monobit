//! Monobit backend: file I/O, persistent app storage, and 1-bit image encoders.
//!
//! Rasters cross the bridge as base64 strings holding one byte per pixel:
//! `0` = transparent, `1` = black (ink), `2` = white (paper).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Deserialize;
use std::borrow::Cow;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const TRANSPARENT: u8 = 0;
const BLACK: u8 = 1;

#[derive(Deserialize)]
struct Raster {
    width: u32,
    height: u32,
    pixels: String,
}

struct Pixels {
    w: usize,
    h: usize,
    data: Vec<u8>,
}

impl Pixels {
    fn decode(r: &Raster) -> Result<Self, String> {
        let data = B64.decode(&r.pixels).map_err(|e| format!("bad pixel data: {e}"))?;
        let (w, h) = (r.width as usize, r.height as usize);
        if w == 0 || h == 0 || data.len() != w * h {
            return Err(format!("raster size mismatch ({}x{} vs {} bytes)", w, h, data.len()));
        }
        Ok(Self { w, h, data })
    }

    /// Nearest-neighbour upscale by an integer factor.
    fn scaled(&self, scale: u32) -> Self {
        let s = scale.clamp(1, 64) as usize;
        if s == 1 {
            return Self { w: self.w, h: self.h, data: self.data.clone() };
        }
        let (w, h) = (self.w * s, self.h * s);
        let mut data = vec![0u8; w * h];
        for y in 0..h {
            let src = (y / s) * self.w;
            let row = &mut data[y * w..(y + 1) * w];
            for (x, px) in row.iter_mut().enumerate() {
                *px = self.data[src + x / s];
            }
        }
        Self { w, h, data }
    }

    fn at(&self, x: usize, y: usize) -> u8 {
        self.data[y * self.w + x]
    }

    fn has_transparency(&self) -> bool {
        self.data.iter().any(|&p| p == TRANSPARENT)
    }
}

fn sanitize_symbol(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    if s.is_empty() || s.chars().next().unwrap().is_ascii_digit() {
        s.insert_str(0, "img_");
    }
    s
}

/// Writes atomically: to a temp file next to the target, then renames over it.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let tmp = path.with_extension("monobit-tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().ok();
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot save {}: {e}", path.display())
    })
}

// ---------------------------------------------------------------- encoders

fn encode_png(px: &Pixels) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, px.w as u32, px.h as u32);
        let transparent = px.has_transparency();
        let (bits, row_len) = if transparent { (2usize, (px.w * 2 + 7) / 8) } else { (1usize, (px.w + 7) / 8) };
        if transparent {
            // 2-bit indexed: 0 = transparent, 1 = black, 2 = white
            enc.set_color(png::ColorType::Indexed);
            enc.set_depth(png::BitDepth::Two);
            enc.set_palette(vec![0, 0, 0, 0, 0, 0, 255, 255, 255]);
            enc.set_trns(vec![0u8, 255, 255]);
        } else {
            // True 1-bit grayscale: tiny files, exactly two colours.
            enc.set_color(png::ColorType::Grayscale);
            enc.set_depth(png::BitDepth::One);
        }
        enc.set_compression(png::Compression::Best);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        let mut data = vec![0u8; row_len * px.h];
        for y in 0..px.h {
            for x in 0..px.w {
                let p = px.at(x, y);
                let v: u8 = if transparent { p.min(2) } else if p == BLACK { 0 } else { 1 };
                let bit = x * bits;
                let shift = 8 - bits - (bit % 8);
                data[y * row_len + bit / 8] |= v << shift;
            }
        }
        writer.write_image_data(&data).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn encode_bmp(px: &Pixels) -> Vec<u8> {
    let row = ((px.w + 31) / 32) * 4;
    let img_size = row * px.h;
    let offset = 14 + 40 + 8;
    let mut b = Vec::with_capacity(offset + img_size);
    b.extend_from_slice(b"BM");
    b.extend_from_slice(&((offset + img_size) as u32).to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&(offset as u32).to_le_bytes());
    b.extend_from_slice(&40u32.to_le_bytes());
    b.extend_from_slice(&(px.w as i32).to_le_bytes());
    b.extend_from_slice(&(px.h as i32).to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&0u32.to_le_bytes());
    b.extend_from_slice(&(img_size as u32).to_le_bytes());
    b.extend_from_slice(&2835u32.to_le_bytes());
    b.extend_from_slice(&2835u32.to_le_bytes());
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&2u32.to_le_bytes());
    b.extend_from_slice(&[0, 0, 0, 0, 255, 255, 255, 0]); // palette: black, white
    for y in (0..px.h).rev() {
        let mut line = vec![0u8; row];
        for x in 0..px.w {
            if px.at(x, y) != BLACK {
                line[x / 8] |= 0x80 >> (x % 8);
            }
        }
        b.extend_from_slice(&line);
    }
    b
}

/// Packs rows of ink bits (1 = black). `msb_first` matches Adafruit GFX / u8g2 drawBitmap,
/// `!msb_first` matches XBM.
fn pack_rows(px: &Pixels, msb_first: bool) -> Vec<u8> {
    let row = (px.w + 7) / 8;
    let mut out = vec![0u8; row * px.h];
    for y in 0..px.h {
        for x in 0..px.w {
            if px.at(x, y) == BLACK {
                let mask = if msb_first { 0x80 >> (x % 8) } else { 1 << (x % 8) };
                out[y * row + x / 8] |= mask;
            }
        }
    }
    out
}

fn hex_table(bytes: &[u8], per_line: usize) -> String {
    let mut s = String::new();
    for (i, chunk) in bytes.chunks(per_line).enumerate() {
        if i > 0 {
            s.push_str(",\n");
        }
        s.push_str("  ");
        s.push_str(&chunk.iter().map(|b| format!("0x{b:02x}")).collect::<Vec<_>>().join(", "));
    }
    s
}

fn encode_c_header(px: &Pixels, name: &str) -> String {
    let sym = sanitize_symbol(name);
    let up = sym.to_uppercase();
    let bytes = pack_rows(px, true);
    format!(
        "// {sym}.h - generated by Monobit\n\
         // {w}x{h} 1-bit bitmap, horizontal rows, MSB first, 1 = black ink.\n\
         // Compatible with Adafruit GFX drawBitmap() and u8g2 drawBitmap().\n\
         #pragma once\n\
         #include <stdint.h>\n\
         #ifndef PROGMEM\n#define PROGMEM\n#endif\n\n\
         #define {up}_WIDTH  {w}\n\
         #define {up}_HEIGHT {h}\n\n\
         const uint8_t {sym}[{len}] PROGMEM = {{\n{table}\n}};\n",
        w = px.w,
        h = px.h,
        len = bytes.len(),
        table = hex_table(&bytes, 12)
    )
}

fn encode_xbm(px: &Pixels, name: &str) -> String {
    let sym = sanitize_symbol(name);
    let bytes = pack_rows(px, false);
    format!(
        "#define {sym}_width {w}\n#define {sym}_height {h}\nstatic unsigned char {sym}_bits[] = {{\n{table}\n}};\n",
        w = px.w,
        h = px.h,
        table = hex_table(&bytes, 12)
    )
}

fn encode_pbm(px: &Pixels) -> Vec<u8> {
    let mut out = format!("P4\n# Monobit\n{} {}\n", px.w, px.h).into_bytes();
    out.extend(pack_rows(px, true));
    out
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    write_atomic(Path::new(&path), contents.as_bytes())
}

#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    Ok(B64.encode(bytes))
}

fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.len() < 96
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.starts_with('.');
    if !ok {
        return Err(format!("invalid store key: {name}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

/// Reads a JSON blob from the app data directory (library, settings, session).
#[tauri::command]
fn store_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let p = store_path(&app, &name)?;
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn store_write(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let p = store_path(&app, &name)?;
    write_atomic(&p, contents.as_bytes())
}

#[tauri::command]
fn store_delete(app: AppHandle, name: String) -> Result<(), String> {
    let p = store_path(&app, &name)?;
    match fs::remove_file(p) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
fn store_dir(app: AppHandle) -> Result<String, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.display().to_string())
}

/// A `.monobit` file passed on the command line (e.g. via file association).
#[tauri::command]
fn launch_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| a.to_lowercase().ends_with(".monobit") && Path::new(a).exists())
}

#[tauri::command]
fn export_image(path: String, format: String, raster: Raster, scale: u32, name: String) -> Result<u64, String> {
    let px = Pixels::decode(&raster)?;
    let bytes: Vec<u8> = match format.as_str() {
        "png" => encode_png(&px.scaled(scale))?,
        "bmp" => encode_bmp(&px.scaled(scale)),
        "pbm" => encode_pbm(&px.scaled(scale)),
        "h" => encode_c_header(&px, &name).into_bytes(),
        "xbm" => encode_xbm(&px, &name).into_bytes(),
        other => return Err(format!("unknown export format: {other}")),
    };
    let file = fs::File::create(&path).map_err(|e| format!("cannot write {path}: {e}"))?;
    let mut w = BufWriter::new(file);
    w.write_all(&bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(bytes.len() as u64)
}

/// Returns the encoded export as a string (for previews / copy-as-code).
#[tauri::command]
fn export_text(format: String, raster: Raster, name: String) -> Result<String, String> {
    let px = Pixels::decode(&raster)?;
    match format.as_str() {
        "h" => Ok(encode_c_header(&px, &name)),
        "xbm" => Ok(encode_xbm(&px, &name)),
        other => Err(format!("not a text format: {other}")),
    }
}

#[tauri::command]
fn copy_image(raster: Raster, scale: u32) -> Result<(), String> {
    let px = Pixels::decode(&raster)?.scaled(scale);
    let mut rgba = Vec::with_capacity(px.w * px.h * 4);
    for &p in &px.data {
        match p {
            TRANSPARENT => rgba.extend_from_slice(&[255, 255, 255, 0]),
            BLACK => rgba.extend_from_slice(&[0, 0, 0, 255]),
            _ => rgba.extend_from_slice(&[255, 255, 255, 255]),
        }
    }
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_image(arboard::ImageData { width: px.w, height: px.h, bytes: Cow::Owned(rgba) })
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())

        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            read_binary_file,
            store_read,
            store_write,
            store_delete,
            store_dir,
            launch_file,
            export_image,
            export_text,
            copy_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running Monobit");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(w: usize, h: usize, data: Vec<u8>) -> Pixels {
        Pixels { w, h, data }
    }

    #[test]
    fn png_one_bit_roundtrip_header() {
        let p = px(3, 2, vec![1, 2, 1, 2, 1, 2]);
        let png = encode_png(&p).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        let dec = png::Decoder::new(&png[..]).read_info().unwrap();
        assert_eq!(dec.info().bit_depth, png::BitDepth::One);
    }

    #[test]
    fn png_with_transparency_is_indexed() {
        let p = px(2, 1, vec![0, 1]);
        let png = encode_png(&p).unwrap();
        let dec = png::Decoder::new(&png[..]).read_info().unwrap();
        assert_eq!(dec.info().color_type, png::ColorType::Indexed);
    }

    #[test]
    fn packs_msb_and_lsb() {
        let p = px(9, 1, vec![1, 2, 2, 2, 2, 2, 2, 1, 1]);
        assert_eq!(pack_rows(&p, true), vec![0x81, 0x80]);
        assert_eq!(pack_rows(&p, false), vec![0x81, 0x01]);
    }

    #[test]
    fn bmp_size() {
        let p = px(10, 3, vec![1; 30]);
        let b = encode_bmp(&p);
        assert_eq!(b.len(), 62 + 4 * 3);
    }

    #[test]
    fn scaling() {
        let p = px(2, 1, vec![1, 2]).scaled(2);
        assert_eq!(p.data, vec![1, 1, 2, 2, 1, 1, 2, 2]);
    }

    #[test]
    fn symbols() {
        assert_eq!(sanitize_symbol("Name Tag!"), "name_tag_");
        assert_eq!(sanitize_symbol("9lives"), "img_9lives");
    }
}
