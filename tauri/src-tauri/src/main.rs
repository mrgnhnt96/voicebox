mod accessibility;
mod clipboard;
#[cfg(desktop)]
mod dictation;
mod focus_capture;
#[cfg(desktop)]
mod hotkey_monitor;
mod input_monitoring;
#[cfg(desktop)]
mod key_codes;
mod keyboard_layout;
mod server_process;
mod synthetic_keys;
mod text_insert;

use std::sync::Mutex;
use tauri::{
    command, Emitter, Listener, Manager, PhysicalPosition, RunEvent, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::ShellExt;
use tokio::sync::mpsc;

pub const DICTATE_WINDOW_LABEL: &str = "dictate";
const DICTATE_WINDOW_WIDTH: f64 = 420.0;
const DICTATE_WINDOW_HEIGHT: f64 = 64.0;
const DICTATE_BOTTOM_PADDING: f64 = 24.0;

/// Create the floating dictate webview hidden. The HotkeyMonitor shows it on
/// chord-start; the frontend hides it when the capture pipeline finishes.
/// Building it at setup avoids a race where the first chord event fires
/// before the webview subscribes to the `dictate:*` events.
#[cfg(desktop)]
fn build_dictate_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = WebviewWindowBuilder::new(
        app,
        DICTATE_WINDOW_LABEL,
        WebviewUrl::App("?view=dictate".into()),
    )
    .title("Voicebox Dictate")
    .inner_size(DICTATE_WINDOW_WIDTH, DICTATE_WINDOW_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    // Follow the user across macOS Spaces / virtual desktops instead of
    // being pinned to the Space where the window was first created.
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    // The pill never becomes key (see `pill_panel_can_become_key`), so every
    // click on it is a first click; without this WebKit would swallow it.
    .accept_first_mouse(true)
    .visible(false)
    .build()?;

    position_dictate_window(&window)?;

    // Make the pill able to float over other apps' native fullscreen Spaces.
    apply_fullscreen_overlay_behavior(&window);

    Ok(window)
}

/// Center the pill above the usable screen edge, leaving room for the Dock/taskbar.
#[cfg(desktop)]
pub(crate) fn position_dictate_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    // Hidden pills are parked off-screen, so their current monitor can be absent.
    let monitor = window.current_monitor()?.or(window.primary_monitor()?);
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let size = window.outer_size()?;
        let padding = (DICTATE_BOTTOM_PADDING * monitor.scale_factor()).round() as i32;
        let available_width = (area.size.width as i32 - size.width as i32).max(0);
        let available_height = (area.size.height as i32 - size.height as i32).max(0);
        let x = area.position.x + available_width / 2;
        let y = area.position.y + (available_height - padding).max(0);
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

// `object_setClass` — reclass a live object. Not re-exported by `objc`.
extern "C" {
    fn object_setClass(
        obj: *mut objc::runtime::Object,
        cls: *const objc::runtime::Class,
    ) -> *const objc::runtime::Class;
}

/// `canBecomeKeyWindow` override for the pill panel. The pill must never take
/// keyboard focus: it floats over the app being dictated into, and while it is
/// key that app's window looks focused but every keystroke (the Enter after a
/// paste, say) lands in the pill instead. Audio capture is native, so nothing
/// in the webview needs key status.
extern "C" fn pill_panel_can_become_key(
    _this: &objc::runtime::Object,
    _sel: objc::runtime::Sel,
) -> objc::runtime::BOOL {
    objc::runtime::NO
}

/// Lazily-registered NSPanel subclass for the dictate pill: never key (so it
/// never takes keystrokes) while remaining a panel (for fullscreen-Space join).
fn pill_panel_class() -> &'static objc::runtime::Class {
    use objc::declare::ClassDecl;
    use objc::runtime::{Class, Object, Sel, BOOL};
    use objc::{class, sel, sel_impl};
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let superclass = class!(NSPanel);
        let mut decl =
            ClassDecl::new("VoiceboxPillPanel", superclass).expect("register VoiceboxPillPanel");
        unsafe {
            decl.add_method(
                sel!(canBecomeKeyWindow),
                pill_panel_can_become_key as extern "C" fn(&Object, Sel) -> BOOL,
            );
        }
        decl.register();
    });
    Class::get("VoiceboxPillPanel").expect("VoiceboxPillPanel registered")
}

