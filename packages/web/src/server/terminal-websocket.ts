/**
 * WebSocket server for interactive terminal sessions.
 *
 * Runs alongside Next.js on port 3001.
 * Uses tmux control mode for true incremental streaming (not polling).
 */

import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";

interface TerminalSession {
  sessionId: string;
  ws: WebSocket;
  tmuxProcess: ChildProcess | null;
}

/**
 * Unescape octal sequences from tmux control mode output.
 * Example: "Hello\040World" -> "Hello World"
 */
function unescapeOctal(str: string): string {
  return str.replace(/\\(\d{3})/g, (_, octal) =>
    String.fromCharCode(parseInt(octal, 8))
  );
}

const sessions = new Map<string, TerminalSession>();

const server = createServer();
const wss = new WebSocketServer({ server });

console.log("[WebSocket] Server ready, waiting for connections...");

wss.on("connection", (ws, req) => {
  console.log(`[WebSocket] New connection attempt from ${req.socket.remoteAddress}`);
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionId = url.searchParams.get("session");

  console.log(`[WebSocket] Requested session: ${sessionId}`);

  if (!sessionId) {
    console.error("[WebSocket] No session parameter provided");
    ws.close(1008, "Missing session parameter");
    return;
  }

  console.log(`[WebSocket] Client connected to session: ${sessionId}`);

  // Create session
  const session: TerminalSession = {
    sessionId,
    ws,
    tmuxProcess: null,
  };

  sessions.set(sessionId, session);

  console.log(`[WebSocket] Starting tmux control mode for ${sessionId}`);

  // Start tmux in control mode attached to existing session
  const tmuxProcess = spawn("tmux", ["-C", "attach-session", "-t", sessionId]);

  session.tmuxProcess = tmuxProcess;

  let buffer = "";

  // Handle control mode output
  tmuxProcess.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith("%output")) {
        // Parse: %output %<pane-id> <escaped-output>
        const match = line.match(/^%output %\d+ (.*)$/);
        if (match) {
          const output = unescapeOctal(match[1]);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(output);
          }
        }
      } else if (line.startsWith("%layout-change")) {
        // Layout changed (e.g., pane resized)
        console.log(`[WebSocket] Layout changed for ${sessionId}`);
      } else if (line.startsWith("%exit")) {
        // Session ended
        console.log(`[WebSocket] Session ${sessionId} exited`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("\r\n\r\n[Session exited]");
          ws.close(1000, "Session ended");
        }
      } else if (line.startsWith("%error")) {
        // Error from tmux
        console.error(`[WebSocket] tmux error for ${sessionId}: ${line}`);
      }
      // Ignore other control messages (%begin, %end, etc.)
    }
  });

  tmuxProcess.stderr?.on("data", (data: Buffer) => {
    console.error(`[WebSocket] tmux stderr for ${sessionId}:`, data.toString());
  });

  tmuxProcess.on("exit", (code) => {
    console.log(`[WebSocket] tmux process exited for ${sessionId} with code ${code}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1000, "tmux process ended");
    }
  });

  tmuxProcess.on("error", (err) => {
    console.error(`[WebSocket] tmux process error for ${sessionId}:`, err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, "tmux process failed");
    }
  });

  // Handle input from client
  ws.on("message", (message) => {
    const data = message.toString("utf-8");

    try {
      const msg = JSON.parse(data) as { type: string; data?: string; cols?: number; rows?: number };

      if (msg.type === "input" && msg.data && tmuxProcess.stdin) {
        // Send input via control mode stdin
        // Use send-keys command with -l flag (literal) to prevent interpretation
        const escaped = msg.data.replace(/'/g, "'\\''"); // Escape single quotes
        tmuxProcess.stdin.write(`send-keys -t ${sessionId} -l '${escaped}'\n`);
      } else if (msg.type === "resize" && msg.cols && msg.rows) {
        // Resize via control mode stdin
        console.log(`[WebSocket] Resizing pane ${sessionId} to ${msg.cols}x${msg.rows}`);
        if (tmuxProcess.stdin) {
          tmuxProcess.stdin.write(
            `resize-pane -t ${sessionId} -x ${msg.cols} -y ${msg.rows}\n`
          );
        }
      }
    } catch (err) {
      console.error(`[WebSocket] Failed to parse message:`, err);
    }
  });

  // Handle disconnect
  ws.on("close", () => {
    console.log(`[WebSocket] Client disconnected from session: ${sessionId}`);

    // Kill tmux control mode process
    if (tmuxProcess && !tmuxProcess.killed) {
      tmuxProcess.kill();
    }

    sessions.delete(sessionId);
  });
});

const PORT = parseInt(process.env.WS_PORT ?? "3001", 10);

server.listen(PORT, () => {
  console.log(`[WebSocket] Terminal server listening on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[WebSocket] Shutting down...");
  wss.close();
  server.close();
  process.exit(0);
});
