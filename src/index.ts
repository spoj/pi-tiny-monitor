import { execFileSync, type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { getShellConfig, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BATCH_WINDOW_MS = 2_000;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 50 * (RATE_WINDOW_MS / 1000);
const MAX_PROCESSES = 8;
const KILL_GRACE_MS = 1_000;
const MAX_LINE_BYTES = 64 * 1024;

type ProcessRecord = {
	id: string;
	command: string;
	child: ChildProcess;
	decoder: StringDecoder;
	carry: string;
	pending: string[];
	flushTimer?: NodeJS.Timeout;
	timestamps: number[];
	stopping: boolean;
	stopPromise?: Promise<void>;
};

export default function tinyMonitor(pi: ExtensionAPI): void {
	const processes = new Map<string, ProcessRecord>();
	let nextId = 1;
	let active = true;
	let uiContext: ExtensionContext | undefined;

	const updateWidget = () => {
		if (!uiContext?.hasUI) return;
		uiContext.ui.setWidget(
			"pi-tiny-monitor",
			active && processes.size > 0 ? [`${processes.size} monitors running`] : undefined,
		);
	};

	const flush = (record: ProcessRecord, exit?: { exitCode: number | null; signal: NodeJS.Signals | null }) => {
		if (record.flushTimer) clearTimeout(record.flushTimer);
		record.flushTimer = undefined;
		if (!active || (record.pending.length === 0 && !exit)) return;
		const lines = record.pending;
		record.pending = [];
		const output = lines.length > 0 ? `\n${lines.join("\n")}` : "";
		const status = exit
			? `${lines.length > 0 ? "\n" : " "}process exited ${exit.signal ? `with signal ${exit.signal}` : `with code ${exit.exitCode}`}.`
			: "";
		pi.sendMessage(
			{
				customType: "tiny-monitor",
				content: `[${record.id}]${output}${status}`,
				display: true,
				details: { id: record.id, command: record.command, lines, ...exit },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const stopForOutputLimit = (record: ProcessRecord) => {
		if (record.stopping) return;
		record.pending = [];
		if (record.flushTimer) clearTimeout(record.flushTimer);
		record.flushTimer = undefined;
		pi.sendMessage(
			{
				customType: "tiny-monitor",
				content: `[${record.id}] output line exceeded ${MAX_LINE_BYTES} bytes; stopped monitor.`,
				display: true,
				details: { id: record.id, command: record.command, lineLimitExceeded: true },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		void stop(record);
	};

	const queueLine = (record: ProcessRecord, line: string) => {
		if (record.stopping) return;
		if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
			stopForOutputLimit(record);
			return;
		}
		const now = Date.now();
		record.timestamps.push(now);
		while (record.timestamps[0] < now - RATE_WINDOW_MS) record.timestamps.shift();
		if (record.timestamps.length > RATE_LIMIT) {
			record.pending = [];
			if (record.flushTimer) clearTimeout(record.flushTimer);
			record.flushTimer = undefined;
			pi.sendMessage(
				{
					customType: "tiny-monitor",
					content: `[${record.id}] rate limit exceeded; stopped noisy monitor.`,
					display: true,
					details: { id: record.id, command: record.command, rateLimited: true },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			void stop(record);
			return;
		}

		record.pending.push(line);
		if (!record.flushTimer) record.flushTimer = setTimeout(() => flush(record), BATCH_WINDOW_MS);
	};

	const consume = (record: ProcessRecord, text: string, final = false) => {
		const parts = (record.carry + text).split("\n");
		record.carry = parts.pop() ?? "";
		for (const part of parts) queueLine(record, part.endsWith("\r") ? part.slice(0, -1) : part);
		if (record.carry && Buffer.byteLength(record.carry, "utf8") > MAX_LINE_BYTES) {
			record.carry = "";
			stopForOutputLimit(record);
			return;
		}
		if (final && record.carry) {
			queueLine(record, record.carry.endsWith("\r") ? record.carry.slice(0, -1) : record.carry);
			record.carry = "";
		}
	};

	function stop(record: ProcessRecord): Promise<void> {
		if (record.stopPromise) return record.stopPromise;
		record.stopping = true;
		record.stopPromise = new Promise<void>((resolve) => {
			const forceTerminated = terminateProcessTree(record.child, "SIGTERM");
			record.child.stdout?.destroy();
			if (process.platform === "win32" && forceTerminated) {
				resolve();
				return;
			}
			const startedAt = Date.now();
			const waitForExit = () => {
				if (processGone(record.child)) {
					resolve();
					return;
				}
				if (Date.now() - startedAt >= KILL_GRACE_MS) {
					terminateProcessTree(record.child, "SIGKILL");
					resolve();
					return;
				}
				setTimeout(waitForExit, 25);
			};
			waitForExit();
		}).finally(() => {
			processes.delete(record.id);
			updateWidget();
		});
		return record.stopPromise;
	}

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Start a background shell command whose stdout and exit wake the session.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command whose stdout and exit should be monitored." }),
		}),
		async execute(_toolCallId, { command }, _signal, _onUpdate, ctx) {
			if (!active) throw new Error("Cannot start a monitor after session shutdown has begun.");
			if (processes.size >= MAX_PROCESSES) {
				throw new Error(`Maximum of ${MAX_PROCESSES} monitors already running.`);
			}
			const id = `monitor_${nextId++}`;
			const startedAt = new Date().toISOString();
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const { shell, args, commandTransport } = getShellConfig(settings.getShellPath());
			const prefix = settings.getShellCommandPrefix();
			const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
			const commandFromStdin = commandTransport === "stdin";
			const child = spawn(shell, commandFromStdin ? args : [...args, resolvedCommand], {
				cwd: ctx.cwd,
				detached: process.platform !== "win32",
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(resolvedCommand);
			}
			const record: ProcessRecord = {
				id,
				command,
				child,
				decoder: new StringDecoder("utf8"),
				carry: "",
				pending: [],
				timestamps: [],
				stopping: false,
			};
			processes.set(id, record);
			updateWidget();

			const spawned = new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", (error) => {
					processes.delete(id);
					updateWidget();
					reject(error);
				});
			});
			child.stdout?.on("data", (chunk: Buffer) => consume(record, record.decoder.write(chunk)));
			child.stdout?.once("end", () => {
				consume(record, record.decoder.end(), true);
			});
			child.once("close", (exitCode, signal) => {
				flush(record, !record.stopping && processes.has(id) ? { exitCode, signal } : undefined);
				void stop(record);
			});

			await spawned;
			const details = {
				id,
				command,
				pid: child.pid ?? null,
				platform: process.platform,
				shell,
				cwd: ctx.cwd,
				startedAt,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Monitor Stop",
		description: "Stop one running background monitor.",
		parameters: Type.Object({ id: Type.String({ description: "Monitor ID." }) }),
		async execute(_toolCallId, { id }) {
			const record = processes.get(id);
			if (!record) throw new Error(`Unknown monitor: ${id}`);
			flush(record);
			await stop(record);
			return { content: [{ type: "text", text: `Stopped ${id}.` }], details: { id } };
		},
	});

	pi.on("session_start", (_event, ctx) => {
		uiContext = ctx;
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		active = false;
		updateWidget();
		uiContext = undefined;
		for (const record of processes.values()) {
			if (record.flushTimer) clearTimeout(record.flushTimer);
			record.pending = [];
		}
		await Promise.all([...processes.values()].map(stop));
		processes.clear();
	});
}

function processGone(child: ChildProcess): boolean {
	if (process.platform === "win32") return child.exitCode !== null || child.signalCode !== null;
	if (!child.pid) return true;
	try {
		process.kill(-child.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "EPERM";
	}
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
	if (!child.pid) {
		child.kill(signal);
		return false;
	}

	if (process.platform === "win32") {
		try {
			execFileSync(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/pid", String(child.pid), "/t", "/f"],
				{ stdio: "ignore" },
			);
			return true;
		} catch {
			child.kill(signal);
			return false;
		}
	}

	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
	return false;
}
