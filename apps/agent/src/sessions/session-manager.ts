import { PROTOCOL_VERSION } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import type { AgentConfig } from "../config/agent-config.js";
import type { TimelineStore } from "../events/timeline-store.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import { probeAuth } from "../orchestrator/auth-status.js";
import {
  listSlashCommands,
  readSlashCommandDetail,
} from "../orchestrator/command-catalog.js";
import { listMcpServers } from "../orchestrator/mcp-catalog.js";
import { MCP_SERVER_NAME } from "../orchestrator/sdk-tools.js";
import type { Router } from "../bridge/router.js";
import { RpcError } from "../bridge/router.js";
import type { ConversationRepo } from "../storage/repositories/conversations.js";
import type { SettingsRepo } from "../storage/repositories/settings.js";

/** Registers session.* and task.* RPC handlers. */
export function registerSessionHandlers(
  router: Router,
  config: AgentConfig,
  conversations: ConversationRepo,
  orchestrator: Orchestrator,
  timeline: TimelineStore,
  settings: SettingsRepo
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
    commands: listSlashCommands(config.workspaceRoot, settings.get().disabledSkills),
  }));

  router.register("session.getCommandDetail", (params) => {
    const detail = readSlashCommandDetail(
      config.workspaceRoot,
      params.id,
      settings.get().disabledSkills
    );
    if (!detail) throw new RpcError("NOT_FOUND", `Unknown command: ${params.id}`);
    return detail;
  });

  router.register("session.setCommandEnabled", (params) => {
    const detail = readSlashCommandDetail(
      config.workspaceRoot,
      params.id,
      settings.get().disabledSkills
    );
    if (!detail) throw new RpcError("NOT_FOUND", `Unknown command: ${params.id}`);
    if (detail.command.kind !== "skill") return { command: detail.command };

    const current = settings.get().disabledSkills;
    const disabledSkills = params.enabled
      ? current.filter((id) => id !== params.id)
      : [...new Set([...current, params.id])];
    settings.save({ disabledSkills });
    const updated = readSlashCommandDetail(
      config.workspaceRoot,
      params.id,
      disabledSkills
    );
    if (!updated) throw new RpcError("NOT_FOUND", `Unknown command: ${params.id}`);
    return { command: updated.command };
  });

  router.register("session.listMcpServers", () => ({
    servers: listMcpServers(config.workspaceRoot, MCP_SERVER_NAME),
  }));

  router.register("task.start", (params) => {
    const disabled = disabledSlash(params.prompt, config.workspaceRoot, settings);
    if (disabled) {
      throw new RpcError(
        "INVALID_PARAMS",
        `Skill /${disabled.name} is disabled in Settings.`
      );
    }
    const taskId = orchestrator.startTask(params.conversationId, params.prompt, {
      model: params.model,
      effort: params.effort,
      planMode: params.planMode,
      vibe: params.vibe,
      systemKnowledge: params.systemKnowledge,
      scopeRoots: params.scopeRoots,
      images: params.images,
      promptFile: params.promptFile,
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

function disabledSlash(
  prompt: string,
  workspaceRoot: string,
  settings: SettingsRepo
): { name: string } | null {
  const match = prompt.trimStart().match(/^\/([^\s]+)/);
  if (!match?.[1]) return null;
  const command = listSlashCommands(
    workspaceRoot,
    settings.get().disabledSkills
  ).find((c) => c.kind === "skill" && c.name === match[1]);
  return command && !command.enabled ? { name: command.name } : null;
}
