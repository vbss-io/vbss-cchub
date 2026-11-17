use super::*;
use std::collections::VecDeque;
use std::io;
use std::sync::atomic::AtomicUsize;

#[cfg(windows)]
fn status(code: u32) -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(code)
}

#[cfg(unix)]
fn status(code: i32) -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(code << 8)
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cchub-desktop-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ProcState {
    polls: VecDeque<io::Result<Option<ExitStatus>>>,
    killed: bool,
    waited: bool,
}

struct FakeProcess(Arc<Mutex<ProcState>>);

impl Process for FakeProcess {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        lock(&self.0).polls.pop_front().unwrap_or(Ok(None))
    }

    fn kill(&mut self) -> io::Result<()> {
        lock(&self.0).killed = true;
        Ok(())
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        lock(&self.0).waited = true;
        Ok(status(0))
    }
}

struct FakeHost {
    base: Instant,
    offset: Mutex<Duration>,
    spawns: Mutex<VecDeque<Result<Arc<Mutex<ProcState>>, String>>>,
    spawn_calls: AtomicUsize,
    logs: Mutex<Vec<String>>,
}

impl FakeHost {
    fn new() -> Arc<Self> {
        Arc::new(FakeHost {
            base: Instant::now(),
            offset: Mutex::new(Duration::ZERO),
            spawns: Mutex::new(VecDeque::new()),
            spawn_calls: AtomicUsize::new(0),
            logs: Mutex::new(Vec::new()),
        })
    }

    fn advance(&self, by: Duration) {
        *lock(&self.offset) += by;
    }

    fn queue_child(&self) -> Arc<Mutex<ProcState>> {
        let proc_state = Arc::new(Mutex::new(ProcState::default()));
        lock(&self.spawns).push_back(Ok(Arc::clone(&proc_state)));
        proc_state
    }

    fn queue_failure(&self, message: &str) {
        lock(&self.spawns).push_back(Err(message.to_string()));
    }

    fn spawn_calls(&self) -> usize {
        self.spawn_calls.load(Ordering::SeqCst)
    }

    fn logs(&self) -> Vec<String> {
        lock(&self.logs).clone()
    }
}

impl Host for FakeHost {
    fn now(&self) -> Instant {
        self.base + *lock(&self.offset)
    }

    fn spawn(&self, _config: &SidecarConfig) -> Result<Box<dyn Process>, String> {
        self.spawn_calls.fetch_add(1, Ordering::SeqCst);
        match lock(&self.spawns).pop_front() {
            Some(Ok(proc_state)) => Ok(Box::new(FakeProcess(proc_state))),
            Some(Err(message)) => Err(message),
            None => Err("no child queued".to_string()),
        }
    }

    fn log(&self, line: &str) {
        lock(&self.logs).push(line.to_string());
    }
}

fn config() -> SidecarConfig {
    SidecarConfig {
        sidecar_dir: PathBuf::from("sidecar"),
        app_exe: "app.exe".to_string(),
    }
}

fn supervisor(host: &Arc<FakeHost>) -> Supervisor {
    Supervisor::with_host(Some(config()), Arc::clone(host) as Arc<dyn Host>)
}

fn fresh_state() -> SupervisorState {
    SupervisorState {
        child: None,
        started_at: None,
        restarts: Vec::new(),
        next_restart_at: None,
        gave_up: false,
    }
}

fn fake_sidecar(temp: &TempDir) -> SidecarConfig {
    let dir = temp.path().join("sidecar");
    fs::create_dir_all(&dir).unwrap();
    fs::copy(std::env::current_exe().unwrap(), dir.join("node.exe")).unwrap();
    fs::write(dir.join("server.cjs"), "").unwrap();
    SidecarConfig {
        sidecar_dir: dir,
        app_exe: "hub.exe".to_string(),
    }
}

