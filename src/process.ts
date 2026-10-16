import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const KILL_GRACE_MS = 1_000;
export const RUN_VARIABLE = "PI_TINY_MONITOR_RUN";
const activePids = new Set<number>();
let watchdog: ChildProcess | undefined;
let exitHookInstalled = false;

function processGone(target: number): boolean {
	try {
		process.kill(target, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

function parseTargets(stdout: string, pids: Set<number>, groups: Set<number>, sessions: Set<string>): number[] {
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

async function collectTargets(pids: Set<number>, groups: Set<number>, sessions: Set<string>): Promise<number[]> {
	const stdout = await new Promise<string>((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,sess="], { encoding: "utf8" }, (_error, out) => resolve(out));
	});
	return parseTargets(stdout, pids, groups, sessions);
}

function terminate(targets: number[], signal: NodeJS.Signals): void {
	for (const target of targets) {
		try {
			process.kill(target, signal);
		} catch {}
	}
}

function killTreesSync(roots: Set<number>, runSync: typeof execFileSync, joinPath: typeof join): void {
	if (!roots.size) return;
	if (process.platform === "win32") {
		const taskkill = joinPath(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
		for (const pid of roots) {
			try {
				runSync(taskkill, ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
			} catch {}
		}
		return;
	}
	const pids = new Set(roots);
	const groups = new Set(roots);
	const sessions = new Set(Array.from(roots, String));
	const stdout = runSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,sess="], { encoding: "utf8" });
	terminate(parseTargets(stdout, pids, groups, sessions), "SIGKILL");
}

function stopWatchdog(): void {
	if (!watchdog) return;
	watchdog.stdin?.destroy();
	watchdog.kill("SIGKILL");
	watchdog = undefined;
}

const watchdogScript = [
	`const { execFileSync } = require("node:child_process");`,
	`const { join } = require("node:path");`,
	parseTargets.toString(),
	terminate.toString(),
	killTreesSync.toString(),
	`const roots = new Set();`,
	`let rest = "";`,
	`process.stdin.setEncoding("utf8").on("data", (chunk) => {`,
	`\tconst lines = (rest + chunk).split("\\n");`,
	`\trest = lines.pop();`,
	`\tfor (const line of lines) {`,
	`\t\tconst pid = Number(line.slice(1));`,
	`\t\tif (line[0] === "+") roots.add(pid);`,
	`\t\telse roots.delete(pid);`,
	`\t}`,
	`}).on("end", () => {`,
	`\tkillTreesSync(roots, execFileSync, join);`,
	`\tprocess.exit(0);`,
	`});`,
].join("\n");

export function watchProcess(pid: number): void {
	activePids.add(pid);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => {
			stopWatchdog();
			killTreesSync(activePids, execFileSync, join);
		});
	}
	if (!watchdog) {
		watchdog = spawn(process.execPath, ["-e", watchdogScript], {
			stdio: ["pipe", "ignore", "ignore"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		watchdog.on("error", () => {});
		watchdog.stdin!.on("error", () => {});
		watchdog.unref();
	}
	watchdog.stdin!.write(`+${pid}\n`);
}

function unwatchProcess(pid: number): void {
	activePids.delete(pid);
	if (!activePids.size) stopWatchdog();
	else watchdog?.stdin?.write(`-${pid}\n`);
}

export async function stopProcessTree(child: ChildProcess, id: string): Promise<void> {
	child.stdin?.destroy();
	const pid = child.pid!;
	try {
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
				targets = await collectTargets(pids, groups, sessions);
				terminate(targets, "SIGKILL");
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	} finally {
		unwatchProcess(pid);
	}
}
