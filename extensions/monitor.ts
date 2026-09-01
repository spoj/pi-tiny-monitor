import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_MONITORS = 8;
const COALESCE_MS = 200;
const RATE_LIMIT = 50;
const RATE_WINDOW_MS = 10_000;
const KILL_GRACE_MS = 1_000;

type Monitor = {
	id: string;
	description: string;
	command: string;
	child: ChildProcess;
	lines: number;
	timestamps: number[];
	pending: string[];
	timer?: NodeJS.Timeout;
};

const monitors = new Map<string, Monitor>();
let shuttingDown = false;

function emit(pi: ExtensionAPI, monitor: Monitor, lines: string[]): void {
	if (shuttingDown) return;
	pi.sendMessage(
		{
			customType: "pi-tiny-monitor",
			content: `[monitor ${monitor.id} · ${monitor.description}]\n${lines.map((line) => `  ${line}`).join("\n")}`,
			display: true,
			details: { id: monitor.id, lines },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function flush(pi: ExtensionAPI, monitor: Monitor): void {
	if (monitor.timer) clearTimeout(monitor.timer);
	monitor.timer = undefined;
	if (monitor.pending.length === 0) return;
	const lines = monitor.pending;
	monitor.pending = [];
	emit(pi, monitor, lines);
}

function stop(monitor: Monitor): void {
	if (monitor.timer) clearTimeout(monitor.timer);
	monitor.timer = undefined;
	if (monitor.child.exitCode !== null) return;
	const signal = (name: NodeJS.Signals) => {
		if (process.platform !== "win32" && monitor.child.pid) process.kill(-monitor.child.pid, name);
		else monitor.child.kill(name);
	};
	signal("SIGTERM");
	setTimeout(() => {
		if (monitor.child.exitCode === null) signal("SIGKILL");
	}, KILL_GRACE_MS);
}

function stopAll(): void {
	for (const monitor of monitors.values()) stop(monitor);
	monitors.clear();
}

function start(pi: ExtensionAPI, ctx: ExtensionContext, description: string, command: string): string {
	if (shuttingDown) throw new Error("Monitor is shutting down");
	if (monitors.size >= MAX_MONITORS) throw new Error(`Too many monitors running (maximum ${MAX_MONITORS})`);

	const id = `mon-${randomUUID().slice(0, 8)}`;
	const child = spawn(process.env.SHELL ?? "/bin/sh", ["-c", command], {
		cwd: ctx.cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const monitor: Monitor = { id, description, command, child, lines: 0, timestamps: [], pending: [] };
	monitors.set(id, monitor);

	let carry = "";
	child.stdout?.on("data", (chunk: Buffer | string) => {
		const parts = (carry + chunk.toString()).split("\n");
		carry = parts.pop() ?? "";
		for (const line of parts) {
			const now = Date.now();
			monitor.timestamps.push(now);
			monitor.timestamps = monitor.timestamps.filter((time) => time >= now - RATE_WINDOW_MS);
			if (monitor.timestamps.length > RATE_LIMIT * (RATE_WINDOW_MS / 1000)) {
				stop(monitor);
				emit(pi, monitor, [`auto-stopped: output exceeded ${RATE_LIMIT} lines/sec`]);
				return;
			}
			monitor.lines++;
			monitor.pending.push(line.replace(/\r$/, ""));
			if (monitor.timer) clearTimeout(monitor.timer);
			monitor.timer = setTimeout(() => flush(pi, monitor), COALESCE_MS);
		}
	});
	child.once("exit", () => {
		if (carry) monitor.pending.push(carry);
		flush(pi, monitor);
		monitors.delete(id);
	});
	return id;
}

export default function piTinyMonitor(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "monitor_start",
		label: "Monitor Start",
		description: "Run a shell command in the background and wake the agent with coalesced stdout lines.",
		parameters: Type.Object({
			description: Type.String({ description: "Short label for the output" }),
			command: Type.String({ description: "Shell command to run" }),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const id = start(pi, ctx, params.description, params.command);
			return { content: [{ type: "text", text: `Started monitor ${id}` }], details: { id } };
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Monitor Stop",
		description: "Stop a background monitor.",
		parameters: Type.Object({ id: Type.String({ description: "Monitor ID" }) }),
		async execute(_toolId, params) {
			const monitor = monitors.get(params.id);
			if (!monitor) throw new Error(`Unknown monitor: ${params.id}`);
			stop(monitor);
			return { content: [{ type: "text", text: `Stopped monitor ${params.id}` }] };
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "Monitor List",
		description: "List running background monitors.",
		parameters: Type.Object({}),
		async execute() {
			const list = [...monitors.values()].map(({ id, description, command, lines }) => ({ id, description, command, lines }));
			return { content: [{ type: "text", text: list.length ? JSON.stringify(list) : "No monitors running" }], details: { monitors: list } };
		},
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		stopAll();
	});
}