fn sidecar_dir(temp: &TempDir, node: bool, server: bool) -> PathBuf {
    let dir = temp.path().join("sidecar");
    fs::create_dir_all(&dir).unwrap();
    if node {
        fs::write(dir.join("node.exe"), "").unwrap();
    }
    if server {
        fs::write(dir.join("server.cjs"), "").unwrap();
    }
    dir
}

#[test]
fn civil_from_days_matches_known_dates() {
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(20_000), (2024, 10, 4));
    assert_eq!(civil_from_days(11_016), (2000, 2, 29));
}

#[test]
fn civil_from_days_handles_dates_before_the_epoch_and_century_rules() {
    assert_eq!(civil_from_days(-1), (1969, 12, 31));
    assert_eq!(civil_from_days(-719_468), (0, 3, 1));
    assert_eq!(civil_from_days(47_540), (2100, 2, 28));
    assert_eq!(civil_from_days(47_541), (2100, 3, 1));
    assert_eq!(civil_from_days(19_782), (2024, 2, 29));
}

#[test]
fn format_iso_pads_every_field() {
    assert_eq!(format_iso(0), "1970-01-01T00:00:00Z");
    assert_eq!(format_iso(86_399), "1970-01-01T23:59:59Z");
    assert_eq!(format_iso(1_700_000_000), "2023-11-14T22:13:20Z");
    assert_eq!(format_iso(-1), "1969-12-31T23:59:59Z");
    assert_eq!(format_iso(3_661 + 9 * 86_400), "1970-01-10T01:01:01Z");
}

#[test]
fn epoch_secs_reads_the_clock_and_clamps_times_before_the_epoch() {
    assert_eq!(epoch_secs(UNIX_EPOCH + Duration::from_secs(42)), 42);
    assert_eq!(epoch_secs(UNIX_EPOCH - Duration::from_secs(5)), 0);
}

#[test]
fn iso_now_has_the_utc_timestamp_shape() {
    let stamp = iso_now();
    assert_eq!(stamp.len(), 20);
    assert!(stamp.ends_with('Z'));
    assert_eq!(&stamp[4..5], "-");
    assert_eq!(&stamp[10..11], "T");
    assert!(stamp.starts_with("20"));
}

#[test]
fn strip_verbatim_removes_only_the_extended_length_prefix() {
    assert_eq!(strip_verbatim(r"\\?\C:\app\resources"), r"C:\app\resources");
    assert_eq!(strip_verbatim(r"C:\app\resources"), r"C:\app\resources");
    assert_eq!(strip_verbatim(""), "");
}

#[test]
fn lock_recovers_from_a_poisoned_mutex() {
    let mutex = Arc::new(Mutex::new(7));
    let clone = Arc::clone(&mutex);
    let _ = thread::spawn(move || {
        let _guard = clone.lock().unwrap();
        panic!("poison the mutex");
    })
    .join();
    assert!(mutex.is_poisoned());
    assert_eq!(*lock(&mutex), 7);
}

#[test]
fn data_dir_for_creates_the_hub_dir_under_the_profile() {
    let temp = TempDir::new("datadir");
    let dir = data_dir_for(temp.path().to_str()).unwrap();
    assert_eq!(dir, temp.path().join(".vbss-cchub"));
    assert!(dir.is_dir());
    assert_eq!(data_dir_for(None), None);
}

#[test]
fn data_dir_for_returns_none_when_the_dir_cannot_be_created() {
    let temp = TempDir::new("datadir-blocked");
    let blocker = temp.path().join("file");
    fs::write(&blocker, "x").unwrap();
    assert_eq!(data_dir_for(blocker.to_str()), None);
}

#[test]
fn append_exit_log_in_appends_stamped_lines() {
    let temp = TempDir::new("exitlog");
    append_exit_log_in(temp.path(), "2026-01-02T03:04:05Z", "first");
    append_exit_log_in(temp.path(), "2026-01-02T03:04:06Z", "second line");
    let text = fs::read_to_string(temp.path().join("sidecar-exits.log")).unwrap();
    assert_eq!(
        text.replace("\r\n", "\n"),
        "2026-01-02T03:04:05Z first\n2026-01-02T03:04:06Z second line\n"
    );
}

