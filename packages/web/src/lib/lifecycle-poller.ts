/**
 * Lifecycle Poller — background job that updates session states.
 *
 * Uses the core LifecycleManager to poll sessions and update metadata.
 * This keeps session states fresh without needing the orchestrator
 * session running.
 */

import {
  createLifecycleManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
  type LifecycleManager,
} from "@composio/ao-core";

let lifecycleManager: LifecycleManager | null = null;

export function startLifecyclePoller(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  sessionManager: SessionManager,
  intervalMs: number = 10_000, // Default 10 seconds
): void {
  if (lifecycleManager) {
    return; // Already running
  }

  lifecycleManager = createLifecycleManager({ config, registry, sessionManager });
  lifecycleManager.start(intervalMs);
}

export function stopLifecyclePoller(): void {
  if (lifecycleManager) {
    lifecycleManager.stop();
    lifecycleManager = null;
  }
}
