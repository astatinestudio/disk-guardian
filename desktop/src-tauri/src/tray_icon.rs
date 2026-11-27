//! Windows cannot show text next to a tray icon, so the temperature is drawn
//! into the icon itself: white digits on a rounded square in the level color.

#![cfg_attr(not(windows), allow(dead_code))]

use tauri::image::Image;

const SIZE: usize = 32;

/// 5x7 bitmap font: digits 0-9 and '-'
const GLYPHS: [[u8; 7]; 11] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110], // 0
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110], // 1
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111], // 2
    [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110], // 3
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010], // 4
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110], // 5
    [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110], // 6
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000], // 7
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110], // 8
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100], // 9
    [0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000], // -
];

fn glyph(c: char) -> Option<usize> {
    match c {
        '0'..='9' => Some(c as usize - '0' as usize),
        '-' => Some(10),
        _ => None,
    }
}

pub fn level_color(level: &str) -> [u8; 3] {
    match level {
        "ok" => [0x1f, 0x9d, 0x55],
        "warn" => [0xc9, 0x8a, 0x00],
        "crit" => [0xd6, 0x3c, 0x3c],
        _ => [0x5e, 0x5e, 0x66],
    }
}

/// `text`: up to three digits (e.g. "38", "104"); other characters are ignored.
pub fn render(text: &str, level: &str) -> Image<'static> {
    let mut px = vec![0u8; SIZE * SIZE * 4];
    let [r, g, b] = level_color(level);
    let radius = 7.0f32;
    let set = |px: &mut Vec<u8>, x: usize, y: usize, c: [u8; 4]| {
        let i = (y * SIZE + x) * 4;
        px[i..i + 4].copy_from_slice(&c);
    };
    // rounded square background with a soft (anti-aliased) edge
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
            let cx = fx.clamp(radius, SIZE as f32 - radius);
            let cy = fy.clamp(radius, SIZE as f32 - radius);
            let d = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
            let a = (radius + 0.5 - d).clamp(0.0, 1.0);
            if a > 0.0 {
                set(&mut px, x, y, [r, g, b, (a * 255.0) as u8]);
            }
        }
    }
    let glyphs: Vec<usize> = text.chars().filter_map(glyph).take(3).collect();
    if glyphs.is_empty() {
        return Image::new_owned(px, SIZE as u32, SIZE as u32);
    }
    let n = glyphs.len();
    let (scale, gap) = if n <= 2 { (3, 2) } else { (2, 1) };
    let width = n * 5 * scale + (n - 1) * gap;
    let height = 7 * scale;
    let ox = SIZE.saturating_sub(width) / 2;
    let oy = (SIZE - height) / 2;
    for (i, gi) in glyphs.iter().enumerate() {
        let gx = ox + i * (5 * scale + gap);
        for (row, bits) in GLYPHS[*gi].iter().enumerate() {
            for col in 0..5 {
                if bits & (1 << (4 - col)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (x, y) = (gx + col * scale + dx, oy + row * scale + dy);
                        if x < SIZE && y < SIZE {
                            set(&mut px, x, y, [255, 255, 255, 255]);
                        }
                    }
                }
            }
        }
    }
    Image::new_owned(px, SIZE as u32, SIZE as u32)
}
