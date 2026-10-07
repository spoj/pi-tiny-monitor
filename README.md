# pi-tiny-monitor

A Pi package for session-owned background commands.

## Monitor tools

- `monitor({ command })` runs the command in the current Pi cwd with Pi's configured shell, trusted project settings, and shell command prefix. It returns immediately with a run ID and log path.
- `monitor_stop({ id })` stops a run and its process tree. Pending output is flushed, but an explicit stop does not send an exit wake-up.

`/monitors` lists running monitors with their age and command, and `/monitors stop` picks one to stop.

Only the model can call these tools; Pi's codemode scripts cannot, because updates arrive as later messages rather than in the tool result.

Each run writes stdout and stderr to one log, `pi-run-<id>.log` in the OS temp directory (beside Pi's own `pi-bash-<id>.log` files), without a size cap. The process writes to the log's file descriptor directly and the manager reads the log about every 100 ms; there is no pipe, tee, or drain process.

Output is delivered in timed chunks, followed by one terminal update with status, exit information, and the log path. The first detected output starts a two-second timer; later writes do not reset it. Silent periods produce no updates. Chunks are not lines: a chunk can start in the middle of a line or end with a partial line. ANSI sequences and terminal controls are removed, preserving tabs and newlines. Updates use the compact form `[run-id]` followed by the sanitized chunk; relevant boundaries add `continues previous line` or `last line incomplete` inside the header.

Output is noisy-output safe:

- at most 50 KiB of raw bytes or decoded text per two-second batch;
- at most 500 visible newlines per ten seconds.

Exceeding either limit suppresses further updates, not the command. Full output remains in the log, and completion is still reported.

All ready updates share one pending steering message. Arrivals join that message until Pi begins delivering it; later arrivals start the next batch. An idle session wakes once for the pending batch. Human steering keeps its configured delivery mode: with `all`, the batch arrives together with queued human steering; with `one-at-a-time`, it takes its turn in the queue. Escape discards queued delivery as usual; future updates can wake the session again after it settles.

At most eight monitors may be active in one session. Session shutdown, reload, and replacement stop owned runs silently. Logs stay in the temp directory.

Compaction can summarize away the calls that started monitors, so after each compaction one message lists the monitors still running with their IDs, logs, and commands. During a run it arrives as steering; an idle session gets it appended without waking.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-monitor
```

Or try it locally:

```bash
pi -e ./src/index.ts
```

## Development

```bash
npm install
npm run check
```
