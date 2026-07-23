import { PROTOCOL_VERSION } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { AgentConfig } from "../config/agent-config.js";
import type { TimelineStore } from "../events/timeline-store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { probeAuth } from "../orchestrator/auth-status.js";
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

  router.register("task.start", (params) => {
    const taskId = orchestrator.startTask(params.conversationId, params.prompt, {
      model: params.model,
      effort: params.effort,
      planMode: params.planMode,
    });
    return { taskId };
  });

  router.register("task.cancel", (params) => ({
    cancelled: orchestrator.cancelTask(params.taskId),
  }));

  router.register("task.list", (params) => ({
    tasks: conversations.listTasks(params?.activeOnly),
  }));

  router.register("task.getTimeline", (params) =>
    timeline.getTimeline(params.taskId, params.cursor, params.limit)
  );
}
