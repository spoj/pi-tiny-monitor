import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, getShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piModule from "@earendil-works/pi-coding-agent";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...await importOriginal<typeof piModule>(),
}));

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
  context: { cwd: string; hasUI: boolean; isProjectTrusted: () => boolean; ui: { setWidget: (key: string, lines: string[] | undefined) => void } };
  shutdown: () => Promise<void>;
}

const harnesses: Harness[] = [];
let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "pi-tiny-monitor-"));
  mkdirSync(join(testDir, "agent"));
  mkdirSync(join(testDir, CONFIG_DIR_NAME));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(testDir, "agent"));
});

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(testDir, { recursive: true, force: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(source: string): string {
  const encoded = Buffer.from(source).toString("base64");
  const script = `eval(Buffer.from('${encoded}', 'base64').toString())`;
  return `${shellQuote(process.execPath.replaceAll("\\", "/"))} -e ${shellQuote(script)}`;
}

async function loadHarness(hasUI = false): Promise<Harness> {
  const { default: extension } = await import("../src/index.js");
  const tools = new Map<string, Tool>();
  const messages: Message[] = [];
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const widgets = new Map<string, string[] | undefined>();
  const context = {
    cwd: testDir,
    hasUI,
    isProjectTrusted: () => true,
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

  it("uses Pi's default shell rather than SHELL or ComSpec, without login mode", async () => {
    vi.stubEnv("SHELL", "/missing/login-shell");
    vi.stubEnv("ComSpec", "/missing/cmd.exe");
    const harness = await loadHarness();
    const { result } = await start(harness, 'case "$-" in *i*) exit 1;; esac; shopt -q login_shell && exit 1; printf "ok\\n"');

    expect(result.details.shell).toBe(getShellConfig().shell);
    await waitFor(() => harness.messages.length > 0);
    expect(harness.messages[0].details).toMatchObject({ lines: ["ok"], exitCode: 0 });
  });

  it.each([true, false])("honors global settings and project trust (%s)", async (trusted) => {
    const shell = getShellConfig().shell;
    writeFileSync(join(testDir, "agent", "settings.json"), JSON.stringify({
      shellPath: trusted ? "/missing/global-shell" : shell,
      shellCommandPrefix: "export MONITOR_TEST_PREFIX=global",
    }));
    writeFileSync(join(testDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
      shellPath: trusted ? shell : "/missing/untrusted-shell",
      shellCommandPrefix: "export MONITOR_TEST_PREFIX=project",
    }));
    const harness = await loadHarness();
    harness.context.isProjectTrusted = () => trusted;
    const resolveShell = vi.spyOn(piModule, "getShellConfig");
    const { result } = await start(harness, 'printf "%s\\n" "$MONITOR_TEST_PREFIX"');
    expect(resolveShell).toHaveBeenCalledWith(shell);
    expect(result.details.shell).toBe(shell);
    await waitFor(() => harness.messages.length > 0);
    expect(harness.messages[0].details).toMatchObject({ lines: [trusted ? "project" : "global"], exitCode: 0 });
  });

  it("rejects a missing configured shell without falling back or leaving a stale count", async () => {
    writeFileSync(join(testDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ shellPath: "/missing/configured-shell" }));
    const harness = await loadHarness(true);
    await expect(start(harness, "echo never")).rejects.toThrow("Custom shell path not found");
    expect(harness.messages).toEqual([]);
    expect(harness.widgets.get("pi-tiny-monitor")).toBeUndefined();
  });

  it("passes commands via stdin when Pi's shell config requires it", async () => {
    const { shell } = getShellConfig();
    vi.spyOn(piModule, "getShellConfig").mockReturnValue({ shell, args: ["-s"], commandTransport: "stdin" });
    const harness = await loadHarness();
    await start(harness, 'printf "stdin command\\n"');
    await waitFor(() => harness.messages.length > 0);
    expect(harness.messages[0].details).toMatchObject({ lines: ["stdin command"], exitCode: 0 });
  });

  it.each([0, 7])("wakes the session when a silent process exits with code %i", async (exitCode) => {
    const harness = await loadHarness();
    const command = nodeCommand(`process.exit(${exitCode});`);
    const { id } = await start(harness, command);

    await waitFor(() => harness.messages.length > 0);
    expect(harness.messages).toHaveLength(1);
    expect(text(harness.messages[0])).toBe(`[${id}] process exited with code ${exitCode}.`);
    expect(harness.messages[0].details).toEqual({ id, command, lines: [], exitCode, signal: null });
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

  it.each([
    'process.stdout.write("final line");',
    'process.stdout.end("final line"); setTimeout(() => {}, 500);',
  ])("coalesces final stdout and exit: %s", async (source) => {
    const harness = await loadHarness();
    const { id } = await start(harness, nodeCommand(source));

    await waitFor(() => harness.messages.some((message) => text(message).includes("process exited")));
    expect(harness.messages).toHaveLength(1);
    expect(text(harness.messages[0])).toBe(`[${id}]\nfinal line\nprocess exited with code 0.`);
    expect(harness.messages[0].details).toMatchObject({ lines: ["final line"], exitCode: 0, signal: null });
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
      4_700,
    );
  }, 7_000);

  it("stops a monitor when an output line exceeds the limit", async () => {
    const harness = await loadHarness(true);
    await start(harness, nodeCommand('process.stdout.write("x".repeat(100_000)); setTimeout(() => {}, 5000);'));

    await waitFor(() => harness.messages.some((message) => text(message).includes("output line exceeded")));
    const limitMessage = harness.messages.find((message) => text(message).includes("output line exceeded"));
    expect((limitMessage?.details as any).lineLimitExceeded).toBe(true);
    await waitFor(() => harness.widgets.get("pi-tiny-monitor") === undefined);
    expect(harness.messages).toHaveLength(1);
  });

  it.each([
    'for (let i = 0; i < 499; i++) process.stdout.write("x".repeat(1024) + "\\n");',
    'process.stdout.write("終".repeat(20_000) + "\\n");',
  ])("stops oversized batches before delivering them: %s", async (source) => {
    const harness = await loadHarness(true);
    await start(harness, nodeCommand(source));

    await waitFor(() => harness.messages.length > 0);
    expect(text(harness.messages[0])).toContain("output byte limit exceeded");
    await waitFor(() => harness.widgets.get("pi-tiny-monitor") === undefined);
    expect(harness.messages).toHaveLength(1);
    expect(Buffer.byteLength(text(harness.messages[0]))).toBeLessThan(1024);
  });

  it("resets the byte budget after each batch", async () => {
    const harness = await loadHarness();
    await start(harness, nodeCommand([
      'process.stdout.write("a".repeat(30_000) + "\\n");',
      'setTimeout(() => process.stdout.write("b".repeat(30_000) + "\\n"), 2300);',
    ].join(" ")));

    await waitFor(() => harness.messages.some((message) => text(message).includes("process exited")), 4000);
    expect(harness.messages).toHaveLength(2);
    expect(harness.messages[0].details).toMatchObject({ lines: ["a".repeat(30_000)] });
    expect(harness.messages[1].details).toMatchObject({ lines: ["b".repeat(30_000)], exitCode: 0 });
  });

  it.each(["\u0007", "\u001b\\", "\u009c"])("removes split terminal controls with terminator %j", async (terminator) => {
    const harness = await loadHarness();
    const first = "\u001b]52;c;";
    const last = `cHduZWQ=${terminator}\u001b]0;fake title${terminator}\u009d0;c1 title${terminator}\u001b[?2004l\u001b[2J\u001b[31mred\u001b[0m\r\u0000\b\u009b\t終\n`;
    await start(harness, nodeCommand([
      `process.stdout.write(${JSON.stringify(first)});`,
      `setTimeout(() => process.stdout.write(${JSON.stringify(last)}), 20);`,
    ].join(" ")));

    await waitFor(() => harness.messages.some((message) => text(message).includes("process exited")));
    expect(harness.messages).toHaveLength(1);
    expect(harness.messages[0].details).toMatchObject({ lines: ["red\t終"], exitCode: 0 });
    expect(text(harness.messages[0])).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("coalesces lines over two seconds and sends a steer that triggers a turn", async () => {
    const harness = await loadHarness();
    const started = Date.now();
    await start(
      harness,
      nodeCommand(
        'process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 1_000); setTimeout(() => {}, 5_000);',
      ),
    );

    await waitFor(() => harness.messages.some((message) => text(message).includes("second")), 3_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
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
