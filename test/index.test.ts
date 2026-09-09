import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Message {
  content?: unknown;
  details?: unknown;
  options?: unknown;
}

interface Tool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface Harness {
  tools: Map<string, Tool>;
  messages: Message[];
  events: Map<string, Array<(...args: unknown[]) => unknown>>;
  widgets: Map<string, string[] | undefined>;
  context: { cwd: string; hasUI: boolean; ui: { setWidget: (key: string, lines: string[] | undefined) => void } };
  shutdown: () => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.shutdown()));
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source).toString("base64");
  const script = `eval(Buffer.from('${encoded}', 'base64').toString())`;
  return process.platform === "win32"
    ? `"${process.execPath}" -e "${script}"`
    : `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

async function loadHarness(hasUI = false): Promise<Harness> {
  const { default: extension } = await import("../src/index.js");
  const tools = new Map<string, Tool>();
  const messages: Message[] = [];
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const widgets = new Map<string, string[] | undefined>();
  const context = {
    cwd: process.cwd(),
    hasUI,
    ui: { setWidget: (key: string, lines: string[] | undefined) => { widgets.set(key, lines); } },
  };
  const pi = {
    registerTool(tool: Tool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const handlers = events.get(event) ?? [];
      handlers.push(handler);
      events.set(event, handlers);
    },
    sendMessage(message: Message, options?: unknown) {
      messages.push({ ...message, options });
    },
  };

  extension(pi as unknown as ExtensionAPI);
  const harness: Harness = {
    tools,
    messages,
    events,
    widgets,
    context,
    async shutdown() {
      for (const handler of events.get("session_shutdown") ?? []) {
        await handler({ reason: "quit" }, context);
      }
    },
  };
  harnesses.push(harness);
  for (const handler of events.get("session_start") ?? []) {
    await handler({ reason: "startup" }, context);
  }
  return harness;
}

function tool(harness: Harness, name: string): Tool {
  const registered = harness.tools.get(name);
  if (!registered) throw new Error(`Tool ${name} was not registered`);
  return registered;
}

async function start(harness: Harness, command: string): Promise<{ id: string; result: any }> {
  const result = await tool(harness, "monitor").execute(
    "start",
    { command },
    undefined,
    undefined,
    harness.context,
  );
  const details = (result as any).details ?? {};
  const id = details.id ?? String((result as any).content?.[0]?.text).match(/mon_[a-z0-9-]+/)?.[0];
  if (!id) throw new Error(`Could not find monitor id in ${JSON.stringify(result)}`);
  return { id, result };
}

async function stop(harness: Harness, id: string): Promise<void> {
  await tool(harness, "monitor_stop").execute(
    "stop",
    { id },
    undefined,
    undefined,
    harness.context,
  );
}

function text(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part: any) => (part?.type === "text" ? part.text : ""))
      .join("");
  }
  return "";
}

async function waitFor(condition: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started >= timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("monitor extension", () => {
  it("registers only monitor and monitor_stop", async () => {
    const harness = await loadHarness();
    expect([...harness.tools.keys()]).toEqual(["monitor", "monitor_stop"]);
  });

  it.each([0, 7])("wakes the session when a silent process exits with code %i", async (exitCode) => {
    const harness = await loadHarness();
    const command = nodeCommand(`process.exit(${exitCode});`);
    const { id } = await start(harness, command);

    await waitFor(() => harness.messages.length > 0);
    expect(harness.messages).toHaveLength(1);
    expect(text(harness.messages[0])).toBe(`[${id}] process exited with code ${exitCode}.`);
    expect(harness.messages[0].details).toEqual({ id, command, exitCode, signal: null });
    expect(harness.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(harness.widgets.size).toBe(0);
  });

  it.skipIf(process.platform === "win32")("reports signal exits", async () => {
    const harness = await loadHarness();
    const { id } = await start(harness, `exec ${nodeCommand('process.kill(process.pid, "SIGTERM");')}`);

    await waitFor(() => harness.messages.length > 0);
    expect(text(harness.messages[0])).toBe(`[${id}] process exited with signal SIGTERM.`);
    expect(harness.messages[0].details).toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });

  it("delivers final stdout before the exit notification", async () => {
    const harness = await loadHarness();
    await start(harness, nodeCommand('process.stdout.write("final line");'));

    await waitFor(() => harness.messages.some((message) => text(message).includes("process exited")));
    expect(harness.messages).toHaveLength(2);
    expect(text(harness.messages[0])).toContain("final line");
    expect(text(harness.messages[1])).toContain("process exited with code 0");
  });

  it("updates the running count on start, stop, exit, and shutdown", async () => {
    const harness = await loadHarness(true);
    expect(harness.widgets.get("pi-tiny-monitor")).toBeUndefined();
    const first = await start(harness, nodeCommand("setTimeout(() => {}, 5000);"));
    expect(harness.widgets.get("pi-tiny-monitor")).toEqual(["1 monitors running"]);
    await start(harness, nodeCommand("setTimeout(() => {}, 500);"));
    expect(harness.widgets.get("pi-tiny-monitor")).toEqual(["2 monitors running"]);

    await stop(harness, first.id);
    expect(harness.widgets.get("pi-tiny-monitor")).toEqual(["1 monitors running"]);
    await waitFor(() => harness.widgets.get("pi-tiny-monitor") === undefined);

    await start(harness, nodeCommand("setTimeout(() => {}, 5000);"));
    await harness.shutdown();
    expect(harness.widgets.get("pi-tiny-monitor")).toBeUndefined();
  });

  it("does not wake the session for explicit stops or shutdown", async () => {
    const harness = await loadHarness();
    const first = await start(harness, nodeCommand("setTimeout(() => {}, 5000);"));
    await stop(harness, first.id);
    await start(harness, nodeCommand("setTimeout(() => {}, 5000);"));
    await harness.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.messages).toEqual([]);
  });

  it("splits CRLF and UTF-8 boundaries and delivers an unterminated final line", async () => {
    const harness = await loadHarness();
    const source = [
      'const bytes = Buffer.from("α\\r\\nβ\\n終");',
      "process.stdout.write(bytes.subarray(0, 1));",
      "setTimeout(() => process.stdout.write(bytes.subarray(1, 3)), 10);",
      "setTimeout(() => process.stdout.write(bytes.subarray(3)), 20);",
    ].join(" ");

    await start(harness, nodeCommand(source));
    await waitFor(() => harness.messages.some((message) => text(message).includes("終")));

    const output = harness.messages.map(text).join("\n");
    expect(output).toContain("α");
    expect(output).toContain("β");
    expect(output).toContain("終");
    expect(output).not.toContain("�");
  });

  it("flushes steady output instead of waiting for the process to go quiet", async () => {
    const harness = await loadHarness();
    await start(
      harness,
      nodeCommand('setInterval(() => process.stdout.write("tick\\n"), 50);'),
    );

    await waitFor(
      () => harness.messages.filter((message) => text(message).includes("tick")).length >= 2,
      700,
    );
  });

  it("stops a monitor when an output line exceeds the limit", async () => {
    const harness = await loadHarness(true);
    await start(harness, nodeCommand('process.stdout.write("x".repeat(100_000)); setTimeout(() => {}, 5000);'));

    await waitFor(() => harness.messages.some((message) => text(message).includes("output line exceeded")));
    const limitMessage = harness.messages.find((message) => text(message).includes("output line exceeded"));
    expect((limitMessage?.details as any).lineLimitExceeded).toBe(true);
    await waitFor(() => harness.widgets.get("pi-tiny-monitor") === undefined);
    expect(harness.messages).toHaveLength(1);
  });

  it("coalesces nearby lines and sends a steer that triggers a turn", async () => {
    const harness = await loadHarness();
    await start(
      harness,
      nodeCommand(
        'process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 50); setTimeout(() => {}, 500);',
      ),
    );

    await waitFor(() => harness.messages.some((message) => text(message).includes("second")));
    const eventMessages = harness.messages.filter((message) => text(message).includes("first"));
    expect(eventMessages).toHaveLength(1);
    expect(text(eventMessages[0])).toContain("second");

    expect(eventMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });

  it("returns from start while the process is still running", async () => {
    const harness = await loadHarness();
    const started = Date.now();
    const { id } = await start(
      harness,
      nodeCommand('setTimeout(() => process.stdout.write("done\\n"), 800); setTimeout(() => {}, 900);'),
    );

    expect(Date.now() - started).toBeLessThan(300);
    await stop(harness, id);
  });

  it("rejects starts after session shutdown begins", async () => {
    const harness = await loadHarness();
    await harness.shutdown();

    await expect(start(harness, nodeCommand("setTimeout(() => {}, 5000);"))).rejects.toThrow(
      "session shutdown has begun",
    );
  });

  it("propagates asynchronous spawn failures without an exit wake-up or stale count", async () => {
    const harness = await loadHarness(true);
    const context = { ...harness.context, cwd: join(tmpdir(), `missing-${process.pid}-${Date.now()}`) };

    await expect(
      tool(harness, "monitor").execute("start", { command: "echo never" }, undefined, undefined, context),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.messages).toEqual([]);
    expect(harness.widgets.get("pi-tiny-monitor")).toBeUndefined();
  });

  it("enforces the maximum number of running monitors", async () => {
    const harness = await loadHarness();
    const command = nodeCommand("setTimeout(() => {}, 5000);");
    await Promise.all(Array.from({ length: 8 }, () => start(harness, command)));

    await expect(
      tool(harness, "monitor").execute(
        "start",
        { command },
        undefined,
        undefined,
        harness.context,
      ),
    ).rejects.toThrow("Maximum of 8 monitors");
  });

  it.skipIf(process.platform === "win32")("stops descendants of a monitor", async () => {
    const harness = await loadHarness();
    const marker = join(tmpdir(), `pi-tiny-monitor-${process.pid}-${Date.now()}.marker`);
    rmSync(marker, { force: true });
    try {
      const descendant = `process.on("SIGTERM", () => {}); const fs = require("node:fs"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "leaked"), 1500);`;
      const source = `const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); child.unref(); process.stdout.write("ready\\n");`;
      await start(harness, nodeCommand(source));
      await waitFor(() => harness.messages.some((message) => text(message).includes("ready")));

      await new Promise((resolve) => setTimeout(resolve, 1800));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it("stops a noisy process once it exceeds the rate limit", async () => {
    const harness = await loadHarness();
    await start(
      harness,
      nodeCommand(
        'for (let i = 0; i < 1000; i++) process.stdout.write("noise\\n"); setTimeout(() => process.stdout.write("survived\\n"), 300); setTimeout(() => {}, 1000);',
      ),
    );

    await waitFor(() => harness.messages.some((message) => text(message).includes("rate limit exceeded")));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.messages.map(text).join("\n")).not.toContain("survived");
  });

  it("terminates owned processes on stop and session shutdown", async () => {
    const harness = await loadHarness();
    const first = await start(harness, nodeCommand('setTimeout(() => process.stdout.write("should-not-print\\n"), 500); setTimeout(() => {}, 700);'));
    const stopStarted = Date.now();
    await stop(harness, first.id);
    expect(Date.now() - stopStarted).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.messages.map(text).join("\n")).not.toContain("should-not-print");

    await start(harness, nodeCommand('setTimeout(() => process.stdout.write("shutdown-leak\\n"), 500); setTimeout(() => {}, 700);'));
    await harness.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.messages.map(text).join("\n")).not.toContain("shutdown-leak");
  });
});
