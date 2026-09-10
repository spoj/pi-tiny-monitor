# pi-tiny-monitor

A small [Pi](https://github.com/badlogic/pi-mono) package that runs background shell commands and turns their stdout and exits into session wake-ups.

## Install

Install directly from this repository:

```bash
pi install git:github.com/spoj/pi-tiny-monitor
```

For a local checkout, use its path instead:

```bash
pi install /path/to/pi-tiny-monitor
```

Pi loads the extension declared in this package's `pi` manifest after installation. Review the source before installing: extensions run with full system access.

## Tools

The package adds two tools:

- `monitor({ command })` starts a background shell command and returns its monitor ID immediately.
- `monitor_stop({ id })` stops a running monitor.

A monitor reads stdout only. Output is delivered to the session in fixed 2-second batches per monitor as steer messages that trigger a turn. Commands run with Pi's current working directory. Redirect stderr to stdout when it should be monitored, for example:

```text
monitor({ command: "my-command 2>&1" })
```

Shell selection uses Pi's built-in bash resolver and `shellPath` setting, not `$SHELL` or `ComSpec`. By default, Pi uses `/bin/bash`, then bash on `PATH`, then `sh` on Unix; on Windows it uses Git Bash or bash on `PATH`. Commands are non-interactive, non-login shells. Pi's `shellCommandPrefix` is also applied. Global settings and trusted project overrides are honored.

When a command exits, the monitor immediately sends one wake-up combining its remaining stdout and the exit code or signal, even if the command produced no output. Explicit stops and session shutdown do not send exit wake-ups.

A widget above the editor shows `n monitors running` while monitors are active and disappears at zero.

Each monitor is stopped when its session shuts down. A noisy monitor is stopped automatically if stdout exceeds 50 KiB in one 2-second batch, 500 lines in 10 seconds, or 64 KiB in an unterminated line. The oversized batch is discarded and a limit notice is sent instead. Byte limits count UTF-8 bytes, including line separators, before sanitization.

Delivered output has ANSI sequences, carriage returns, and other terminal controls removed; tabs and newlines are preserved.

## Non-goals

This package does not provide:

- stderr capture by default
- output or state persistence
- logging, filtering, timeouts, retries, polling, scheduling, PTYs, tmux, process recovery, or restart reconciliation
- custom renderers, flags, settings, or slash commands
- fresh-agent or RPC semantics

Use shell tools such as `tee`, `grep --line-buffered`, or `awk` in the command when those behaviors are needed.
