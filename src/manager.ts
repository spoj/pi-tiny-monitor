import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopProcessTree } from "./process.ts";
import { LiveOutput, type LiveChunk } from "./live-output.ts";

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type RunSnapshot = {
	id: string;
	command: string;
	logPath: string;
	status: RunStatus;
	exitCode?: number;
	signal?: NodeJS.Signals;
};

type RunRecord = RunSnapshot & {
	process: ChildProcess;
	output: LiveOutput;
	outputFile: number;
	outputTimer: NodeJS.Timeout;
	readOutput?: () => void;
	finishing?: Promise<void>;
};

type ManagerOptions = {
	onUpdate: () => void;
	onOutput: (run: RunSnapshot, chunk: LiveChunk & { streamEnded?: boolean }) => void;
};

export class MonitorManager {
	private readonly runs = new Map<string, RunRecord>();
	private shuttingDown = false;

	constructor(private readonly options: ManagerOptions) {}

	list(): RunSnapshot[] {
		return Array.from(this.runs.values(), (run) => this.snapshot(run));
	}

	run(argv: string[], options: { command: string; cwd: string; env: NodeJS.ProcessEnv; stdin?: string }): RunSnapshot {
		if (this.shuttingDown) throw new Error("Monitor manager is shutting down");
		if (this.list().filter((run) => run.status === "running").length >= 8) {
			throw new Error("Maximum of 8 monitors already running");
		}
		const id = `run-${randomBytes(3).toString("hex")}`;
		const logPath = join(tmpdir(), `pi-${id}.log`);
		const log = openSync(logPath, "wx", 0o600);
		let child: ChildProcess;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd: options.cwd,
				env: options.env,
				stdio: [options.stdin === undefined ? "ignore" : "pipe", log, log],
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} finally {
			closeSync(log);
		}
		// A failed start leaves pid unset and still emits "error", which would crash Pi if unhandled.
		child.on("error", () => {});
		if (child.pid === undefined) {
			rmSync(logPath);
			throw new Error(`Could not start ${argv[0]}`);
		}
		if (options.stdin !== undefined) {
			child.stdin!.on("error", () => {});
			child.stdin!.end(options.stdin);
		}

		const file = openSync(logPath, "r");
		let offset = 0;
		const readOutput = () => {
			const size = fstatSync(file).size - offset;
			if (size === 0) return;
			const buffer = Buffer.alloc(Math.min(size, 50 * 1024 + 1));
			const length = readSync(file, buffer, 0, buffer.length, offset);
			offset += length;
			run.output.append(buffer.subarray(0, length));
		};
		const run: RunRecord = {
			id, command: options.command, logPath, status: "running", process: child,
			outputFile: file, readOutput, outputTimer: setInterval(readOutput, 100),
			output: new LiveOutput((chunk) => {
				if (chunk.suppressed) {
					clearInterval(run.outputTimer);
					run.readOutput = undefined;
				}
				if (!this.shuttingDown) this.options.onOutput(this.snapshot(run), chunk);
			}),
		};
		child.once("exit", (code, signal) => {
			if (run.finishing) return;
			run.exitCode = code ?? undefined;
			run.signal = signal ?? undefined;
			void this.finish(run, code === 0 ? "completed" : "failed");
		});
		this.runs.set(id, run);
		this.options.onUpdate();
		return this.snapshot(run);
	}

	async stop(id: string): Promise<void> {
		const run = this.runs.get(id);
		if (!run) throw new Error(`Unknown monitor: ${id}`);
		if (run.finishing) throw new Error(`${id} is not running`);
		await this.finish(run, "stopped");
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await Promise.all(Array.from(this.runs.values(), (run) => this.finish(run, "stopped")));
	}

	private finish(run: RunRecord, status: RunStatus): Promise<void> {
		if (run.finishing) return run.finishing;
		clearInterval(run.outputTimer);
		run.finishing = Promise.resolve().then(async () => {
			let chunk: LiveChunk | undefined;
			try {
				await stopProcessTree(run.process);
				run.readOutput?.();
				chunk = run.output.finish();
				run.status = status;
			} catch {
				run.status = "failed";
			} finally {
				run.output.dispose();
				closeSync(run.outputFile);
			}
			if (!this.shuttingDown && (run.status !== "stopped" || chunk?.text)) {
				this.options.onOutput(this.snapshot(run), {
					text: "", startsWithContinuation: false, endsWithPartialLine: false, ...chunk, streamEnded: run.status !== "stopped",
				});
			}
			this.options.onUpdate();
		});
		return run.finishing;
	}

	private snapshot(run: RunRecord): RunSnapshot {
		const { id, command, logPath, status, exitCode, signal } = run;
		return { id, command, logPath, status, exitCode, signal };
	}
}
