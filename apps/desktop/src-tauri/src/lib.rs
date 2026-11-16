mod app;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub use app::run;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const BACKOFF_SECS: [u64; 5] = [2, 5, 15, 30, 60];
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
const STABLE_RUN: Duration = Duration::from_secs(10 * 60);
const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

struct SidecarConfig {
    sidecar_dir: PathBuf,
    app_exe: String,
}

trait Process: Send {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>>;
    fn kill(&mut self) -> std::io::Result<()>;
    fn wait(&mut self) -> std::io::Result<ExitStatus>;
}

impl Process for Child {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        Child::try_wait(self)
    }

    fn kill(&mut self) -> std::io::Result<()> {
        Child::kill(self)
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        Child::wait(self)
    }
}

trait Host: Send + Sync {
    fn now(&self) -> Instant;
    fn spawn(&self, config: &SidecarConfig) -> Result<Box<dyn Process>, String>;
    fn log(&self, line: &str);
}

struct SystemHost {
    profile: Option<String>,
}

struct SupervisorState {
    child: Option<Box<dyn Process>>,
    started_at: Option<Instant>,
    restarts: Vec<Instant>,
    next_restart_at: Option<Instant>,
    gave_up: bool,
}

pub struct Supervisor {
    config: Option<SidecarConfig>,
    host: Arc<dyn Host>,
    state: Mutex<SupervisorState>,
    shutting_down: AtomicBool,
}