/// Convert the dictate pill's NSWindow into a never-key NSPanel and set the
/// collection behavior + window level required to appear over another app's
/// native macOS fullscreen Space.
///
/// A regular (Dock-icon) app's plain NSWindow is never admitted to a foreign
/// fullscreen Space regardless of collection-behavior flags or window level;
/// an NSPanel with the same flags is. NSPanel adds no instance variables over
/// NSWindow, so re-classing the live object is safe (the tauri-nspanel plugin
/// uses the same technique). Idempotent via an `isKindOfClass` guard. Runs on
/// the main thread because AppKit window mutation is main-thread-only.
pub fn apply_fullscreen_overlay_behavior(window: &tauri::WebviewWindow) {
    let w = window.clone();
    let dispatched = window.run_on_main_thread(move || {
        use objc::runtime::{Object, NO, YES};
        use objc::{class, msg_send, sel, sel_impl};

        // NSWindowCollectionBehavior bit flags.
        const CAN_JOIN_ALL_SPACES: u64 = 1 << 0;
        const STATIONARY: u64 = 1 << 4;
        const FULL_SCREEN_AUXILIARY: u64 = 1 << 8; // the flag stock Tauri never sets
        const NONACTIVATING_PANEL: u64 = 1 << 7; // NSWindowStyleMaskNonactivatingPanel
                                                 // NSScreenSaverWindowLevel — floats above fullscreen app content.
        const OVERLAY_WINDOW_LEVEL: i64 = 1000;

        let ns_window = match w.ns_window() {
            Ok(ptr) => ptr as *mut Object,
            Err(e) => {
                eprintln!("apply_fullscreen_overlay_behavior: ns_window() failed: {e}");
                return;
            }
        };
        if ns_window.is_null() {
            return;
        }
        // SAFETY: ns_window is a valid, non-null NSWindow* owned by Tauri for
        // the lifetime of the webview window; all selectors are standard AppKit
        // calls and we are on the main thread.
        unsafe {
            let is_panel: objc::runtime::BOOL =
                msg_send![ns_window, isKindOfClass: class!(NSPanel)];
            if is_panel == NO {
                object_setClass(ns_window, pill_panel_class());
                let style: u64 = msg_send![ns_window, styleMask];
                let _: () = msg_send![ns_window, setStyleMask: style | NONACTIVATING_PANEL];
                let _: () = msg_send![ns_window, setHidesOnDeactivate: NO];
                let _: () = msg_send![ns_window, setBecomesKeyOnlyIfNeeded: YES];
                let _: () = msg_send![ns_window, setFloatingPanel: YES];
            }
            // Preserve behavior bits installed by Tauri/Tao instead of
            // replacing them wholesale when adding the fullscreen flags.
            let current_behavior: u64 = msg_send![ns_window, collectionBehavior];
            let behavior =
                current_behavior | CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY | STATIONARY;
            let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
            let _: () = msg_send![ns_window, setLevel: OVERLAY_WINDOW_LEVEL];
        }
    });
    if let Err(e) = dispatched {
        eprintln!("apply_fullscreen_overlay_behavior: main-thread dispatch failed: {e}");
    }
}

/// Show the pill over whatever Space is active without taking keyboard focus.
/// This replaces `window.show()`, which calls `makeKeyAndOrderFront:`.
/// `orderFrontRegardless` works even though the app is inactive (it always is
/// mid-dictation — the user is typing in some other app).
pub fn force_order_front(window: &tauri::WebviewWindow) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        if let Ok(ptr) = w.ns_window() {
            let ns_window = ptr as *mut Object;
            if !ns_window.is_null() {
                unsafe {
                    let _: () = msg_send![ns_window, orderFrontRegardless];
                }
            }
        }
    });
}

/// Build the pill webview if it doesn't exist yet. Idempotent — called at
/// setup so the pill's listeners are registered before the first chord.
#[cfg(desktop)]
pub fn ensure_dictate_window(app: &tauri::AppHandle) {
    if app.get_webview_window(DICTATE_WINDOW_LABEL).is_none() {
        if let Err(e) = build_dictate_window(app) {
            eprintln!("ensure_dictate_window: failed to build pill: {e}");
        }
    }
}

pub(crate) const SERVER_PORT: u16 = 17493;

/// Check if a Voicebox server is responding on the given port.
///
/// Sends an HTTP GET to `/health` and returns `true` only if the response
/// is valid JSON with `status == "healthy"`, which filters out unrelated
/// services that answer `/health` with something else.
fn check_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/health", port);
    match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => match client.get(&url).send() {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return false;
                }
                // Parse as JSON and validate Voicebox-specific fields
                match resp.json::<serde_json::Value>() {
                    Ok(body) => body.get("status").and_then(|v| v.as_str()) == Some("healthy"),
                    Err(_) => false,
                }
            }
            Err(_) => false,
        },
        Err(_) => false,
    }
}

struct ServerState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    server_pid: Mutex<Option<u32>>,
    models_dir: Mutex<Option<String>>,
}

