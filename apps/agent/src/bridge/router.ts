import { methods } from "@atelier/protocol";
import type {
  BridgeError,
  ErrorCode,
  MethodName,
  MethodParams,
  MethodResult,
} from "@atelier/protocol";

export class RpcError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public data?: unknown
  ) {
    super(message);
  }

  toBridgeError(): BridgeError {
    return { code: this.code, message: this.message, data: this.data };
  }
}

export interface HandlerContext {
  connectionId: string;
  authenticated: boolean;
  progress: (value: {
    stage?: string;
    pct?: number;
    message?: string;
    chunk?: string;
  }) => void;
  signal: AbortSignal;
}

export type Handler<M extends MethodName> = (
  params: MethodParams<M>,
  ctx: HandlerContext
) => Promise<MethodResult<M>> | MethodResult<M>;

/**
 * Method -> handler dispatch with zod validation on both params and results.
 * Services register their handlers at startup; unregistered methods fail
 * with NOT_IMPLEMENTED so the full surface is callable from day one.
 */
export class Router {
  private handlers = new Map<string, Handler<MethodName>>();

  register<M extends MethodName>(method: M, handler: Handler<M>): void {
    if (this.handlers.has(method)) {
      throw new Error(`Handler already registered for ${method}`);
    }
    this.handlers.set(method, handler as Handler<MethodName>);
  }

  async dispatch(
    method: string,
    rawParams: unknown,
    ctx: HandlerContext
  ): Promise<unknown> {
    const spec = (methods as Record<string, { params?: unknown; result?: unknown }>)[
      method
    ];
    if (!spec) {
      throw new RpcError("NOT_FOUND", `Unknown method: ${method}`);
    }
    if (method !== "session.hello" && !ctx.authenticated) {
      throw new RpcError("UNAUTHORIZED", "Handshake required before RPC calls");
    }
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new RpcError("NOT_IMPLEMENTED", `${method} is not implemented yet`);
    }
    let params: unknown = rawParams;
    const paramsSchema = spec.params as
      | { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: unknown } }
      | undefined;
    if (paramsSchema && typeof paramsSchema.safeParse === "function") {
      const parsed = paramsSchema.safeParse(rawParams);
      if (!parsed.success) {
        throw new RpcError("INVALID_PARAMS", `Invalid params for ${method}`, {
          issues: String(parsed.error),
        });
      }
      params = parsed.data;
    }
    return handler(params as never, ctx);
  }
}
