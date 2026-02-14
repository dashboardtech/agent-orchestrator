import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { tmuxCapturePane } from "@agent-orchestrator/core";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/:id/terminal — SSE stream of tmux pane output
 *
 * Polls `tmux capture-pane -p -e` every 2 seconds with ANSI escape codes.
 * The client (xterm.js) interprets ANSI colors/formatting.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  // Verify the session exists
  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.get(id);
    if (!session) {
      return NextResponse.json({ error: `Session ${id} not found` }, { status: 404 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load session";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastOutput = "";

  const stream = new ReadableStream({
    start(controller) {
      // Send initial output immediately
      void (async () => {
        try {
          // Use -e flag for ANSI escape sequences, capture recent 100 lines
          const output = await tmuxCapturePane(id, 100);
          lastOutput = output;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "snapshot", content: output })}\n\n`,
            ),
          );
        } catch {
          // If capture fails, send empty snapshot
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "snapshot", content: "" })}\n\n`),
          );
        }
      })();

      // Poll every 2 seconds for new output
      interval = setInterval(() => {
        void (async () => {
          try {
            const output = await tmuxCapturePane(id, 100);
            // Only send if output has changed
            if (output !== lastOutput) {
              lastOutput = output;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "update", content: output })}\n\n`,
                ),
              );
            }
          } catch {
            // Session might have been killed — send exit event and close stream
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "exit" })}\n\n`),
              );
              controller.close();
            } catch {
              // Stream already closed
            }
            clearInterval(interval);
          }
        })();
      }, 2000);
    },
    cancel() {
      clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
