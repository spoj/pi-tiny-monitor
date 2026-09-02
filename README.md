# pi-tiny-monitor

A small [Pi](https://github.com/badlogic/pi-mono) package that runs background shell commands and turns their stdout into session wake-ups.

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

The package adds three tools:

- `monitor({ command })` starts a background shell command and returns its monitor ID immediately.
- `monitor_stop({ id })` stops a running monitor.
- `monitor_list()` lists running monitors.

A monitor reads stdout only. Output is delivered to the session in short batches as steer messages that trigger a turn. Commands run with Pi's current working directory. Redirect stderr to stdout when it should be monitored, for example:

```text
monitor({ command: "my-command 2>&1" })
```

Each monitor is stopped when its session shuts down. A noisy monitor is stopped automatically after exceeding the output rate limit.

## Non-goals

This package does not provide:

- stderr capture by default
- output or state persistence
- logging, filtering, timeouts, retries, polling, scheduling, PTYs, tmux, process recovery, or restart reconciliation
- custom UI, widgets, renderers, flags, settings, or slash commands
- fresh-agent or RPC semantics

Use shell tools such as `tee`, `grep --line-buffered`, or `awk` in the command when those behaviors are needed.
