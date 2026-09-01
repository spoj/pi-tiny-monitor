# pi-tiny-monitor

Minimal session-scoped background processes for Pi.

## Contract

- `monitor_start` runs a shell command in the current `ctx.cwd` and returns an ID.
- Complete stdout lines are subscribed to while the process runs.
- Lines arriving within 200ms are delivered as one follow-up message.
- More than 50 lines/sec over a 10-second window stops that monitor.
- `monitor_stop` kills the process group; `monitor_list` reports active jobs.
- All processes stop when the Pi session shuts down.
- There is no persistence, stderr reader, timeout, PTY, file watcher, or process recovery. Use `tee`, pipes, or shell redirection when output should be retained.

Messages use `pi.sendMessage()` with `deliverAs: "followUp"` and `triggerTurn: true`. Output is external process data; callers should filter it in the shell when appropriate:

```sh
npm run dev 2>&1 | grep --line-buffered -E 'error|ready'
```

## Install

```sh
pi install /home/spoj/pi-tiny-monitor
```

The package is intentionally a sibling of `pi-tiny-fork`: the fork owns bidirectional Pi RPC processes, while this package owns one-way shell output subscriptions. A fresh Pi can be launched through `monitor_start`; its stdout is then handled like any other command output.

## Development

The implementation is `extensions/monitor.ts`. It uses only Pi's `ExtensionAPI`, `ExtensionContext`, `pi.registerTool()`, `pi.sendMessage()`, and `session_shutdown`, plus Node's `child_process.spawn()`.
