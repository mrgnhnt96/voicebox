//! Stop the bundled server, including the worker spawned by PyInstaller.
use std::process::Command;

#[cfg(unix)]
fn descendants(root: u32, processes: &[(u32, u32)]) -> Vec<u32> {
    let mut result = vec![root];
    let mut index = 0;
    while index < result.len() {
        let parent = result[index];
        for &(pid, ppid) in processes {
            if ppid == parent && !result.contains(&pid) {
                result.push(pid);
            }
        }
        index += 1;
    }
    result.reverse();
    result
}

pub fn stop(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        let output = Command::new("ps")
            .args(["-axo", "pid=,ppid="])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not inspect the server process tree".into());
        }
        let processes: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
            })
            .collect();
        let pids = descendants(pid, &processes);
        for signal in ["-TERM", "-KILL"] {
            for child in &pids {
                let _ = Command::new("kill")
                    .args([signal, &child.to_string()])
                    .output();
            }
            if signal == "-TERM" {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }
    #[cfg(windows)]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn includes_nested_workers_but_not_unrelated_processes() {
        assert_eq!(
            descendants(10, &[(30, 20), (20, 10), (11, 1), (10, 1)]),
            vec![30, 20, 10]
        );
    }

    #[test]
    fn stops_worker_outside_a_dedicated_process_group() {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;
        let mut parent = Command::new("sh")
            .args(["-c", "sleep 120 & echo $!; wait"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(parent.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let worker: u32 = line.trim().parse().unwrap();
        stop(parent.id()).unwrap();
        parent.wait().unwrap();
        let output = Command::new("ps")
            .args(["-p", &worker.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "worker still alive: {state}"
        );
    }
}
