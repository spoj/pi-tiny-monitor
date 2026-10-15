import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const KILL_GRACE_MS = 1_000;

function processGone(target: number): boolean {
	try {
		process.kill(target, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

async function collectTargets(pids: Set<number>, groups: Set<number>): Promise<number[]> {
	const stdout = await new Promise<string>((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }, (_error, out) => resolve(out));
	});
	const rows = stdout.trim().split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/).map(Number));
	let size = 0;
	while (pids.size + groups.size !== size) {
		size = pids.size + groups.size;
		for (const [pid, ppid, pgid] of rows) {
			if (pids.has(pid) || pids.has(ppid) || groups.has(pgid)) {
				pids.add(pid);
				groups.add(pgid);
			}
		}
	}
	return [...Array.from(groups, (group) => -group), ...pids];
}

function terminate(targets: number[], signal: NodeJS.Signals): void {
	for (const target of targets) {
		try {
			process.kill(target, signal);
		} catch {}
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

	const pids = new Set([pid]);
	const groups = new Set([pid]);
	let targets = [-pid, pid];
	if (targets.every(processGone)) return;
	targets = await collectTargets(pids, groups);
	terminate(targets, "SIGTERM");
	const startedAt = Date.now();
	while (true) {
		if (targets.every(processGone)) return;
		if (Date.now() - startedAt >= KILL_GRACE_MS) {
			targets = await collectTargets(pids, groups);
			terminate(targets, "SIGKILL");
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}