#[test]
fn append_exit_log_in_ignores_an_unwritable_dir() {
    let temp = TempDir::new("exitlog-missing");
    let missing = temp.path().join("nope");
    append_exit_log_in(&missing, "2026-01-02T03:04:05Z", "lost");
    assert!(!missing.exists());
}

#[test]
fn open_server_log_in_writes_a_start_marker_and_appends() {
    let temp = TempDir::new("serverlog");
    drop(open_server_log_in(temp.path(), "2026-01-02T03:04:05Z").unwrap());
    drop(open_server_log_in(temp.path(), "2026-01-02T03:04:09Z").unwrap());
    let text = fs::read_to_string(temp.path().join("server.log")).unwrap();
    assert_eq!(
        text.replace("\r\n", "\n"),
        "--- sidecar start 2026-01-02T03:04:05Z ---\n--- sidecar start 2026-01-02T03:04:09Z ---\n"
    );
    assert!(!temp.path().join("server.log.1").exists());
}

#[test]
fn open_server_log_in_rotates_a_log_above_the_limit() {
    let temp = TempDir::new("serverlog-rotate");
    let path = temp.path().join("server.log");
    let big = vec![b'x'; (LOG_ROTATE_BYTES + 1) as usize];
    fs::write(&path, &big).unwrap();
    fs::write(temp.path().join("server.log.1"), "stale").unwrap();
    drop(open_server_log_in(temp.path(), "2026-01-02T03:04:05Z").unwrap());
    assert_eq!(
        fs::metadata(temp.path().join("server.log.1"))
            .unwrap()
            .len(),
        big.len() as u64
    );
    let text = fs::read_to_string(&path).unwrap();
    assert_eq!(
        text.trim_end(),
        "--- sidecar start 2026-01-02T03:04:05Z ---"
    );
}

#[test]
fn open_server_log_in_keeps_a_log_at_the_limit() {
    let temp = TempDir::new("serverlog-keep");
    let path = temp.path().join("server.log");
    fs::write(&path, vec![b'y'; LOG_ROTATE_BYTES as usize]).unwrap();
    drop(open_server_log_in(temp.path(), "2026-01-02T03:04:05Z").unwrap());
    assert!(!temp.path().join("server.log.1").exists());
    assert!(fs::metadata(&path).unwrap().len() > LOG_ROTATE_BYTES);
}

#[test]
fn open_server_log_in_returns_none_when_the_log_cannot_be_opened() {
    let temp = TempDir::new("serverlog-blocked");
    fs::create_dir(temp.path().join("server.log")).unwrap();
    assert!(open_server_log_in(temp.path(), "2026-01-02T03:04:05Z").is_none());
}

#[test]
fn resolve_config_from_requires_both_sidecar_files() {
    let only_node = TempDir::new("config-only-node");
    sidecar_dir(&only_node, true, false);
    assert!(resolve_config_from(only_node.path(), Ok(PathBuf::from("app.exe"))).is_none());
    let only_server = TempDir::new("config-only-server");
    sidecar_dir(&only_server, false, true);
    assert!(resolve_config_from(only_server.path(), Ok(PathBuf::from("app.exe"))).is_none());
    let empty = TempDir::new("config-empty");
    assert!(resolve_config_from(empty.path(), Ok(PathBuf::from("app.exe"))).is_none());
}

#[test]
fn resolve_config_from_builds_the_config_and_strips_verbatim_prefixes() {
    let temp = TempDir::new("config-ok");
    let dir = sidecar_dir(&temp, true, true);
    let config =
        resolve_config_from(temp.path(), Ok(PathBuf::from(r"\\?\C:\Apps\hub.exe"))).unwrap();
    assert_eq!(config.sidecar_dir, dir);
    assert_eq!(config.app_exe, r"C:\Apps\hub.exe");
}

