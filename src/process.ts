import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const KILL_GRACE_MS = 1_000;

function processGone(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

function terminate(pid: number, child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		child.kill(signal);
	}
}

export async function stopProcessTree(child: ChildProcess): Promise<void> {
	child.stdin?.destroy();
	const pid = child.pid!;

	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			execFile(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/pid", String(pid), "/t", "/f"],
				{ windowsHide: true },
				(error: Error | null) => {
					if (error) child.kill("SIGTERM");
					resolve();
				},
			);
		});
		return;
	}

	if (processGone(pid)) return;
	terminate(pid, child, "SIGTERM");
	const startedAt = Date.now();
	while (true) {
		if (processGone(pid)) return;
		if (Date.now() - startedAt >= KILL_GRACE_MS) {
			terminate(pid, child, "SIGKILL");
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}
