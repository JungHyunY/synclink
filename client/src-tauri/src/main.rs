#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rdev::{simulate, Button, EventType, Key};
use tauri::{command, Emitter, Manager, Window};
use xcap::Monitor;
use std::io::Cursor;
use base64::{engine::general_purpose, Engine as _};
use std::thread;
use std::time::Duration;
use image::ColorType;
use std::sync::atomic::{AtomicUsize, Ordering};

// 전역 캡처 세션 ID (스레드 충돌 방지용)
static CAPTURE_SESSION_ID: AtomicUsize = AtomicUsize::new(0);

// --- 키보드 매핑 (기존 동일) ---
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

// [최종] 마우스 이동: 모니터 인덱스를 받아 해당 화면 기준 좌표로 변환
#[command]
fn remote_mouse_move(x: f64, y: f64, monitor_index: usize) {
    let monitors = Monitor::all().unwrap_or_default();
    // 요청한 인덱스가 없으면 0번(Primary) 사용
    let monitor = monitors.get(monitor_index).or(monitors.first());

    if let Some(m) = monitor {
        // 모니터의 시작점(Offset)과 크기(Width/Height)를 가져옴
        let offset_x = m.x() as f64;
        let offset_y = m.y() as f64;
        let width = m.width() as f64;
        let height = m.height() as f64;

        // 비율(0.0~1.0)을 절대 좌표로 변환하고 모니터 오프셋을 더함
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
    // 디버깅용 로그
    println!("⌨️ Key: {} ({})", key, state);
    
    if let Some(rdev_key) = str_to_key(&key) {
        let event = match state.as_str() {
            "down" => EventType::KeyPress(rdev_key),
            "up" => EventType::KeyRelease(rdev_key),
            _ => return,
        };
        let _ = simulate(&event);
    }
}

// [최종] 화면 캡처: AtomicUsize로 스레드 제어 + Raw Image Encoding
#[command]
async fn start_screen_capture(window: Window, monitor_index: usize) {
    // 1. 새로운 세션 ID 발급 (이전 스레드들을 무효화)
    let my_session_id = CAPTURE_SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    println!("📸 Starting capture for Monitor {} (Session {})", monitor_index, my_session_id);

    thread::spawn(move || {
        loop {
            // 2. 생존 확인: 전역 ID가 내 ID와 다르면 종료
            let current_global_id = CAPTURE_SESSION_ID.load(Ordering::SeqCst);
            if current_global_id != my_session_id {
                println!("🛑 Thread {} stopping (New: {})", my_session_id, current_global_id);
                break;
            }

            let start_time = std::time::Instant::now();
            let monitors = Monitor::all().unwrap_or_default();
            let monitor = monitors.get(monitor_index).or(monitors.first());

            if let Some(monitor) = monitor {
                match monitor.capture_image() {
                    Ok(image) => {
                        // 3. 이미지 처리 (Raw Data -> JPEG)
                        let width = image.width();
                        let height = image.height();
                        let raw_data = image.as_raw();

                        let mut buffer = Cursor::new(Vec::new());
                        // 품질 50 (속도/화질 타협점)
                        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 50);
                        
                        // Raw Data 인코딩으로 버전 이슈 회피
                        match encoder.encode(raw_data, width, height, ColorType::Rgba8) {
                            Ok(_) => {
                                let b64 = general_purpose::STANDARD.encode(buffer.get_ref());
                                if let Err(_) = window.emit("video-frame", b64) {
                                    break; // 창 닫힘
                                }
                            },
                            Err(e) => println!("Encoding error: {}", e),
                        }
                    },
                    Err(e) => println!("Capture error: {}", e),
                }
            }

            // 4. FPS 제어 (약 30 FPS)
            let elapsed = start_time.elapsed();
            if elapsed < Duration::from_millis(33) {
                thread::sleep(Duration::from_millis(33) - elapsed);
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| { Ok(()) })
        .invoke_handler(tauri::generate_handler![
            remote_mouse_move, 
            remote_mouse_click,
            remote_keyboard_event,
            start_screen_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}