#[test]
fn resolve_config_from_defaults_the_app_exe_when_unknown() {
    let temp = TempDir::new("config-noexe");
    sidecar_dir(&temp, true, true);
    let failure = Err(io::Error::new(io::ErrorKind::NotFound, "no exe"));
    let config = resolve_config_from(temp.path(), failure).unwrap();
    assert_eq!(config.app_exe, "");
}

#[test]
fn spawn_child_reports_a_missing_binary() {
    let temp = TempDir::new("spawn-missing");
    let config = SidecarConfig {
        sidecar_dir: temp.path().join("nowhere"),
        app_exe: String::new(),
    };
    let error = spawn_child(&config, None).err().unwrap();
    assert!(!error.is_empty());
}

#[test]
fn spawn_child_runs_the_binary_and_redirects_output_to_the_server_log() {
    let temp = TempDir::new("spawn-real");
    let config = fake_sidecar(&temp);
    let logs = temp.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    let mut child = spawn_child(&config, Some(&logs)).unwrap();
    let exit = child.wait().unwrap();
    assert!(!exit.success());
    let text = fs::read_to_string(logs.join("server.log")).unwrap();
    assert!(text.starts_with("--- sidecar start "));
    assert!(text.contains("use-system-ca"));
}

#[test]
fn spawn_child_without_a_log_dir_still_spawns() {
    let temp = TempDir::new("spawn-nolog");
    let config = fake_sidecar(&temp);
    let mut child = spawn_child(&config, None).unwrap();
    assert!(!child.wait().unwrap().success());
}

#[test]
fn child_process_adapter_delegates_to_the_real_child() {
    let temp = TempDir::new("adapter");
    let config = fake_sidecar(&temp);
    let mut process: Box<dyn Process> = Box::new(spawn_child(&config, None).unwrap());
    let _ = process.kill();
    let exit = process.wait().unwrap();
    assert!(process.try_wait().unwrap().is_some() || !exit.success());
}

#[test]
fn system_host_logs_and_spawns_inside_the_profile() {
    let temp = TempDir::new("system-host");
    let config = fake_sidecar(&temp);
    let profile = temp.path().join("profile");
    fs::create_dir_all(&profile).unwrap();
    let host = SystemHost::with_profile(profile.to_str().map(str::to_string));

    host.log("hello from the host");
    let log = fs::read_to_string(profile.join(".vbss-cchub").join("sidecar-exits.log")).unwrap();
    assert!(log.trim_end().ends_with("Z hello from the host"));

    let before = host.now();
    let mut child = host.spawn(&config).unwrap();
    assert!(host.now() >= before);
    let _ = child.wait();
    let server_log = fs::read_to_string(profile.join(".vbss-cchub").join("server.log")).unwrap();
    assert!(server_log.starts_with("--- sidecar start "));
}

#[test]
fn system_host_without_a_profile_does_not_log_and_fails_to_spawn_a_missing_sidecar() {
    let host = SystemHost::with_profile(None);
    host.log("nowhere to write");
    let config = SidecarConfig {
        sidecar_dir: PathBuf::from("definitely-missing-sidecar-dir"),
        app_exe: String::new(),
    };
    assert!(host.spawn(&config).is_err());
    assert!(host.data_dir().is_none());
}

#[test]
fn system_host_new_reads_the_user_profile_environment() {
    let host = SystemHost::new();
    assert_eq!(host.profile, std::env::var("USERPROFILE").ok());
}

