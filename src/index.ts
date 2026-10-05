import type { TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	getShellConfig,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MonitorManager, type RunSnapshot } from "./manager.ts";
import type { LiveChunk } from "./live-output.ts";

const STATUS_KEY = "pi-tiny-monitor";

const monitorTool = Type.Object({
	command: Type.String({ minLength: 1, description: "Shell command to run in the background" }),
});

const monitorStopTool = Type.Object({
	id: Type.String({ minLength: 1, description: "Running monitor ID" }),
});

function renderStatus(ctx: ExtensionContext, manager: MonitorManager): void {
	const active = manager.list().filter((run) => run.status === "running").length;
	ctx.ui.setStatus(STATUS_KEY, active ? `monitors: ${active}` : undefined);
}

function liveText(run: RunSnapshot, chunk: LiveChunk & { streamEnded?: boolean }): string {
	const flags = [
		chunk.startsWithContinuation ? "continues previous line" : undefined,
		chunk.endsWithPartialLine ? "last line incomplete" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (chunk.suppressed) {
		flags.push(`suppressed: ${chunk.text}`, `log: ${run.logPath}`);
	}
	if (chunk.streamEnded) {
		flags.push(`status: ${run.status}`);
		if (run.exitCode !== undefined) flags.push(`exit code: ${run.exitCode}`);
		if (run.signal !== undefined) flags.push(`signal: ${run.signal}`);
		flags.push(`log: ${run.logPath}`);
	}
	return `[${[run.id, ...flags].join(" · ")}]${chunk.suppressed ? "" : `\n${chunk.text}`}`;
}

function registerTools(pi: ExtensionAPI, manager: MonitorManager): void {
	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description: "Runs a background shell command and delivers bounded output updates while it runs, then a final status.",
		promptSnippet: "Run a background shell command with live output updates",
		promptGuidelines: [
			"Use monitor for long-running or noisy shell commands when the current turn should remain available.",
			"Monitor output arrives in timed chunks; chunk boundaries are not newline boundaries. Use the continuation and incomplete-line headers, and read the saved log for complete output.",
		],
		parameters: monitorTool,
		// Updates arrive as later messages, not in the result, so codemode scripts cannot use monitors.
		exposure: "model-only",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			const shell = getShellConfig(settings.getShellPath());
			const prefix = settings.getShellCommandPrefix();
			const command = prefix ? `${prefix}\n${params.command}` : params.command;
			const run = manager.run(
				shell.commandTransport === "stdin" ? [shell.shell, ...shell.args] : [shell.shell, ...shell.args, command],
				{
					command: params.command,
					cwd: ctx.cwd,
					...(shell.commandTransport === "stdin" ? { stdin: command } : {}),
				},
			);
			return {
				content: [{ type: "text", text: `Monitor started.\n\nID: ${run.id}\nLog: ${run.logPath}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Monitor Stop",
		description: "Stops a running monitor by ID.",
		parameters: monitorStopTool,
		exposure: "model-only",
		async execute(_toolCallId, params) {
			await manager.stop(params.id);
			return { content: [{ type: "text", text: `Monitor stopped.\n\nID: ${params.id}` }], details: undefined };
		},
	});
}

export default function piTinyMonitor(pi: ExtensionAPI): void {
	let manager: MonitorManager | undefined;
	let shutdown: (() => Promise<void>) | undefined;
	let pending: TextContent[] | undefined;

	function notify(text: string): void {
		const queued = pending !== undefined;
		pending ??= [];
		// Pi retains this array until message_start; later arrivals join the same queued message.
		pending.push({ type: "text", text });
		if (!queued) {
			pi.sendMessage(
				{ customType: "pi-tiny-monitor", content: pending, display: true },
				{ deliverAs: "steer", triggerTurn: true },
			);
		}
	}

	pi.on("message_start", ({ message }) => {
		if (message.role === "custom" && message.customType === "pi-tiny-monitor" && message.content === pending) {
			pending = undefined;
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) pending = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		const current = new MonitorManager({
			onUpdate: () => renderStatus(ctx, current),
			onOutput: (run, chunk) => notify(liveText(run, chunk)),
		});
		manager = current;
		shutdown = () => current.shutdown();
		registerTools(pi, current);
		renderStatus(ctx, current);
	});

	// Compaction can summarize away the calls that started monitors, so restate the ones still running.
	// Without triggerTurn, a steer joins the current run or is appended to an idle session without waking it.
	pi.on("session_compact", () => {
		const running = manager?.list().filter((run) => run.status === "running") ?? [];
		if (!running.length) return;
		const text = [
			"Monitors still running after compaction:",
			...running.map((run) => `[${run.id} · log: ${run.logPath}]\n${run.command}`),
		].join("\n");
		pi.sendMessage({ customType: "pi-tiny-monitor", content: [{ type: "text", text }], display: true }, { deliverAs: "steer" });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const close = shutdown;
		shutdown = undefined;
		manager = undefined;
		pending = undefined;
		await close?.();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