enum Poll {
    Running,
    Exited(ExitStatus),
    Failed(std::io::Error),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn strip_verbatim(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn epoch_secs(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn format_iso(secs: i64) -> String {
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

fn iso_now() -> String {
    format_iso(epoch_secs(SystemTime::now()))
}

fn data_dir_for(profile: Option<&str>) -> Option<PathBuf> {
    let dir = PathBuf::from(profile?).join(".vbss-cchub");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn append_exit_log_in(dir: &Path, stamp: &str, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("sidecar-exits.log"))
    {
        let _ = writeln!(file, "{stamp} {line}");
    }
}

fn resolve_config_from(
    resource_dir: &Path,
    current_exe: std::io::Result<PathBuf>,
) -> Option<SidecarConfig> {
    // Tauri returns an extended-length (\\?\) path on Windows; Node/better-sqlite3 cannot
    // resolve it (fs.lstat fails), so strip the verbatim prefix before spawning.
    let sidecar_dir =
        PathBuf::from(strip_verbatim(&resource_dir.to_string_lossy())).join("sidecar");
    if !sidecar_dir.join("node.exe").exists() || !sidecar_dir.join("server.cjs").exists() {
        return None;
    }
    let app_exe = current_exe
        .map(|p| strip_verbatim(&p.to_string_lossy()))
        .unwrap_or_default();
    Some(SidecarConfig {
        sidecar_dir,
        app_exe,
    })
}

fn open_server_log_in(dir: &Path, stamp: &str) -> Option<fs::File> {
    let path = dir.join("server.log");
    if fs::metadata(&path)
        .map(|m| m.len() > LOG_ROTATE_BYTES)
        .unwrap_or(false)
    {
        let rotated = dir.join("server.log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&path, &rotated);
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let _ = writeln!(file, "--- sidecar start {stamp} ---");
    Some(file)
}

fn spawn_child(config: &SidecarConfig, log_dir: Option<&Path>) -> Result<Child, String> {
    let mut cmd = Command::new(config.sidecar_dir.join("node.exe"));
    cmd.arg("--use-system-ca")
        .arg(config.sidecar_dir.join("server.cjs"))
        .env("HUB_RESOURCE_DIR", &config.sidecar_dir)
        .env("HUB_DELEGATION", "1")
        .env("HUB_APP_EXE", &config.app_exe)
        .env("HUB_PARENT_PID", std::process::id().to_string());
    if let Some(log) = log_dir.and_then(|dir| open_server_log_in(dir, &iso_now())) {
        if let Ok(log2) = log.try_clone() {
            cmd.stdout(log).stderr(log2);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map_err(|e| e.to_string())
}

impl SystemHost {
    fn new() -> Self {
        Self::with_profile(std::env::var("USERPROFILE").ok())
    }

    fn with_profile(profile: Option<String>) -> Self {
        SystemHost { profile }
    }

    fn data_dir(&self) -> Option<PathBuf> {
        data_dir_for(self.profile.as_deref())
    }
}

impl Host for SystemHost {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn spawn(&self, config: &SidecarConfig) -> Result<Box<dyn Process>, String> {
        let dir = self.data_dir();
        spawn_child(config, dir.as_deref()).map(|child| Box::new(child) as Box<dyn Process>)
    }

    fn log(&self, line: &str) {
        let Some(dir) = self.data_dir() else { return };
        append_exit_log_in(&dir, &iso_now(), line);
    }
}

impl Supervisor {
    fn new(config: Option<SidecarConfig>) -> Self {
        Self::with_host(config, Arc::new(SystemHost::new()))
    }

    fn with_host(config: Option<SidecarConfig>, host: Arc<dyn Host>) -> Self {
        Supervisor {
            config,
            host,
            state: Mutex::new(SupervisorState {
                child: None,
                started_at: None,
                restarts: Vec::new(),
                next_restart_at: None,
                gave_up: false,
            }),
            shutting_down: AtomicBool::new(false),
        }
    }

    fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    fn schedule_or_give_up(state: &mut SupervisorState, now: Instant) -> String {
        state
            .restarts
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        match BACKOFF_SECS.get(state.restarts.len()) {
            Some(secs) => {
                state.next_restart_at = Some(now + Duration::from_secs(*secs));
                format!("action=restart in {secs}s")
            }
            None => {
                state.next_restart_at = None;
                state.gave_up = true;
                format!(
                    "action=giving up after {} restarts within {} minutes",
                    BACKOFF_SECS.len(),
                    RESTART_WINDOW.as_secs() / 60
                )
            }
        }
    }

    fn start(&self, state: &mut SupervisorState, now: Instant, is_restart: bool) {
        let Some(config) = self.config.as_ref() else {
            return;
        };
        match self.host.spawn(config) {
            Ok(child) => {
                state.child = Some(child);
                state.started_at = Some(now);
                state.next_restart_at = None;
                if is_restart {
                    state.restarts.push(now);
                }
            }
            Err(error) => {
                if is_restart {
                    state.restarts.push(now);
                }
                let action = Self::schedule_or_give_up(state, now);
                self.host
                    .log(&format!("spawn failed error={error} {action}"));
            }
        }
    }

    fn handle_exit(&self, state: &mut SupervisorState, now: Instant, status: ExitStatus) {
        let uptime = state
            .started_at
            .map(|started| now.duration_since(started))
            .unwrap_or_default();
        state.child = None;
        state.started_at = None;
        if uptime >= STABLE_RUN {
            state.restarts.clear();
        }
        let action = Self::schedule_or_give_up(state, now);
        self.host.log(&format!(
            "sidecar exited status={status} uptime={}s {action}",
            uptime.as_secs()
        ));
    }

    fn tick(&self) {
        if self.is_shutting_down() {
            return;
        }
        let mut state = lock(&self.state);
        let now = self.host.now();
        let polled = match state.child.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => Poll::Running,
                Ok(Some(status)) => Poll::Exited(status),
                Err(error) => Poll::Failed(error),
            },
            None => {
                if !state.gave_up && state.next_restart_at.is_some_and(|at| now >= at) {
                    self.start(&mut state, now, true);
                }
                return;
            }
        };
        match polled {
            Poll::Running => {}
            Poll::Exited(status) => self.handle_exit(&mut state, now, status),
            Poll::Failed(error) => self.host.log(&format!("try_wait failed error={error}")),
        }
    }

    fn begin(&self) {
        if self.config.is_none() {
            return;
        }
        let mut state = lock(&self.state);
        self.start(&mut state, self.host.now(), false);
    }

    pub fn restart(&self) -> Result<(), String> {
        if self.config.is_none() {
            return Err("sidecar is not bundled in this build".to_string());
        }
        if self.is_shutting_down() {
            return Err("app is shutting down".to_string());
        }
        let mut state = lock(&self.state);
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        state.started_at = None;
        state.restarts.clear();
        state.next_restart_at = None;
        state.gave_up = false;
        self.host.log("manual restart requested");
        self.start(&mut state, self.host.now(), false);
        if state.child.is_some() {
            Ok(())
        } else {
            Err("failed to start the sidecar, see sidecar-exits.log".to_string())
        }
    }

    fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let mut state = lock(&self.state);
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_supervision(supervisor: Arc<Supervisor>, interval: Duration) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !supervisor.is_shutting_down() {
            thread::sleep(interval);
            supervisor.tick();
        }
    })
}

fn supervise(supervisor: Arc<Supervisor>) {
    spawn_supervision(supervisor, POLL_INTERVAL);
}

#[cfg(test)]
mod tests;