#[test]
fn schedule_or_give_up_walks_the_backoff_table_then_gives_up() {
    let now = Instant::now();
    let mut state = fresh_state();
    let mut messages = Vec::new();
    for _ in 0..BACKOFF_SECS.len() {
        messages.push(Supervisor::schedule_or_give_up(&mut state, now));
        assert!(!state.gave_up);
        state.restarts.push(now);
    }
    assert_eq!(
        messages,
        vec![
            "action=restart in 2s",
            "action=restart in 5s",
            "action=restart in 15s",
            "action=restart in 30s",
            "action=restart in 60s",
        ]
    );
    assert_eq!(state.next_restart_at, Some(now + Duration::from_secs(60)));
    let last = Supervisor::schedule_or_give_up(&mut state, now);
    assert_eq!(last, "action=giving up after 5 restarts within 10 minutes");
    assert!(state.gave_up);
    assert_eq!(state.next_restart_at, None);
}

#[test]
fn schedule_or_give_up_forgets_restarts_outside_the_window() {
    let base = Instant::now();
    let mut state = fresh_state();
    state.restarts = vec![base; 5];
    let now = base + RESTART_WINDOW;
    let message = Supervisor::schedule_or_give_up(&mut state, now);
    assert_eq!(message, "action=restart in 2s");
    assert!(state.restarts.is_empty());
    assert!(!state.gave_up);
}

#[test]
fn schedule_or_give_up_keeps_restarts_inside_the_window() {
    let base = Instant::now();
    let mut state = fresh_state();
    state.restarts = vec![base, base, base];
    let now = base + RESTART_WINDOW - Duration::from_secs(1);
    let message = Supervisor::schedule_or_give_up(&mut state, now);
    assert_eq!(message, "action=restart in 30s");
    assert_eq!(state.restarts.len(), 3);
}

#[test]
fn begin_without_a_config_does_nothing() {
    let host = FakeHost::new();
    let supervisor = Supervisor::with_host(None, Arc::clone(&host) as Arc<dyn Host>);
    supervisor.begin();
    assert_eq!(host.spawn_calls(), 0);
    assert!(lock(&supervisor.state).child.is_none());
}

#[test]
fn start_without_a_config_does_nothing() {
    let host = FakeHost::new();
    let supervisor = Supervisor::with_host(None, Arc::clone(&host) as Arc<dyn Host>);
    let mut state = fresh_state();
    supervisor.start(&mut state, host.now(), true);
    assert_eq!(host.spawn_calls(), 0);
    assert!(state.restarts.is_empty());
}

#[test]
fn begin_starts_the_sidecar_without_counting_a_restart() {
    let host = FakeHost::new();
    host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    let state = lock(&supervisor.state);
    assert!(state.child.is_some());
    assert_eq!(state.started_at, Some(host.now()));
    assert!(state.restarts.is_empty());
    assert_eq!(state.next_restart_at, None);
    assert!(host.logs().is_empty());
}

#[test]
fn start_as_a_restart_records_the_attempt() {
    let host = FakeHost::new();
    host.queue_child();
    let supervisor = supervisor(&host);
    let mut state = fresh_state();
    state.next_restart_at = Some(host.now());
    supervisor.start(&mut state, host.now(), true);
    assert!(state.child.is_some());
    assert_eq!(state.restarts, vec![host.now()]);
    assert_eq!(state.next_restart_at, None);
}

#[test]
fn start_failure_schedules_a_retry_and_logs_the_error() {
    let host = FakeHost::new();
    host.queue_failure("boom");
    let supervisor = supervisor(&host);
    let mut state = fresh_state();
    supervisor.start(&mut state, host.now(), false);
    assert!(state.child.is_none());
    assert!(state.restarts.is_empty());
    assert_eq!(
        state.next_restart_at,
        Some(host.now() + Duration::from_secs(2))
    );
    assert_eq!(
        host.logs(),
        vec!["spawn failed error=boom action=restart in 2s".to_string()]
    );
}

