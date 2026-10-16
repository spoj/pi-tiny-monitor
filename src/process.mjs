import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KILL_GRACE_MS = 1_000;
export const RUN_VARIABLE = "PI_TINY_MONITOR_RUN";
let watchdog;
let watching = 0;

function processGone(target) {
	try {
		process.kill(target, 0);
		return false;
	} catch (error) {
		return error.code !== "EPERM";
	}
}

async function collectTargets(pids, groups, sessions) {
	const stdout = await new Promise((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,sess="], (_error, out) => resolve(out));
	});
	const rows = stdout.trim().split("\n").filter(Boolean).map((line) => line.trim().split(/\s+/));
	let size = 0;
	while (pids.size + groups.size + sessions.size !== size) {
		size = pids.size + groups.size + sessions.size;
		for (const [pidText, ppidText, pgidText, sess] of rows) {
			const pid = Number(pidText), ppid = Number(ppidText), pgid = Number(pgidText);
			if (pids.has(pid) || pids.has(ppid) || groups.has(pgid) || sessions.has(sess)) {
				pids.add(pid);
				groups.add(pgid);
				if (sess && sess !== "0" && sess !== "-") sessions.add(sess);
			}
		}
	}
	return [...Array.from(groups, (group) => -group), ...pids];
}

function terminate(targets, signal) {
	for (const target of targets) {
		try {
			process.kill(target, signal);
		} catch {}
	}
}

export async function stopTree({ pid, id, shell }) {
	if (process.platform === "win32") {
		// When Git Bash's forked child execs another MSYS program, as for npx's script, the new process's Windows parent exits at once,
		// so taskkill /t cannot reach it. MSYS's /proc still lists it, with the run's environment and its Windows pid.
		const scan = `for d in /proc/[0-9]*; do while IFS= read -r -d '' v; do [[ $v == ${RUN_VARIABLE}=${id} ]] && { read -r w < "$d/winpid"; echo "$w"; break; }; done < "$d/environ"; done 2>/dev/null`;
		const found = await new Promise((resolve) => {
			execFile(shell, ["-c", scan], { windowsHide: true }, (_error, stdout) => resolve(stdout.split(/\s+/).filter(Boolean)));
		});
		await new Promise((resolve) => {
			execFile(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/f", "/t", ...[String(pid), ...found].flatMap((each) => ["/pid", each])],
				{ windowsHide: true },
				() => resolve(),
			);
		});
		return;
	}

	const pids = new Set([pid]);
	const groups = new Set([pid]);
	const sessions = new Set([String(pid)]);
	let targets = await collectTargets(pids, groups, sessions);
	if (targets.every(processGone)) return;
	terminate(targets, "SIGTERM");
	const startedAt = Date.now();
	while (true) {
		if (targets.every(processGone)) {
			targets = await collectTargets(pids, groups, sessions);
			if (targets.every(processGone)) return;
			terminate(targets, "SIGTERM");
		}
		if (Date.now() - startedAt >= KILL_GRACE_MS) {
			terminate(await collectTargets(pids, groups, sessions), "SIGKILL");
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

export function watchProcess(child, id) {
	if (!watchdog) {
		watchdog = spawn(process.execPath, [fileURLToPath(new URL("./watchdog.mjs", import.meta.url))], {
			stdio: ["pipe", "ignore", "ignore"],
			detached: process.platform !== "win32",
			windowsHide: true,
			// Pi's standalone Bun build runs Pi itself unless told to act as Bun; Node ignores this.
			env: { ...process.env, BUN_BE_BUN: "1" },
		});
		watchdog.on("error", () => {});
		watchdog.stdin.on("error", () => {});
		watchdog.unref();
	}
	watching++;
	watchdog.stdin.write(`${JSON.stringify({ pid: child.pid, id, shell: child.spawnfile })}\n`);
}

export async function stopProcessTree(child, id) {
	child.stdin?.destroy();
	await stopTree({ pid: child.pid, id, shell: child.spawnfile });
	const line = `${JSON.stringify({ pid: child.pid })}\n`;
	watching--;
	if (watching) watchdog.stdin.write(line);
	else {
		watchdog.stdin.end(line);
		watchdog = undefined;
	}
}