#[command]
async fn start_server(
    app: tauri::AppHandle,
    state: State<'_, ServerState>,
    models_dir: Option<String>,
) -> Result<String, String> {
    // Store models_dir for use on restart (empty string means reset to default)
    if let Some(ref dir) = models_dir {
        if dir.is_empty() {
            *state.models_dir.lock().unwrap() = None;
        } else {
            *state.models_dir.lock().unwrap() = Some(dir.clone());
        }
    }
    // Check if server is already running (managed by this app instance)
    if state.child.lock().unwrap().is_some() {
        return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
    }

    // Check if a voicebox server is already running on our port (e.g. one left
    // over from a previous session, or started by hand via `python`/`uvicorn`)
    {
        use std::process::Command;
        if let Ok(output) = Command::new("lsof")
            .args(["-i", &format!(":{}", SERVER_PORT), "-sTCP:LISTEN"])
            .output()
        {
            let output_str = String::from_utf8_lossy(&output.stdout);
            for line in output_str.lines().skip(1) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let command = parts[0];
                    let pid_str = parts[1];
                    if command.contains("voicebox") {
                        if let Ok(pid) = pid_str.parse::<u32>() {
                            println!(
                                "Found existing voicebox-server on port {} (PID: {}), reusing it",
                                SERVER_PORT, pid
                            );
                            // Store the PID so we can kill it on exit if needed
                            *state.server_pid.lock().unwrap() = Some(pid);
                            return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                        }
                    } else {
                        // Process name doesn't contain "voicebox" — could be an external
                        // Python/uvicorn/Docker server. Verify via HTTP health check.
                        println!("Port {} in use by '{}' (PID: {}), checking if it's a Voicebox server...", SERVER_PORT, command, pid_str);
                        if check_health(SERVER_PORT) {
                            println!(
                                "Health check passed — reusing external server on port {}",
                                SERVER_PORT
                            );
                            return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                        }
                        println!(
                            "Health check failed — port is occupied by a non-Voicebox process"
                        );
                        return Err(format!(
                            "Port {} is already in use by another application ({}). \
                             Close it or change the Voicebox server port.",
                            SERVER_PORT, command
                        ));
                    }
                }
            }
        }
    }

    // Get app data directory
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure data directory exists
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    println!("=================================================================");
    println!("Starting voicebox-server sidecar");
    println!("Data directory: {:?}", data_dir);

    let sidecar_result = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| server_process::bundled_executable(&dir));

    let mut sidecar = match sidecar_result {
        Ok(path) => app.shell().command(path),
        Err(e) => {
            eprintln!("Failed to get sidecar: {}", e);

            // In dev mode, check if the server is already running (started manually)
            #[cfg(debug_assertions)]
            {
                eprintln!(
                    "Dev mode: Checking if server is already running on port {}...",
                    SERVER_PORT
                );

                // Try to connect to the server port
                use std::net::TcpStream;
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                    std::time::Duration::from_secs(1),
                )
                .is_ok()
                {
                    println!("Found server already running on port {}", SERVER_PORT);
                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                }

                eprintln!("");
                eprintln!("=================================================================");
                eprintln!("DEV MODE: No server found on port {}", SERVER_PORT);
                eprintln!("");
                eprintln!("Start the Python server in a separate terminal:");
                eprintln!("  bun run dev:server");
                eprintln!("=================================================================");
                eprintln!("");
            }

            return Err(format!("Failed to start server. In dev mode, run 'bun run dev:server' in a separate terminal."));
        }
    };

    println!("Sidecar command created successfully");

    // Build common args
    let data_dir_str = data_dir
        .to_str()
        .ok_or_else(|| "Invalid data dir path".to_string())?
        .to_string();
    let port_str = SERVER_PORT.to_string();
    let parent_pid_str = std::process::id().to_string();

    // Resolve the custom models directory from the parameter or stored state
    let effective_models_dir = models_dir.or_else(|| state.models_dir.lock().unwrap().clone());
    if let Some(ref dir) = effective_models_dir {
        println!("Custom models directory: {}", dir);
    }

    sidecar = sidecar.args([
        "--data-dir",
        &data_dir_str,
        "--port",
        &port_str,
        "--parent-pid",
        &parent_pid_str,
    ]);
    if let Some(ref dir) = effective_models_dir {
        sidecar = sidecar.env("VOICEBOX_MODELS_DIR", dir);
    }
    println!("Spawning bundled server process...");
    let spawn_result = sidecar.spawn();

    let (mut rx, child) = match spawn_result {
        Ok(result) => result,
        Err(e) => {
            eprintln!("Failed to spawn server process: {}", e);

            // In dev mode, check if a manually-started server is available
            #[cfg(debug_assertions)]
            {
                use std::net::TcpStream;
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                    std::time::Duration::from_secs(1),
                )
                .is_ok()
                {
                    println!("Found manually-started server on port {}", SERVER_PORT);
                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                }

                eprintln!("");
                eprintln!("=================================================================");
                eprintln!("DEV MODE: Server binary failed to start");
                eprintln!("");
                eprintln!("Start the Python server in a separate terminal:");
                eprintln!("  bun run dev:server");
                eprintln!("=================================================================");
                eprintln!("");
                return Err("Dev mode: Start server manually with 'bun run dev:server'".to_string());
            }

            #[cfg(not(debug_assertions))]
            {
                eprintln!("This could be due to:");
                eprintln!("  - Missing or corrupted binary");
                eprintln!("  - Missing execute permissions");
                eprintln!("  - Code signing issues on macOS");
                eprintln!("  - Missing dependencies");
                return Err(format!("Failed to spawn: {}", e));
            }
        }
    };

    println!("Server process spawned, waiting for ready signal...");
    println!("=================================================================");

    // Store child process and PID
    let process_pid = child.pid();
    *state.server_pid.lock().unwrap() = Some(process_pid);
    *state.child.lock().unwrap() = Some(child);

    // Wait for server to be ready by listening for startup log
    // PyInstaller bundles can be slow on first import, especially torch/transformers
    // Startup now loads the installed dictation models before serving requests.
    let timeout = tokio::time::Duration::from_secs(600);
    let start_time = tokio::time::Instant::now();
    let mut error_output = Vec::new();

    loop {
        if start_time.elapsed() > timeout {
            eprintln!("Server startup timeout after 600 seconds");
            if !error_output.is_empty() {
                eprintln!("Collected error output:");
                for line in &error_output {
                    eprintln!("  {}", line);
                }
            }

            // In dev mode, check if a manual server came up during the wait
            #[cfg(debug_assertions)]
            {
                use std::net::TcpStream;
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                    std::time::Duration::from_secs(1),
                )
                .is_ok()
                {
                    // Kill the placeholder process
                    let _ = state.child.lock().unwrap().take();
                    println!("Found manually-started server on port {}", SERVER_PORT);
                    return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                }
            }

            return Err("Server startup timeout - check Console.app for detailed logs".to_string());
        }

        match tokio::time::timeout(tokio::time::Duration::from_millis(100), rx.recv()).await {
            Ok(Some(event)) => {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                        let line_str = String::from_utf8_lossy(&line);
                        println!("Server output: {}", line_str);
                        let _ = app.emit(
                            "server-log",
                            serde_json::json!({
                                "stream": "stdout",
                                "line": line_str.trim_end(),
                            }),
                        );

                        if line_str.contains("Uvicorn running")
                            || line_str.contains("Application startup complete")
                        {
                            println!("Server is ready!");
                            break;
                        }
                    }
                    tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        eprintln!("Server: {}", line_str);
                        let _ = app.emit(
                            "server-log",
                            serde_json::json!({
                                "stream": "stderr",
                                "line": line_str.trim_end(),
                            }),
                        );

                        // Collect error lines for debugging
                        if line_str.contains("ERROR")
                            || line_str.contains("Error")
                            || line_str.contains("Failed")
                        {
                            error_output.push(line_str.clone());
                        }

                        // Uvicorn logs to stderr, so check there too
                        if line_str.contains("Uvicorn running")
                            || line_str.contains("Application startup complete")
                        {
                            println!("Server is ready!");
                            break;
                        }
                    }
                    _ => {}
                }
            }
            Ok(None) => {
                // In dev mode, this is expected when using the placeholder binary
                #[cfg(debug_assertions)]
                {
                    use std::net::TcpStream;
                    eprintln!("Server process ended (dev mode placeholder detected)");

                    // Check if a manually-started server is available
                    if TcpStream::connect_timeout(
                        &format!("127.0.0.1:{}", SERVER_PORT).parse().unwrap(),
                        std::time::Duration::from_secs(1),
                    )
                    .is_ok()
                    {
                        // Clean up state
                        let _ = state.child.lock().unwrap().take();
                        let _ = state.server_pid.lock().unwrap().take();
                        println!("Found manually-started server on port {}", SERVER_PORT);
                        return Ok(format!("http://127.0.0.1:{}", SERVER_PORT));
                    }

                    eprintln!("");
                    eprintln!("=================================================================");
                    eprintln!("DEV MODE: No bundled server binary available");
                    eprintln!("");
                    eprintln!("Start the Python server in a separate terminal:");
                    eprintln!("  bun run dev:server");
                    eprintln!("=================================================================");
                    eprintln!("");
                    return Err(
                        "Dev mode: Start server manually with 'bun run dev:server'".to_string()
                    );
                }

                #[cfg(not(debug_assertions))]
                {
                    eprintln!("Server process ended unexpectedly during startup!");
                    eprintln!("The server binary may have crashed or exited with an error.");
                    eprintln!("Check Console.app logs for more details (search for 'voicebox')");
                    return Err("Server process ended unexpectedly".to_string());
                }
            }
            Err(_) => {
                // Timeout on this recv, continue loop
                continue;
            }
        }
    }

    // Spawn task to continue reading output and emit to frontend
    let app_handle = app.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    println!("Server: {}", line_str);
                    let _ = app_handle.emit(
                        "server-log",
                        serde_json::json!({
                            "stream": "stdout",
                            "line": line_str.trim_end(),
                        }),
                    );
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("Server error: {}", line_str);
                    let _ = app_handle.emit(
                        "server-log",
                        serde_json::json!({
                            "stream": "stderr",
                            "line": line_str.trim_end(),
                        }),
                    );
                }
                _ => {}
            }
        }
    });

    Ok(format!("http://127.0.0.1:{}", SERVER_PORT))
}

