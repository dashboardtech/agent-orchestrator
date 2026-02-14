"use client";

import { useState, useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { cn } from "@/lib/cn";

interface TerminalProps {
  sessionId: string;
}

/**
 * Terminal embed using xterm.js.
 * Streams tmux pane output via SSE and optionally allows input.
 */
export function Terminal({ sessionId }: TerminalProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [inputMode, setInputMode] = useState(false);
  const [inputText, setInputText] = useState("");
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Initialize xterm.js
  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance
    const term = new XTerm({
      cursorBlink: false,
      disableStdin: true, // Read-only by default
      theme: {
        background: "#000000",
        foreground: "#d0d0d0",
        cursor: "transparent", // Hide cursor in read-only mode
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.4,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle window resize
    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Refit terminal when fullscreen changes
  useEffect(() => {
    if (fitAddonRef.current) {
      // Slight delay for DOM to update
      setTimeout(() => fitAddonRef.current?.fit(), 100);
    }
  }, [fullscreen]);

  // Connect to SSE stream
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;

    const eventSource = new EventSource(`/api/sessions/${sessionId}/terminal`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data) as
          | { type: "snapshot" | "update"; content: string }
          | { type: "exit" };

        if (data.type === "snapshot" || data.type === "update") {
          // Clear and write full content
          term.clear();
          term.write(data.content);
        } else if (data.type === "exit") {
          term.writeln("\r\n\r\n[Session exited]");
        }
      } catch (err) {
        console.error("[Terminal] Failed to parse SSE event:", err);
      }
    });

    eventSource.addEventListener("error", () => {
      eventSource.close();
      term.writeln("\r\n\r\n[Connection lost]");
    });

    return () => {
      eventSource.close();
      eventSourceRef.current = null;
    };
  }, [sessionId]);

  // Send input to session
  const handleSendInput = async () => {
    if (!inputText.trim()) return;

    try {
      const response = await fetch(`/api/sessions/${sessionId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: inputText }),
      });

      if (!response.ok) {
        const err = (await response.json()) as { error?: string };
        console.error("[Terminal] Failed to send input:", err.error);
      } else {
        setInputText("");
      }
    } catch (err) {
      console.error("[Terminal] Failed to send input:", err);
    }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-[#f85149]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#d29922]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#3fb950]" />
        </div>
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
        <button
          onClick={() => setInputMode(!inputMode)}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {inputMode ? "read-only" : "input"}
        </button>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? "exit fullscreen" : "fullscreen"}
        </button>
      </div>
      <div
        ref={terminalRef}
        className={cn(fullscreen ? "h-[calc(100vh-36px)]" : "h-96")}
      />
      {inputMode && (
        <div className="flex gap-2 border-t border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] p-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                void handleSendInput();
              }
            }}
            placeholder="Send message to agent..."
            className="flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-blue)]"
          />
          <button
            onClick={() => void handleSendInput()}
            disabled={!inputText.trim()}
            className="rounded bg-[var(--color-accent-blue)] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