#[test]
fn start_failure_on_a_restart_counts_the_attempt_and_backs_off_further() {
    let host = FakeHost::new();
    host.queue_failure("still down");
    let supervisor = supervisor(&host);
    let mut state = fresh_state();
    supervisor.start(&mut state, host.now(), true);
    assert_eq!(state.restarts.len(), 1);
    assert_eq!(
        state.next_restart_at,
        Some(host.now() + Duration::from_secs(5))
    );
    assert_eq!(
        host.logs(),
        vec!["spawn failed error=still down action=restart in 5s".to_string()]
    );
}

#[test]
fn handle_exit_clears_the_child_and_schedules_a_restart() {
    let host = FakeHost::new();
    host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    host.advance(Duration::from_secs(30));
    let mut state = lock(&supervisor.state);
    supervisor.handle_exit(&mut state, host.now(), status(1));
    assert!(state.child.is_none());
    assert_eq!(state.started_at, None);
    assert_eq!(
        state.next_restart_at,
        Some(host.now() + Duration::from_secs(2))
    );
    assert_eq!(
        host.logs(),
        vec![format!(
            "sidecar exited status={} uptime=30s action=restart in 2s",
            status(1)
        )]
    );
}

#[test]
fn handle_exit_after_a_stable_run_resets_the_restart_history() {
    let host = FakeHost::new();
    host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    let mut state = lock(&supervisor.state);
    state.restarts = vec![host.now(); 4];
    host.advance(STABLE_RUN);
    supervisor.handle_exit(&mut state, host.now(), status(0));
    assert!(state.restarts.is_empty());
    assert!(!state.gave_up);
    assert_eq!(
        host.logs(),
        vec![format!(
            "sidecar exited status={} uptime=600s action=restart in 2s",
            status(0)
        )]
    );
}

#[test]
fn handle_exit_after_a_short_run_keeps_the_history_and_gives_up_at_the_limit() {
    let host = FakeHost::new();
    host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    let mut state = lock(&supervisor.state);
    state.restarts = vec![host.now(); 5];
    host.advance(Duration::from_secs(5));
    supervisor.handle_exit(&mut state, host.now(), status(3));
    assert_eq!(state.restarts.len(), 5);
    assert!(state.gave_up);
    assert_eq!(state.next_restart_at, None);
    assert_eq!(
        host.logs(),
        vec![format!(
            "sidecar exited status={} uptime=5s action=giving up after 5 restarts within 10 minutes",
            status(3)
        )]
    );
}

#[test]
fn handle_exit_without_a_known_start_reports_zero_uptime() {
    let host = FakeHost::new();
    let supervisor = supervisor(&host);
    let mut state = fresh_state();
    supervisor.handle_exit(&mut state, host.now(), status(2));
    assert_eq!(
        host.logs(),
        vec![format!(
            "sidecar exited status={} uptime=0s action=restart in 2s",
            status(2)
        )]
    );
}

#[test]
fn tick_leaves_a_running_child_alone() {
    let host = FakeHost::new();
    let child = host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    supervisor.tick();
    assert!(lock(&supervisor.state).child.is_some());
    assert!(!lock(&child).killed);
    assert!(host.logs().is_empty());
    assert_eq!(host.spawn_calls(), 1);
}

#[test]
fn tick_detects_an_exit_then_restarts_after_the_backoff() {
    let host = FakeHost::new();
    let first = host.queue_child();
    host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    lock(&first).polls.push_back(Ok(Some(status(1))));
    host.advance(Duration::from_secs(1));
    supervisor.tick();
    assert!(lock(&supervisor.state).child.is_none());
    assert_eq!(host.logs().len(), 1);

    host.advance(Duration::from_secs(1));
    supervisor.tick();
    assert!(lock(&supervisor.state).child.is_none());
    assert_eq!(host.spawn_calls(), 1);

    host.advance(Duration::from_secs(1));
    supervisor.tick();
    let state = lock(&supervisor.state);
    assert!(state.child.is_some());
    assert_eq!(state.restarts.len(), 1);
    assert_eq!(host.spawn_calls(), 2);
}