#[command]
async fn stop_server(state: State<'_, ServerState>) -> Result<(), String> {
    stop_managed_server(&state)
}

fn stop_managed_server(state: &ServerState) -> Result<(), String> {
    let mut pid = state.server_pid.lock().unwrap();
    if let Some(value) = *pid {
        server_process::stop(value)?;
        *pid = None;
        state.child.lock().unwrap().take();
    }
    Ok(())
}

async fn wait_for_server_exit() -> Result<(), String> {
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", SERVER_PORT))
            .await
            .is_err()
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err(
        "The local server is still running. Restart was cancelled; no second server was launched."
            .into(),
    )
}

#[command]
async fn restart_app(app: tauri::AppHandle, state: State<'_, ServerState>) -> Result<(), String> {
    stop_server(state.clone()).await?;
    wait_for_server_exit().await?;
    app.request_restart();
    Ok(())
}

#[command]
async fn restart_server(
    app: tauri::AppHandle,
    state: State<'_, ServerState>,
    models_dir: Option<String>,
) -> Result<String, String> {
    println!("restart_server: stopping current server...");

    // Update stored models_dir: empty string means reset to default, non-empty means set
    if let Some(ref dir) = models_dir {
        if dir.is_empty() {
            *state.models_dir.lock().unwrap() = None;
        } else {
            *state.models_dir.lock().unwrap() = Some(dir.clone());
        }
    }

    // Stop the current server
    stop_server(state.clone()).await?;

    // Wait for port to be released
    println!("restart_server: waiting for port release...");
    wait_for_server_exit().await?;

    // Start server again (uses the stored models_dir)
    println!("restart_server: starting server...");
    start_server(app, state.clone(), None).await
}

