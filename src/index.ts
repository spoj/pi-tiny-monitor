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
	ctx.ui.setStatus(STATUS_KEY, active ? `monitors:${active}` : undefined);
}

function liveText(run: RunSnapshot, chunk: LiveChunk & { streamEnded?: boolean }): string {
	const flags = [
		chunk.startsWithContinuation ? "continues previous line" : undefined,
		chunk.endsWithPartialLine ? "last line incomplete" : undefined,
	].filter((flag): flag is string => flag !== undefined);
	if (chunk.suppressed) flags.push(`suppressed: ${chunk.text}`, `log: ${run.logPath}`);
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
		description: "Runs a shell command and wakes you up when it outputs to stdout.",
		promptSnippet: "Run a background shell command with live output updates",
		promptGuidelines: [
			"Use monitor instead of busy-polls and wait-and-check patterns in bash. Monitor is strictly better because it wakes you up faster and stays quiet otherwise.",
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
			return { content: [{ type: "text", text: "Monitor stopped." }], details: undefined };
		},
	});
}

export default function piTinyMonitor(pi: ExtensionAPI): void {
	let manager: MonitorManager | undefined;
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
		// Print and JSON modes exit once the agent finishes, which would stop monitors before they report.
		if (ctx.mode !== "print" && ctx.mode !== "json") registerTools(pi, current);
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

	pi.on("session_shutdown", () => manager?.shutdown());

	pi.registerCommand("monitors", {
		description: "List running monitors; /monitors stop picks one to stop",
		handler: async (args, ctx) => {
			const now = Date.now();
			const runs = manager!.list().filter((run) => run.status === "running").map((run) => {
				const age = now - run.startedAt;
				return `${run.id} · ${age < 60_000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60_000)}m`} · ${run.command.split("\n")[0].slice(0, 80)}`;
			});
			if (!runs.length) return ctx.ui.notify("No monitors running", "info");
			if (args.trim() !== "stop") return ctx.ui.notify(runs.join("\n"), "info");
			const choice = await ctx.ui.select("Stop monitor", runs);
			if (choice) await manager!.stop(choice.slice(0, choice.indexOf(" ")));
		},
	});
}