#[test]
fn tick_does_not_restart_after_giving_up() {
    let host = FakeHost::new();
    let supervisor = supervisor(&host);
    {
        let mut state = lock(&supervisor.state);
        state.gave_up = true;
        state.next_restart_at = Some(host.now());
    }
    host.advance(Duration::from_secs(120));
    supervisor.tick();
    assert_eq!(host.spawn_calls(), 0);
}

#[test]
fn tick_with_no_child_and_no_schedule_does_nothing() {
    let host = FakeHost::new();
    let supervisor = supervisor(&host);
    supervisor.tick();
    assert_eq!(host.spawn_calls(), 0);
    assert!(host.logs().is_empty());
}

#[test]
fn tick_logs_a_try_wait_failure_and_keeps_the_child() {
    let host = FakeHost::new();
    let child = host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    lock(&child)
        .polls
        .push_back(Err(io::Error::other("poll broke")));
    supervisor.tick();
    assert!(lock(&supervisor.state).child.is_some());
    assert_eq!(
        host.logs(),
        vec!["try_wait failed error=poll broke".to_string()]
    );
}

#[test]
fn tick_is_a_no_op_while_shutting_down() {
    let host = FakeHost::new();
    let child = host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    lock(&child).polls.push_back(Ok(Some(status(1))));
    supervisor.shutting_down.store(true, Ordering::SeqCst);
    supervisor.tick();
    assert!(host.logs().is_empty());
    assert_eq!(lock(&child).polls.len(), 1);
}

#[test]
fn repeated_crashes_exhaust_the_backoff_table_and_stop_restarting() {
    let host = FakeHost::new();
    let mut children = vec![host.queue_child()];
    let supervisor = supervisor(&host);
    supervisor.begin();
    for _ in 0..BACKOFF_SECS.len() {
        lock(children.last().unwrap())
            .polls
            .push_back(Ok(Some(status(1))));
        supervisor.tick();
        children.push(host.queue_child());
        host.advance(Duration::from_secs(61));
        supervisor.tick();
    }
    lock(children.last().unwrap())
        .polls
        .push_back(Ok(Some(status(1))));
    supervisor.tick();
    let state = lock(&supervisor.state);
    assert!(state.gave_up);
    assert!(state.child.is_none());
    assert_eq!(
        host.logs().last().unwrap(),
        &format!(
            "sidecar exited status={} uptime=0s action=giving up after 5 restarts within 10 minutes",
            status(1)
        )
    );
    drop(state);
    host.advance(Duration::from_secs(3_600));
    let calls = host.spawn_calls();
    supervisor.tick();
    assert_eq!(host.spawn_calls(), calls);
}

#[test]
fn restart_requires_a_bundled_sidecar() {
    let host = FakeHost::new();
    let supervisor = Supervisor::with_host(None, Arc::clone(&host) as Arc<dyn Host>);
    assert_eq!(
        supervisor.restart(),
        Err("sidecar is not bundled in this build".to_string())
    );
}

#[test]
fn restart_is_refused_while_shutting_down() {
    let host = FakeHost::new();
    let supervisor = supervisor(&host);
    supervisor.shutdown();
    assert_eq!(
        supervisor.restart(),
        Err("app is shutting down".to_string())
    );
    assert_eq!(host.spawn_calls(), 0);
}

#[test]
fn restart_replaces_the_running_child_and_resets_the_state() {
    let host = FakeHost::new();
    let old = host.queue_child();
    let new = host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    {
        let mut state = lock(&supervisor.state);
        state.restarts = vec![host.now(); 3];
        state.gave_up = true;
        state.next_restart_at = Some(host.now());
    }
    assert_eq!(supervisor.restart(), Ok(()));
    assert!(lock(&old).killed);
    assert!(lock(&old).waited);
    assert!(!lock(&new).killed);
    let state = lock(&supervisor.state);
    assert!(state.child.is_some());
    assert!(state.restarts.is_empty());
    assert!(!state.gave_up);
    assert_eq!(state.next_restart_at, None);
    assert_eq!(host.logs(), vec!["manual restart requested".to_string()]);
}