/// Identifier of the Voicebox app itself — used to short-circuit auto-paste
/// when the user fires a chord while focus was inside one of our own
/// windows. Paste into Voicebox-internal targets is step 6 territory and
/// goes through a different (JS-side) injection path.
///
/// Value matches the reverse-DNS bundle id `focus_capture::capture_focus`
/// writes into `FocusSnapshot::bundle_id`.
const VOICEBOX_BUNDLE_ID: &str = "sh.voicebox.app";

/// Milliseconds to wait between activating the target app and firing the
/// synthetic ⌘V, giving AppKit time to finish re-ordering windows and
/// restoring its last-focused field.
const POST_ACTIVATE_SETTLE_MS: u64 = 120;

/// Milliseconds the staged text lives on the clipboard after the paste
/// keystroke, before we restore the user's original clipboard contents.
/// Too short and slow apps haven't consumed the paste yet; too long and
/// the user sees our text if they look at their clipboard manager.
const PASTE_CONSUME_MS: u64 = 400;

/// Reports whether the process currently has macOS Accessibility trust.
/// Used by the settings UI and the paste debug harness to decide whether
/// synthetic key events will actually land.
#[command]
fn check_accessibility_permission() -> bool {
    accessibility::is_trusted()
}

/// Reports whether the process can observe global keyboard events. Read by
/// the Captures settings UI to surface a "missing — open Settings" hint
/// beside the hotkey toggle. No prompt side-effect.
#[command]
fn check_input_monitoring_permission() -> bool {
    input_monitoring::is_trusted()
}

/// Holds the lazily-spawned global hotkey monitor. The monitor is `None`
/// until the user opts in via the Captures settings toggle — that opt-in is
/// what triggers the macOS Input Monitoring TCC prompt, so a fresh-install
/// user who never enables the hotkey never sees the prompt.
///
/// Disabling the hotkey clears the monitor's internal `ChordMatcher` so
/// keytap's event tap is released while Tauri still owns this `HotkeyState`
/// for the rest of the process. A subsequent enable re-arms without
/// re-prompting for the Input Monitoring permission.
#[cfg(desktop)]
#[derive(Default)]
pub struct HotkeyState {
    monitor: Mutex<Option<hotkey_monitor::HotkeyMonitor>>,
}

#[cfg(desktop)]
fn build_chord_bindings(
    push_to_talk: &[String],
    toggle_to_talk: &[String],
) -> Result<hotkey_monitor::Bindings, String> {
    use hotkey_monitor::{Bindings, ChordAction};
    use keytap::Key;
    use std::collections::HashSet;

    fn build_chord(name: &str, names: &[String]) -> Result<HashSet<Key>, String> {
        if names.is_empty() {
            return Err(format!("{name} chord must have at least one key"));
        }
        let mut chord = HashSet::new();
        for raw in names {
            let key = key_codes::key_from_str(raw)
                .ok_or_else(|| format!("Unsupported key in {name} chord: {raw}"))?;
            chord.insert(key);
        }
        Ok(chord)
    }

    let push_chord = build_chord("push-to-talk", push_to_talk)?;
    let toggle_chord = build_chord("toggle-to-talk", toggle_to_talk)?;

    let mut bindings = Bindings::new();
    bindings.insert(ChordAction::PushToTalk, push_chord);
    bindings.insert(ChordAction::ToggleToTalk, toggle_chord);
    Ok(bindings)
}

/// Spawn the global hotkey monitor on first call; subsequent calls just push
/// the new bindings into the existing monitor. Idempotent on purpose — the
/// frontend invokes this both at startup (when `capture_settings.hotkey_enabled`
/// is true) and from the settings toggle.
///
/// On macOS this is the call that triggers the "Voicebox would like to receive
/// keystrokes from any application" TCC prompt, since keytap's `Tap` creates
/// the CGEventTap inside `HotkeyMonitor::spawn`.
#[cfg(desktop)]
#[command]
fn enable_hotkey(
    app: tauri::AppHandle,
    state: State<'_, HotkeyState>,
    push_to_talk: Vec<String>,
    toggle_to_talk: Vec<String>,
) -> Result<(), String> {
    let bindings = build_chord_bindings(&push_to_talk, &toggle_to_talk)?;

    // Fire the Input Monitoring TCC prompt explicitly from the user's
    // toggle click, before keytap's Tap would do it implicitly via
    // CGEventTap creation. Two reasons: (1) the prompt timing becomes
    // deterministic — it appears in response to a click instead of as a
    // mysterious side-effect of "the app started"; (2) on subsequent
    // launches we can short-circuit the spawn entirely if the user
    // revoked the grant, instead of relying on the tap silently failing.
    // The call returns the current grant state; we ignore it because
    // keytap surfaces its own error via stderr, and the settings UI
    // polls `check_input_monitoring_permission` separately.
    let _ = input_monitoring::request();

    // The dictate pill webview must exist before the first chord fires so it
    // can subscribe to `dictate:start`. Build it here (idempotent — Tauri
    // returns the existing window when one with this label already exists).
    if app.get_webview_window(DICTATE_WINDOW_LABEL).is_none() {
        if let Err(e) = build_dictate_window(&app) {
            eprintln!("Failed to build dictate window: {}", e);
        }
    }

    let mut slot = state.monitor.lock().map_err(|e| e.to_string())?;
    match slot.as_mut() {
        Some(monitor) => monitor.update_bindings(bindings),
        None => {
            *slot = Some(hotkey_monitor::HotkeyMonitor::spawn(app, bindings));
        }
    }
    Ok(())
}

