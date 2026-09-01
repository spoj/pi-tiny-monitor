import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Static, Type } from "typebox";

const BATCH_WINDOW_MS = 200;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 50 * (RATE_WINDOW_MS / 1000);
const MAX_PROCESSES = 8;
const KILL_GRACE_MS = 1_000;

const monitorSchema = Type.Object({
	command: Type.String({ description: "Shell command whose stdout should be monitored." }),
});
type MonitorInput = Static<typeof monitorSchema>;

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

	const flush = (record: ProcessRecord) => {
		if (record.flushTimer) clearTimeout(record.flushTimer);
		record.flushTimer = undefined;
		if (!active || record.pending.length === 0) return;
		const lines = record.pending;
		record.pending = [];
		pi.sendMessage(
			{
				customType: "tiny-monitor",
				content: `[${record.id}]\n${lines.join("\n")}`,
				display: true,
				details: { id: record.id, command: record.command, lines },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const queueLine = (record: ProcessRecord, line: string) => {
		if (record.stopping) return;
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
		if (record.flushTimer) clearTimeout(record.flushTimer);
		record.flushTimer = setTimeout(() => flush(record), BATCH_WINDOW_MS);
	};

	const consume = (record: ProcessRecord, text: string, final = false) => {
		const parts = (record.carry + text).split("\n");
		record.carry = parts.pop() ?? "";
		for (const part of parts) queueLine(record, part.endsWith("\r") ? part.slice(0, -1) : part);
		if (final && record.carry) {
			queueLine(record, record.carry.endsWith("\r") ? record.carry.slice(0, -1) : record.carry);
			record.carry = "";
		}
	};

	function stop(record: ProcessRecord): Promise<void> {
		if (record.stopPromise) return record.stopPromise;
		record.stopping = true;
		record.stopPromise = new Promise((resolve) => {
			if (record.child.exitCode !== null || record.child.signalCode !== null) {
				resolve();
				return;
			}

			let killTimer: NodeJS.Timeout | undefined;
			const done = () => {
				if (killTimer) clearTimeout(killTimer);
				resolve();
			};
			record.child.once("close", done);
			kill(record.child, "SIGTERM");
			killTimer = setTimeout(() => kill(record.child, "SIGKILL"), KILL_GRACE_MS);
			killTimer.unref();
		});
		return record.stopPromise;
	}

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Start a background shell command whose stdout wakes the session.",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command whose stdout should be monitored." }),
		}),
		async execute(_toolCallId, { command }, _signal, _onUpdate, ctx) {
			const id = `monitor_${nextId++}`;
			const [shell, args] = shellCommand(command);
			const child = spawn(shell, args, {
				cwd: ctx.cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
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

			child.stdout?.on("data", (chunk: Buffer) => consume(record, record.decoder.write(chunk)));
			child.stdout?.once("end", () => {
				consume(record, record.decoder.end(), true);
				flush(record);
			});
			child.once("error", () => processes.delete(id));
			child.once("close", () => {
				flush(record);
				processes.delete(id);
			});

			return {
				content: [{ type: "text", text: `Started ${id}.` }],
				details: { id, command, pid: child.pid },
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

	pi.registerTool({
		name: "monitor_list",
		label: "Monitor List",
		description: "List running background monitors.",
		parameters: Type.Object({}),
		async execute() {
			const monitors = [...processes.values()].map(({ id, command, child, stopping }) => ({
				id,
				command,
				pid: child.pid,
				stopping,
			}));
			return {
				content: [{
					type: "text",
					text: monitors.length ? monitors.map(({ id, command }) => `${id}: ${command}`).join("\n") : "No monitors running.",
				}],
				details: { monitors },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		active = false;
		for (const record of processes.values()) {
			if (record.flushTimer) clearTimeout(record.flushTimer);
			record.pending = [];
		}
		await Promise.all([...processes.values()].map(stop));
		processes.clear();
	});
}

function shellCommand(command: string): [string, string[]] {
	return process.platform === "win32"
		? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]]
		: [process.env.SHELL ?? "/bin/sh", ["-c", command]];
}

function kill(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}
