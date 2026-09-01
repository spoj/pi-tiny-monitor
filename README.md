# pi-tiny-monitor

Implementation handoff for a deliberately small Pi extension that turns a background process's stdout into session wake-ups.

This repository is a scaffold, not a working extension yet.

## Required model-facing surface

- `monitor({ command })` starts a process and returns its ID immediately.
- `monitor_stop({ id })` stops one running process.
- `monitor_list()` lists running processes.

No other tools or slash commands.

## Deliberate non-goals

- Output or state persistence.
- Capturing or reading stderr. Callers can use `2>&1` when stderr should be monitored.
- Logging. Callers can use `tee` or redirect to a file.
- Regex or substring filtering. Callers can use `grep --line-buffered` or `awk`.
- Timeouts, retries, polling, scheduling, PTYs, tmux, process recovery, or restart reconciliation.
- Custom UI, widgets, renderers, flags, settings, and slash commands.
- Fresh-agent or RPC semantics. `pi -p "task"` is just another command a monitor may run.

## Implementation shape

Keep it in `src/index.ts` unless a pure helper is independently worth testing. The expected state is one `Map<string, ProcessRecord>` captured by the extension factory. A record only needs identity, label, child handle, coalescing state, rate-window timestamps, and stopping state.

Prefer direct `node:child_process` APIs. Do not add a process library unless direct process-tree termination proves insufficient on a supported platform. Do not depend on another Pi monitor package.

Only add behavior required above. In particular, do not reproduce the broader feature sets of existing monitor packages.

## Pi pointers

Installed Pi documentation:

- `docs/extensions.md#long-lived-resources-and-shutdown`
- `docs/extensions.md#pisendmessagemessage-options`
- `docs/extensions.md#piexeccommand-args-options`
- `examples/extensions/file-trigger.ts` — minimal asynchronous `sendMessage` wake-up.
- `src/core/tools/bash.ts` — Pi's local shell execution and process-tree cleanup behavior.

Useful external references, for behavior only:

- `gregjohnso/pi-monitor` — stdout batching, rate limiting, and wake-up semantics.
- `@bytetrue/pi-background-terminal` — small session-owned process manager and cleanup.

Do not copy their persistence, duplicated command surfaces, UI, or compatibility machinery.

## Minimum tests

- Split lines across chunks, including CRLF, UTF-8 boundaries, and a final unterminated line.
- Coalesce nearby lines and flush after 200 ms.
- Rate limit stops a noisy process once.
- Start returns before process completion.
- Stop and session shutdown terminate owned processes.
- A stdout batch calls `sendMessage` with `deliverAs: "steer"` and `triggerTurn: true`.
