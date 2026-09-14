# pi-tiny-monitor

`monitor` and `monitor_stop` are now provided by [pi-tiny-fork](https://github.com/spoj/pi-tiny-fork). This repository no longer contains a Pi extension.

Install the updated `pi-tiny-fork` package and remove `pi-tiny-monitor` from Pi's package configuration before reloading. Do not load both packages.

Monitors are ordinary runs with live output: they share process ownership, cancellation, logs, and shutdown with `pi-child run`. Timed updates can split lines and label continuations explicitly. Noisy output suppresses further live updates rather than killing the command; full stdout and stderr remain in the run logs.