/// Quiet the global hotkey. Tears down the `ChordMatcher` (which stops
/// keytap's chord worker and closes the OS event tap) but keeps the
/// `HotkeyMonitor` handle around so a subsequent `enable_hotkey` re-arms
/// without re-prompting for Input Monitoring permission.
#[cfg(desktop)]
#[command]
fn disable_hotkey(state: State<'_, HotkeyState>) -> Result<(), String> {
    let mut slot = state.monitor.lock().map_err(|e| e.to_string())?;
    if let Some(monitor) = slot.as_mut() {
        monitor.update_bindings(hotkey_monitor::Bindings::new());
    }
    Ok(())
}

/// Push a new chord configuration into the running `HotkeyMonitor`. Called
/// by the chord-picker UI when the user edits the chord. No-ops when the
/// monitor isn't spawned — the picker is gated behind the enable toggle, so
/// this can only happen if the frontend races; the next `enable_hotkey` will
/// pick up the saved chords.
///
/// Returns an error when a key name doesn't map to a `keytap::Key`, so the
/// picker UI can surface "this key isn't supported" instead of silently
/// dropping it from the chord.
#[cfg(desktop)]
#[command]
fn update_chord_bindings(
    state: State<'_, HotkeyState>,
    push_to_talk: Vec<String>,
    toggle_to_talk: Vec<String>,
) -> Result<(), String> {
    let bindings = build_chord_bindings(&push_to_talk, &toggle_to_talk)?;
    let mut slot = state.monitor.lock().map_err(|e| e.to_string())?;
    if let Some(monitor) = slot.as_mut() {
        monitor.update_bindings(bindings);
    }
    Ok(())
}

/// Open the Privacy & Security → Accessibility pane in System Settings so
/// the user can grant the permission. The URL scheme is stable across
/// macOS 10.14–15.
#[command]
fn open_accessibility_settings(app: tauri::AppHandle) -> Result<(), String> {
    let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
    app.shell()
        .open(url, None)
        .map_err(|e| format!("Failed to open Accessibility settings: {e}"))?;
    Ok(())
}

/// Open the Privacy & Security → Input Monitoring pane in System Settings.
/// Used by the Captures settings UI when the toggle is on but the grant
/// is missing, so the user can flip the system toggle without hunting.
#[command]
fn open_input_monitoring_settings(app: tauri::AppHandle) -> Result<(), String> {
    let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent";
    app.shell()
        .open(url, None)
        .map_err(|e| format!("Failed to open Input Monitoring settings: {e}"))?;
    Ok(())
}

/// Deliver `text` into the UI that had focus when the chord fired.
///
/// Pipeline: activate the captured PID → settle → save the user's
/// clipboard → write `text` → fire ⌘V → wait for the target to consume it
/// → conditionally restore the original clipboard.
///
/// The restore is conditional on `NSPasteboard.changeCount` matching the
/// value captured right after `write_text`: if something else wrote to the
/// clipboard during the paste-consume window — the user's own ⌘C in the target app, a
/// clipboard history tool (Paste, Pastebot, Maccy), Universal Clipboard
/// sync, 1Password inserting a secret — their newer content takes
/// priority over our snapshot and is preserved. A
/// [`clipboard::current_change_count`] read failure is treated the same
/// way: unknown state is safer than an unconditional overwrite.
///
/// `send_paste` failure is isolated from the restore decision: we always
/// attempt the conditional restore before propagating the paste error,
/// so a failed `CGEventPost` never leaves the user's
/// clipboard stuck on the transcript.
///
/// Skips (returns `false`) without touching anything when:
/// - `focus.bundle_id` is Voicebox itself — step 6 will inject directly
///   into our own webview; pasting would just double-insert or miss the
///   real target.
/// - Accessibility is not trusted — `CGEventPost` would silently drop the
///   keystroke, leaving the user's clipboard clobbered with nothing to
///   show for it.
///
/// Returns `true` when the paste sequence completed end-to-end.
#[command]
async fn paste_final_text(
    text: String,
    focus: focus_capture::FocusSnapshot,
) -> Result<bool, String> {
    paste_final_text_with(text, focus, None).await
}

