#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rdev::{simulate, Button, EventType, Key};
use tauri::{command, Emitter, Manager, Window};
use screenshots::Screen; 
use std::io::Cursor;
use base64::{engine::general_purpose, Engine as _};
use std::thread;
use std::time::Duration;
use image::ColorType;
use std::sync::atomic::{AtomicUsize, Ordering};

static CAPTURE_SESSION_ID: AtomicUsize = AtomicUsize::new(0);

// --- 키보드 매핑 ---
fn str_to_key(key_str: &str) -> Option<Key> {
    match key_str.to_lowercase().as_str() {
        "enter" => Some(Key::Return),
        "backspace" => Some(Key::Backspace),
        "control" => Some(Key::ControlLeft),
        "shift" => Some(Key::ShiftLeft),
        "alt" => Some(Key::Alt),
        "escape" => Some(Key::Escape),
        "tab" => Some(Key::Tab),
        "space" => Some(Key::Space),
        "arrowup" => Some(Key::UpArrow),
        "arrowdown" => Some(Key::DownArrow),
        "arrowleft" => Some(Key::LeftArrow),
        "arrowright" => Some(Key::RightArrow),
        "a" => Some(Key::KeyA), "b" => Some(Key::KeyB), "c" => Some(Key::KeyC),
        "d" => Some(Key::KeyD), "e" => Some(Key::KeyE), "f" => Some(Key::KeyF),
        "g" => Some(Key::KeyG), "h" => Some(Key::KeyH), "i" => Some(Key::KeyI),
        "j" => Some(Key::KeyJ), "k" => Some(Key::KeyK), "l" => Some(Key::KeyL),
        "m" => Some(Key::KeyM), "n" => Some(Key::KeyN), "o" => Some(Key::KeyO),
        "p" => Some(Key::KeyP), "q" => Some(Key::KeyQ), "r" => Some(Key::KeyR),
        "s" => Some(Key::KeyS), "t" => Some(Key::KeyT), "u" => Some(Key::KeyU),
        "v" => Some(Key::KeyV), "w" => Some(Key::KeyW), "x" => Some(Key::KeyX),
        "y" => Some(Key::KeyY), "z" => Some(Key::KeyZ),
        "1" => Some(Key::Num1), "2" => Some(Key::Num2), "3" => Some(Key::Num3),
        "4" => Some(Key::Num4), "5" => Some(Key::Num5), "6" => Some(Key::Num6),
        "7" => Some(Key::Num7), "8" => Some(Key::Num8), "9" => Some(Key::Num9),
        "0" => Some(Key::Num0),
        _ => None,
    }
}

// [수정됨] 괄호 () 제거
#[command]
fn remote_mouse_move(x: f64, y: f64, monitor_index: usize) {
    let screens = Screen::all().unwrap_or_default();
    let screen = screens.get(monitor_index).or(screens.first());

    if let Some(s) = screen {
        let info = s.display_info;
        
        // [핵심 수정] info.x() -> info.x (필드 접근)
        let offset_x = info.x as f64;
        let offset_y = info.y as f64;
        let width = info.width as f64;
        let height = info.height as f64;

        let target_x = offset_x + (x * width);
        let target_y = offset_y + (y * height);

        let _ = simulate(&EventType::MouseMove { x: target_x, y: target_y });
    }
}

#[command]
fn remote_mouse_click(button: String) {
    let btn = match button.as_str() {
        "right" => Button::Right,
        _ => Button::Left,
    };
    let _ = simulate(&EventType::ButtonPress(btn));
    let _ = simulate(&EventType::ButtonRelease(btn));
}

#[command]
fn remote_keyboard_event(state: String, key: String) {
    if let Some(rdev_key) = str_to_key(&key) {
        let event = match state.as_str() {
            "down" => EventType::KeyPress(rdev_key),
            "up" => EventType::KeyRelease(rdev_key),
            _ => return,
        };
        let _ = simulate(&event);
    }
}

#[command]
async fn start_screen_capture(window: Window, monitor_index: usize) {
    let my_session_id = CAPTURE_SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    println!("📸 Starting capture (screenshots) for Monitor {} (Session {})", monitor_index, my_session_id);

    thread::spawn(move || {
        loop {
            let current_global_id = CAPTURE_SESSION_ID.load(Ordering::SeqCst);
            if current_global_id != my_session_id {
                println!("🛑 Thread {} stopping...", my_session_id);
                break;
            }

            let start_time = std::time::Instant::now();
            let screens = Screen::all().unwrap_or_default();
            let screen = screens.get(monitor_index).or(screens.first());

            if let Some(screen) = screen {
                match screen.capture() {
                    Ok(image) => {
                        // capture()가 반환하는 image는 메서드 width(), height()를 가집니다 (여긴 괄호 유지)
                        let width = image.width();
                        let height = image.height();
                        let raw_data = image.as_raw(); // Vec<u8>

                        let mut buffer = Cursor::new(Vec::new());
                        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 50);
                        
                        match encoder.encode(raw_data, width, height, ColorType::Rgba8) {
                            Ok(_) => {
                                let b64 = general_purpose::STANDARD.encode(buffer.get_ref());
                                if let Err(_) = window.emit("video-frame", b64) {
                                    break;
                                }
                            },
                            Err(e) => println!("Encoding error: {}", e),
                        }
                    },
                    Err(e) => println!("Capture error: {}", e),
                }
            }

            let elapsed = start_time.elapsed();
            if elapsed < Duration::from_millis(33) {
                thread::sleep(Duration::from_millis(33) - elapsed);
            }
        }
    });
}

#[command]
fn check_permissions() -> bool {
    #[cfg(target_os = "macos")]
    {
        // 접근성 권한(마우스 제어)이 있는지 확인
        return macos_accessibility_client::accessibility::application_is_trusted();
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 윈도우는 별도 체크 없이 true 반환 (MVP 기준)
        return true;
    }
}

// [NEW] 설정창 열기 로직
#[command]
fn open_permission_settings() {
    #[cfg(target_os = "macos")]
    {
        // '손쉬운 사용' 설정 패널을 직접 엽니다.
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn()
            .ok();
            
        // (참고) 화면 기록 설정창 URL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| { Ok(()) })
        .invoke_handler(tauri::generate_handler![
            remote_mouse_move, 
            remote_mouse_click,
            remote_keyboard_event,
            start_screen_capture,
            check_permissions,
            open_permission_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}