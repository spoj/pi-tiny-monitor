import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const KILL_GRACE_MS = 1_000;
export const RUN_VARIABLE = "PI_TINY_MONITOR_RUN";

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

export async function stopProcessTree(child: ChildProcess, id: string): Promise<void> {
	child.stdin?.destroy();
	const pid = child.pid!;

	if (process.platform === "win32") {
		// When Git Bash's forked child execs another MSYS program, as for npx's script, the new process's Windows parent exits at once,
		// so taskkill /t cannot reach it. MSYS's /proc still lists it, with the run's environment and its Windows pid.
		const scan = `for d in /proc/[0-9]*; do while IFS= read -r -d '' v; do [[ $v == ${RUN_VARIABLE}=${id} ]] && { read -r w < "$d/winpid"; echo "$w"; break; }; done < "$d/environ"; done 2>/dev/null`;
		const found = await new Promise<string[]>((resolve) => {
			execFile(child.spawnfile, ["-c", scan], { windowsHide: true }, (_error, stdout) => resolve(stdout.split(/\s+/).filter(Boolean)));
		});
		await new Promise<void>((resolve) => {
			execFile(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/f", "/t", ...[String(pid), ...found].flatMap((each) => ["/pid", each])],
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