/// [`paste_final_text`] with a clipboard snapshot taken earlier, at dictation
/// key-down, reused when nothing was copied since.
pub(crate) async fn paste_final_text_with(
    text: String,
    focus: focus_capture::FocusSnapshot,
    prepared: Option<clipboard::ClipboardSnapshot>,
) -> Result<bool, String> {
    if focus.bundle_id.as_deref() == Some(VOICEBOX_BUNDLE_ID) {
        return Ok(false);
    }
    if !accessibility::is_trusted() {
        return Err(
            "Accessibility permission required for auto-paste. Open System Settings → Privacy & Security → Accessibility and enable Voicebox."
                .into(),
        );
    }

    // Only re-activate the target when the user actually left it. When it is
    // still frontmost (the common case — the dictate pill is non-activating,
    // and in a fullscreen Space the target never loses frontmost), activation
    // is a no-op; on macOS 26 fullscreen Spaces `activate` returns NO for an
    // already-frontmost app, which would otherwise abort the paste entirely.
    let already_front = focus_capture::frontmost_pid() == Some(focus.pid);

    // Direct insertion into the target's focused field via Accessibility: no
    // clipboard, no keystroke and no settle sleeps. Falls
    // through to ⌘V only when nothing was inserted (see text_insert.rs).
    match text_insert::try_insert(focus.pid, focus.bundle_id.clone(), text.clone()).await {
        text_insert::Outcome::Inserted { .. } => {
            if !already_front {
                let _ = focus_capture::activate_pid(focus.pid);
            }
            return Ok(true);
        }
        text_insert::Outcome::Uncertain(msg) => return Err(msg),
        text_insert::Outcome::UseClipboard(_) => {}
    }

    if !already_front {
        focus_capture::activate_pid(focus.pid)?;
        tokio::time::sleep(std::time::Duration::from_millis(POST_ACTIVATE_SETTLE_MS)).await;
    }

    let started = std::time::Instant::now();
    let reused = clipboard::reusable(prepared, clipboard::current_change_count().ok());
    let was_reused = reused.is_some();
    let snapshot = match reused {
        Some(snapshot) => snapshot,
        None => clipboard::save_clipboard()?,
    };
    let saved_ms = started.elapsed().as_millis();
    let after_write = clipboard::write_text(&text)?;

    let paste_result = synthetic_keys::send_paste();
    eprintln!(
        "[voicebox] clipboard paste: snapshot {} in {saved_ms} ms, ⌘V sent {} ms after start",
        if was_reused {
            "reused from key-down"
        } else {
            "taken at paste"
        },
        started.elapsed().as_millis()
    );
    tokio::time::sleep(std::time::Duration::from_millis(PASTE_CONSUME_MS)).await;

    let safe_to_restore = matches!(
        clipboard::current_change_count(),
        Ok(current) if current == after_write
    );
    if safe_to_restore {
        clipboard::restore_clipboard(&snapshot)?;
    } else {
        eprintln!(
            "[voicebox] clipboard mutated during paste window — skipping restore to preserve newer content"
        );
    }

    paste_result?;
    Ok(true)
}

/// Inspect the currently focused UI element. Returns the owning app's PID,
/// bundle id, and AX role. Useful for sanity-checking the focus pipeline
/// before committing to a paste.
#[command]
fn debug_capture_focus() -> Result<focus_capture::FocusSnapshot, String> {
    focus_capture::capture_focus()
}

/// Full auto-paste rehearsal: snapshot the focus target now, sleep
/// `drift_ms` so the user can deliberately switch to a different app
/// (proving we don't paste into whichever window is frontmost when the
/// transcribe finishes), then activate the captured PID, stage `text`,
/// fire ⌘V, and restore the clipboard.
#[command]
async fn debug_focus_roundtrip(
    text: String,
    drift_ms: u64,
    post_paste_delay_ms: u64,
) -> Result<serde_json::Value, String> {
    if !accessibility::is_trusted() {
        return Err(
            "Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable Voicebox."
                .into(),
        );
    }

    let snapshot = focus_capture::capture_focus()?;

    tokio::time::sleep(std::time::Duration::from_millis(drift_ms)).await;

    focus_capture::activate_pid(snapshot.pid)?;
    // Give AppKit a beat to process the activation before the synthetic
    // Cmd+V arrives — without this the paste sometimes races ahead of the
    // window-ordering animation and lands in the previous frontmost app.
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    let clip = clipboard::save_clipboard()?;
    let after_write = clipboard::write_text(&text)?;
    synthetic_keys::send_paste()?;
    tokio::time::sleep(std::time::Duration::from_millis(post_paste_delay_ms)).await;
    let before_restore = clipboard::current_change_count()?;
    clipboard::restore_clipboard(&clip)?;

    Ok(serde_json::json!({
        "focus": snapshot,
        "change_count_after_write": after_write,
        "change_count_before_restore": before_restore,
        "clobbered_during_paste": before_restore != after_write,
    }))
}

/// End-to-end smoke test for the auto-paste pipeline: save the user's
/// clipboard, stage `text`, optionally wait `pre_paste_delay_ms` so the
/// caller has time to focus the target app, synthesise ⌘V, wait
/// `post_paste_delay_ms` for the target app to consume the event, and put
/// the original clipboard back.
///
/// Short-circuits when Accessibility permission is missing — without it
/// `CGEventPost` silently drops events, so running the full sequence
/// would just clobber the clipboard with nothing to show for it.
#[command]
async fn debug_paste_text(
    text: String,
    pre_paste_delay_ms: u64,
    post_paste_delay_ms: u64,
) -> Result<serde_json::Value, String> {
    if !accessibility::is_trusted() {
        return Err(
            "Accessibility permission not granted. Open System Settings → Privacy & Security → Accessibility and enable Voicebox, then try again."
                .into(),
        );
    }

    let snapshot = clipboard::save_clipboard()?;
    let before = snapshot.change_count();
    let after_write = clipboard::write_text(&text)?;

    tokio::time::sleep(std::time::Duration::from_millis(pre_paste_delay_ms)).await;

    synthetic_keys::send_paste()?;

    tokio::time::sleep(std::time::Duration::from_millis(post_paste_delay_ms)).await;

    let before_restore = clipboard::current_change_count()?;
    clipboard::restore_clipboard(&snapshot)?;
    let after_restore = clipboard::current_change_count()?;

    Ok(serde_json::json!({
        "change_count_before": before,
        "change_count_after_write": after_write,
        "change_count_before_restore": before_restore,
        "change_count_after_restore": after_restore,
        "clobbered_during_paste": before_restore != after_write,
    }))
}

