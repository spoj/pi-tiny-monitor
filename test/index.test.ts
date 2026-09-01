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
  context: { cwd: string; hasUI: false };
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
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
}

async function loadHarness(): Promise<Harness> {
  const { default: extension } = await import("../src/index.js");
  const tools = new Map<string, Tool>();
  const messages: Message[] = [];
  const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const context = { cwd: process.cwd(), hasUI: false as const };
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
    context,
    async shutdown() {
      for (const handler of events.get("session_shutdown") ?? []) {
        await handler({ reason: "quit" }, context);
      }
    },
  };
  harnesses.push(harness);
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

function resultText(result: any): string {
  return text({ content: result?.content });
}

async function waitFor(condition: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started >= timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("monitor extension", () => {
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
    const listing = await tool(harness, "monitor_list").execute(
      "list",
      {},
      undefined,
      undefined,
      harness.context,
    );
    expect(resultText(listing)).toContain(id);
  });

  it("stops a noisy process once it exceeds the rate limit", async () => {
    const harness = await loadHarness();
    const { id } = await start(
      harness,
      nodeCommand(
        'for (let i = 0; i < 1000; i++) process.stdout.write("noise\\n"); setTimeout(() => process.stdout.write("survived\\n"), 300); setTimeout(() => {}, 1000);',
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.messages.map(text).join("\n")).not.toContain("survived");
    const listing = await tool(harness, "monitor_list").execute(
      "list",
      {},
      undefined,
      undefined,
      harness.context,
    );
    expect(resultText(listing)).not.toContain(id);
  });

  it("terminates owned processes on stop and session shutdown", async () => {
    const harness = await loadHarness();
    const first = await start(harness, nodeCommand('setTimeout(() => process.stdout.write("should-not-print\\n"), 500); setTimeout(() => {}, 700);'));
    await stop(harness, first.id);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.messages.map(text).join("\n")).not.toContain("should-not-print");

    await start(harness, nodeCommand('setTimeout(() => process.stdout.write("shutdown-leak\\n"), 500); setTimeout(() => {}, 700);'));
    await harness.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.messages.map(text).join("\n")).not.toContain("shutdown-leak");
  });
});
