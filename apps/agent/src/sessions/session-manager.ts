import { PROTOCOL_VERSION } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { AgentConfig } from "../config/agent-config.js";
import type { TimelineStore } from "../events/timeline-store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { probeAuth } from "../orchestrator/auth-status.js";
import { listSlashCommands } from "../orchestrator/command-catalog.js";
import type { Router } from "../bridge/router.js";
import { RpcError } from "../bridge/router.js";
import type { ConversationRepo } from "../storage/repositories/conversations.js";

/** Registers session.* and task.* RPC handlers. */
export function registerSessionHandlers(
  router: Router,
  config: AgentConfig,
  conversations: ConversationRepo,
  orchestrator: Orchestrator,
  timeline: TimelineStore
): void {
  router.register("session.hello", (params) => {
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(
        "INVALID_PARAMS",
        `Protocol mismatch: agent=${PROTOCOL_VERSION} client=${params.protocolVersion}`
      );
    }
    const auth = probeAuth();
    return {
      sessionId: newId("sess"),
      agentVersion: config.agentVersion,
      protocolVersion: PROTOCOL_VERSION,
      workspaceRoot: config.workspaceRoot,
      authStatus: auth.status,
    };
  });

  router.register("session.listConversations", () => ({
    conversations: conversations.list(),
  }));

  router.register("session.createConversation", (params) => {
    const now = Date.now();
    const conversation = conversations.create({
      id: newId("conv"),
      title: params.title ?? "New conversation",
      sdkSessionId: null,
      createdAt: now,
      updatedAt: now,
    });
    return { conversation };
  });

  router.register("session.getMessages", (params) => ({
    messages: conversations.getMessages(params.conversationId),
  }));

  router.register("session.listCommands", () => ({
    commands: listSlashCommands(config.workspaceRoot),
  }));

  router.register("task.start", (params) => {
    const taskId = orchestrator.startTask(params.conversationId, params.prompt, {
      model: params.model,
      effort: params.effort,
      planMode: params.planMode,
      vibe: params.vibe,
      images: params.images,
    });
    return { taskId };
  });

  router.register("task.cancel", (params) => ({
    cancelled: orchestrator.cancelTask(params.taskId),
  }));

  router.register("task.list", (params) => {
    const tasks = conversations.listTasks(params?.activeOnly);
    if (!params?.activeOnly) return { tasks };
    // "Active" must mean live in the orchestrator, not just a "running" DB
    // row: if the agent restarted mid-task the row stays "running" forever.
    // Intersecting with the live set keeps a reloading client from restoring
    // a phantom busy state that would wedge the composer.
    const live = new Set(orchestrator.listRunningTaskIds());
    return { tasks: tasks.filter((t) => live.has(t.id)) };
  });

  router.register("task.getTimeline", (params) =>
    timeline.getTimeline(params.taskId, params.cursor, params.limit)
  );
}