/// Manual smoke test for the clipboard snapshot/restore primitives used by
/// the auto-paste pipeline. Stages `text` on the pasteboard, waits
/// `hold_ms` so the caller can ⌘V into another app, then puts the original
/// clipboard contents back. The return value reports the change-count deltas
/// so the harness can verify no third party mutated the clipboard mid-paste.
#[command]
async fn debug_clipboard_roundtrip(
    text: String,
    hold_ms: u64,
) -> Result<serde_json::Value, String> {
    let snapshot = clipboard::save_clipboard()?;
    let before = snapshot.change_count();
    let item_count = snapshot.item_count();
    let after_write = clipboard::write_text(&text)?;

    tokio::time::sleep(std::time::Duration::from_millis(hold_ms)).await;

    let before_restore = clipboard::current_change_count()?;
    clipboard::restore_clipboard(&snapshot)?;
    let after_restore = clipboard::current_change_count()?;

    Ok(serde_json::json!({
        "saved_items": item_count,
        "change_count_before": before,
        "change_count_after_write": after_write,
        "change_count_before_restore": before_restore,
        "change_count_after_restore": after_restore,
        "clobbered_during_hold": before_restore != after_write,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ServerState {
            child: Mutex::new(None),
            server_pid: Mutex::new(None),
            models_dir: Mutex::new(None),
        })
        .manage(dictation::DictationState::default())
        .setup(|app| {
            dictation::restore(app.handle());
            #[cfg(desktop)]
            {
                // Resolve the active keyboard layout's V keycode now, on
                // the main thread, and register an observer for layout
                // changes. The synthetic-paste hot path then only reads an
                // atomic. See keyboard_layout.rs for why this matters
                // (Cmd+V is matched by translated character, not keycode,
                // so QWERTY keycode 9 produces Cmd+. on Dvorak).
                keyboard_layout::init();

                // HotkeyMonitor is spawned lazily via the `enable_hotkey`
                // command — see HotkeyState. The hidden dictate webview is
                // safe to build up front because it does not create the global
                // keyboard tap or trigger the macOS Input Monitoring prompt.
                app.manage(HotkeyState::default());

                // The frontend emits `dictate:hide` whenever the pill cycle
                // finishes (rest-fade → hidden). `hide()` alone has been
                // unreliable for transparent always-on-top windows on macOS
                // — the NSWindow lingers as an invisible click target that
                // steals focus to the Voicebox app when the user clicks
                // where it used to be. Park the window off-screen and mark
                // it click-through as well, so even if `hide()` no-ops the
                // user sees and interacts with nothing.
                let handle_for_hide = app.handle().clone();
                app.handle().listen("dictate:hide", move |_event| {
                    if let Some(window) = handle_for_hide.get_webview_window(DICTATE_WINDOW_LABEL) {
                        let _ = window.set_ignore_cursor_events(true);
                        let _ = window.set_position(PhysicalPosition::new(-10_000, -10_000));
                        let _ = window.hide();
                    }
                });

                ensure_dictate_window(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            restart_server,
            restart_app,
            debug_clipboard_roundtrip,
            debug_paste_text,
            debug_capture_focus,
            debug_focus_roundtrip,
            check_accessibility_permission,
            check_input_monitoring_permission,
            open_accessibility_settings,
            open_input_monitoring_settings,
            paste_final_text,
            enable_hotkey,
            disable_hotkey,
            update_chord_bindings,
            dictation::dictation_configure,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::list_input_devices
        ])
        .on_window_event({
            let closing = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            move |window, event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // If we're already in the close flow, let it proceed
                    if closing.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    closing.store(true, std::sync::atomic::Ordering::SeqCst);

                    // Prevent automatic close so frontend can clean up
                    api.prevent_close();

                    // Emit event to frontend to check setting and stop server if needed
                    let app_handle = window.app_handle();

                    if let Err(e) = app_handle.emit("window-close-requested", ()) {
                        eprintln!("Failed to emit window-close-requested event: {}", e);
                        window.close().ok();
                        return;
                    }

                    // Set up listener for frontend response
                    let window_for_close = window.clone();
                    let closing_for_timeout = closing.clone();
                    let (tx, mut rx) = mpsc::unbounded_channel::<()>();

                    let listener_id = window.listen("window-close-allowed", move |_| {
                        let _ = tx.send(());
                    });

                    tauri::async_runtime::spawn(async move {
                        tokio::select! {
                            _ = rx.recv() => {
                                window_for_close.close().ok();
                            }
                            _ = tokio::time::sleep(tokio::time::Duration::from_secs(5)) => {
                                eprintln!("Window close timeout, closing anyway");
                                window_for_close.close().ok();
                            }
                        }
                        window_for_close.unlisten(listener_id);
                        closing_for_timeout.store(false, std::sync::atomic::Ordering::SeqCst);
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                RunEvent::Exit => {
                    let state = app.state::<ServerState>();
                    if let Err(error) = stop_managed_server(&state) {
                        eprintln!("Failed to stop local server on exit: {error}");
                    }
                }
                RunEvent::ExitRequested { .. } => {
                    // Stop descendants before the shell plugin's Exit handler
                    // kills the launcher and reparents its PyInstaller worker.
                    let state = app.state::<ServerState>();
                    if let Err(error) = stop_managed_server(&state) {
                        eprintln!("Failed to stop local server before exit: {error}");
                    }
                }
                _ => {}
            }
        });
}

fn main() {
    run();
}
