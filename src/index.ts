import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type MonitorRecord = {
  id: string;
  label: string;
  child: ChildProcess;
  buffer: string[];
  flushTimer?: NodeJS.Timeout;
  lineBuffer: string;
  timestamps: number[];
  stopping: boolean;
};

const BATCH_DELAY_MS = 200;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 500;

function stopChild(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function result(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function (pi: ExtensionAPI) {
  const monitors = new Map<string, MonitorRecord>();

  const flush = (record: MonitorRecord) => {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer);
      record.flushTimer = undefined;
    }
    if (record.buffer.length === 0) return;
    const lines = record.buffer.splice(0);
    pi.sendMessage(
      {
        customType: "monitor",
        content: `[${record.label}]\n${lines.join("\n")}`,
        display: true,
        details: { id: record.id, lines },
      },
      { deliverAs: "steer", triggerTurn: true },
    );
  };

  const scheduleFlush = (record: MonitorRecord) => {
    if (!record.flushTimer) {
      record.flushTimer = setTimeout(() => flush(record), BATCH_DELAY_MS);
    }
  };

  const stop = (record: MonitorRecord) => {
    if (record.stopping) return;
    record.stopping = true;
    flush(record);
    stopChild(record.child);
    monitors.delete(record.id);
  };

  const addLine = (record: MonitorRecord, line: string) => {
    const now = Date.now();
    record.timestamps.push(now);
    while (record.timestamps[0] !== undefined && now - record.timestamps[0] >= RATE_WINDOW_MS) {
      record.timestamps.shift();
    }
    if (record.timestamps.length > RATE_LIMIT) {
      stop(record);
      return;
    }
    record.buffer.push(line);
    scheduleFlush(record);
  };

  const consume = (record: MonitorRecord, chunk: string) => {
    record.lineBuffer += chunk;
    const lines = record.lineBuffer.split("\n");
    record.lineBuffer = lines.pop() ?? "";
    for (const line of lines) addLine(record, line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const start = (command: string, cwd: string): string => {
    const id = randomUUID().slice(0, 8);
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const record: MonitorRecord = {
      id,
      label: command,
      child,
      buffer: [],
      lineBuffer: "",
      timestamps: [],
      stopping: false,
    };
    monitors.set(id, record);

    const stdout = child.stdout as Readable | null;
    stdout?.setEncoding("utf8");
    stdout?.on("data", (chunk: string) => consume(record, chunk));
    child.once("error", () => {
      if (record.lineBuffer) addLine(record, record.lineBuffer);
      record.lineBuffer = "";
      flush(record);
      monitors.delete(id);
    });
    child.once("close", () => {
      if (record.lineBuffer) addLine(record, record.lineBuffer);
      record.lineBuffer = "";
      flush(record);
      monitors.delete(id);
    });
    return id;
  };

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description: "Start a background shell process and deliver its stdout lines to the session.",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = start(params.command, ctx.cwd);
      return result(`Started monitor ${id}: ${params.command}`, { id, command: params.command });
    },
  });

  pi.registerTool({
    name: "monitor_stop",
    label: "Stop Monitor",
    description: "Stop one running background monitor by ID.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params) {
      const record = monitors.get(params.id);
      if (!record) return result(`Monitor not found: ${params.id}`, { id: params.id, stopped: false });
      stop(record);
      return result(`Stopped monitor ${params.id}`, { id: params.id, stopped: true });
    },
  });

  pi.registerTool({
    name: "monitor_list",
    label: "List Monitors",
    description: "List running background monitors.",
    parameters: Type.Object({}),
    async execute() {
      const items = [...monitors.values()].map(({ id, label }) => ({ id, command: label }));
      return result(
        items.length === 0 ? "No running monitors." : items.map((item) => `${item.id}: ${item.command}`).join("\n"),
        { monitors: items },
      );
    },
  });

  pi.on("session_shutdown", async () => {
    for (const record of [...monitors.values()]) stop(record);
    monitors.clear();
  });
}
