// process.mjs starts this beside Pi. Its stdin closes when Pi exits, even by SIGKILL, and it then stops the runs still listed.
import { createInterface } from "node:readline";
import { stopTree } from "./process.mjs";

const runs = new Map();
createInterface({ input: process.stdin })
	.on("line", (line) => {
		const run = JSON.parse(line);
		if (run.id) runs.set(run.pid, run);
		else runs.delete(run.pid);
	})
	.on("close", () => {
		for (const run of runs.values()) stopTree(run);
	});
