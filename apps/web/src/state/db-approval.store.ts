import { create } from "zustand";
import type { DbApprovalRequest } from "@atelier/protocol";

/**
 * Database operations the agent has parked, waiting for an answer. A
 * queue, not a single slot: parallel agents can each be holding one.
 * The head of the queue is what the modal shows.
 */
export interface DbApprovalStore {
  requests: DbApprovalRequest[];
  add: (request: DbApprovalRequest) => void;
  remove: (id: string) => void;
}

export const useDbApprovalStore = create<DbApprovalStore>((set) => ({
  requests: [],

  add: (request) =>
    set((s) =>
      s.requests.some((r) => r.id === request.id)
        ? s
        : { requests: [...s.requests, request] }
    ),

  remove: (id) =>
    set((s) => ({ requests: s.requests.filter((r) => r.id !== id) })),
}));
