// A driver plugin in miniature: it declares one agent driver, probes for its
// harness, and runs that harness as a real supervised child process, mapping
// the harness's own line protocol to dohc's agent events.
import { join } from "node:path";

const mode = process.env.DOHC_PLUGIN_FIXTURE_MODE ?? "driver";
const heartbeatPath = process.env.DOHC_DRIVER_FIXTURE_HEARTBEAT ?? "";

function createDriver(ctx, options = {}) {
  return {
    probe() {
      return {
        installed: true,
        version: "fixture-harness 1.0.0",
        auth: {
          status: "unauthenticated",
          label: "CLI login",
          // Personal data on purpose: dohc must keep both of these out of
          // its renderer.
          email: "person@example.com",
          loginHint: "Run `fixture-harness login`.",
        },
        models: [
          { id: "fixture-fast", name: "Fixture Fast", planIncluded: true },
        ],
      };
    },
    async startSession(input) {
      input.onEvent({ kind: "session-state", state: "starting" });
      // What dohc handed this driver, reported back so a test can read what
      // actually crossed the boundary.
      input.onEvent({
        kind: "text-delta",
        stream: "reasoning",
        itemId: "start-input",
        text: JSON.stringify({
          workspaceRoot: input.workspaceRoot,
          mode: input.mode,
          model: input.model ?? null,
          resumeCursor: input.resumeCursor ?? null,
          mcpCommand: input.mcp.command,
          mcpArgs: input.mcp.args,
          logDir: input.logDir ?? null,
        }),
      });

      const args = [join(ctx.pluginRoot, "harness.mjs")];
      if (heartbeatPath) args.push(heartbeatPath);
      const harness = await ctx.childProcesses.spawnCommand({
        command: process.execPath,
        args,
        cwd: { workspaceRoot: true },
      });

      let buffered = "";
      await harness.onOutput((output) => {
        if (output.stream !== "stdout") return;
        buffered += output.text;
        let breakAt = buffered.indexOf("\n");
        while (breakAt >= 0) {
          const line = buffered.slice(0, breakAt);
          buffered = buffered.slice(breakAt + 1);
          if (line.trim().length > 0) report(JSON.parse(line));
          breakAt = buffered.indexOf("\n");
        }
      });

      function report(message) {
        if (message.type === "delta") {
          input.onEvent({
            kind: "text-delta",
            stream: "assistant",
            itemId: "answer",
            text: message.text,
          });
          return;
        }
        if (message.type === "tool") {
          input.onEvent({
            kind: "item",
            phase: "completed",
            item: {
              id: "tool-1",
              type: "tool_call",
              title: message.title,
              status: "completed",
              // The harness's own payload. dohc drops it at the boundary.
              raw: { secret: message.secret },
            },
          });
          return;
        }
        if (message.type === "permission") {
          input.onEvent({
            kind: "permission-request",
            requestId: message.requestId,
            requestType: "command",
            title: "Run a command",
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          return;
        }
        if (message.type === "permission-resolved") {
          input.onEvent({
            kind: "permission-resolved",
            requestId: message.requestId,
            decision: message.decision,
          });
          return;
        }
        if (message.type === "login-required") {
          input.onEvent({
            kind: "auth",
            event: "login-required",
            detail: "The fixture harness login expired. Run `fixture-harness login`.",
          });
          return;
        }
        if (message.type === "ready") {
          input.onEvent({ kind: "session-state", state: "ready" });
          return;
        }
        if (message.type === "done") {
          input.onEvent({
            kind: "turn-completed",
            turnId: message.turnId ?? "turn-1",
            status: "completed",
          });
        }
      }

      let turn = 0;
      const session = {
        sessionId: `fixture-session-${harness.id}`,
        resumeCursor: options.badCursor
          ? () => "not JSON"
          : { threadId: "fixture-thread", pid: harness.pid },
        async prompt({ text }) {
          turn += 1;
          const turnId = `turn-${turn}`;
          await harness.write(`${JSON.stringify({ type: "prompt", text, turnId })}\n`);
          return { turnId };
        },
        async cancel() {
          await harness.write(`${JSON.stringify({ type: "cancel" })}\n`);
        },
        async answerPermission(requestId, decision) {
          await harness.write(
            `${JSON.stringify({ type: "permission-answer", requestId, decision })}\n`,
          );
        },
        async stop() {
          await harness.terminate();
        },
        async dispose() {
          await harness.terminate();
        },
      };
      if (!options.withoutOptionalMembers) {
        session.setModel = async (modelId) => {
          await harness.write(`${JSON.stringify({ type: "set-model", modelId })}\n`);
        };
      }
      return session;
    },
  };
}

let handler;

switch (mode) {
  case "driver":
    handler = {
      activate(ctx) {
        ctx.drivers.register("fixture-harness", createDriver(ctx));
      },
    };
    break;
  // Declares a driver and never registers it: dohc would otherwise show a
  // probe row nothing can answer.
  case "declares-but-never-registers":
    handler = { activate() {} };
    break;
  case "registers-an-undeclared-driver":
    handler = {
      activate(ctx) {
        ctx.drivers.register("fixture-harness", createDriver(ctx));
        ctx.drivers.register("surprise-harness", createDriver(ctx));
      },
    };
    break;
  case "registers-the-same-driver-twice":
    handler = {
      activate(ctx) {
        ctx.drivers.register("fixture-harness", createDriver(ctx));
        ctx.drivers.register("fixture-harness", createDriver(ctx));
      },
    };
    break;
  case "resume-cursor-is-not-json":
    handler = {
      activate(ctx) {
        ctx.drivers.register(
          "fixture-harness",
          createDriver(ctx, { badCursor: true }),
        );
      },
    };
    break;
  case "session-without-optional-members":
    handler = {
      activate(ctx) {
        ctx.drivers.register(
          "fixture-harness",
          createDriver(ctx, { withoutOptionalMembers: true }),
        );
      },
    };
    break;
  default:
    throw new Error(`Unknown driver-plugin fixture mode: ${mode}`);
}

export default handler;