#[test]
fn restart_reports_a_failed_spawn() {
    let host = FakeHost::new();
    host.queue_failure("cannot spawn");
    let supervisor = supervisor(&host);
    assert_eq!(
        supervisor.restart(),
        Err("failed to start the sidecar, see sidecar-exits.log".to_string())
    );
    assert_eq!(
        host.logs(),
        vec![
            "manual restart requested".to_string(),
            "spawn failed error=cannot spawn action=restart in 2s".to_string(),
        ]
    );
    assert!(lock(&supervisor.state).child.is_none());
}

#[test]
fn shutdown_kills_the_child_and_blocks_further_work() {
    let host = FakeHost::new();
    let child = host.queue_child();
    let supervisor = supervisor(&host);
    supervisor.begin();
    assert!(!supervisor.is_shutting_down());
    supervisor.shutdown();
    assert!(supervisor.is_shutting_down());
    assert!(lock(&child).killed);
    assert!(lock(&child).waited);
    assert!(lock(&supervisor.state).child.is_none());
    supervisor.shutdown();
}

#[test]
fn supervision_thread_restarts_a_crashed_child_and_stops_on_shutdown() {
    let host = FakeHost::new();
    let first = host.queue_child();
    host.queue_child();
    let supervisor = Arc::new(supervisor(&host));
    supervisor.begin();
    lock(&first).polls.push_back(Ok(Some(status(1))));
    let handle = spawn_supervision(Arc::clone(&supervisor), Duration::from_millis(2));
    let deadline = Instant::now() + Duration::from_secs(10);
    while host.spawn_calls() < 2 && Instant::now() < deadline {
        host.advance(Duration::from_secs(3));
        thread::sleep(Duration::from_millis(5));
    }
    supervisor.shutdown();
    handle.join().unwrap();
    assert_eq!(host.spawn_calls(), 2);
    assert!(supervisor.is_shutting_down());
}

#[test]
fn supervise_hands_the_supervisor_to_a_poll_thread() {
    let host = FakeHost::new();
    let supervisor = Arc::new(supervisor(&host));
    supervisor.shutdown();
    supervise(Arc::clone(&supervisor));
    assert!(supervisor.is_shutting_down());
}

#[test]
fn new_builds_a_supervisor_on_the_system_host() {
    let supervisor = Supervisor::new(None);
    assert_eq!(
        supervisor.restart(),
        Err("sidecar is not bundled in this build".to_string())
    );
    supervisor.begin();
    assert!(lock(&supervisor.state).child.is_none());
}

#[test]
fn tray_action_maps_each_menu_id() {
    assert_eq!(tray_action("open"), TrayAction::ShowMain);
    assert_eq!(tray_action("widget"), TrayAction::ToggleWidget);
    assert_eq!(tray_action("quit"), TrayAction::Quit);
    assert_eq!(tray_action("other"), TrayAction::Ignore);
    assert_eq!(tray_action(""), TrayAction::Ignore);
}

#[test]
fn widget_toggle_hides_a_visible_widget_and_shows_otherwise() {
    assert_eq!(widget_toggle(Some(true)), WidgetToggle::Hide);
    assert_eq!(widget_toggle(Some(false)), WidgetToggle::ShowAndAnnounce);
    assert_eq!(widget_toggle(None), WidgetToggle::ShowAndAnnounce);
}

#[test]
fn only_the_main_window_hides_on_close() {
    assert!(hides_on_close("main"));
    assert!(!hides_on_close("widget"));
    assert!(!hides_on_close("toast"));
}
