import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { ImageAttachment } from "@atelier/protocol";

/** Where a conversation's attachments live under the agent's data dir. */
const ATTACHMENT_DIR = "attachments";

/** Newest-first cap: an old screenshot is not what a follow-up refers to. */
const KEEP_PER_CONVERSATION = 8;

/** Extensions we can round-trip back into a media type. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const MEDIA_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([media, ext]) => [ext, media])
);

/**
 * Gives a conversation's attached images a lasting address.
 *
 * Images used to ride on `task.start` and nowhere else: the bytes reached
 * the provider on that one turn and were then gone. The next turn rebuilt
 * its history from `chat_messages`, which stores text only — so "what's on
 * the image?" was answered by a model that could no longer see it, from
 * whatever its own earlier answer had said.
 *
 * So the bytes go to disk and the PATH is what travels: into the task's
 * session memory, and into the next turn's context. A later turn that
 * needs to look calls `view_image` on the path; a turn that doesn't costs
 * nothing but the path itself. Re-attaching the bytes to every following
 * turn would have worked too, and would have meant paying for a full
 * screenshot on turns that never mention it.
 *
 * Every method is best effort — an attachment is an aid to the turn, never
 * a reason to fail it.
 */
export class AttachmentStore {
  constructor(
    private dataDir: string,
    private log: Logger
  ) {}

  /** Root of the store; nothing outside it may be read back. */
  private get root(): string {
    return path.join(this.dataDir, ATTACHMENT_DIR);
  }

  private dirFor(conversationId: string): string {
    return path.join(this.root, safe(conversationId));
  }

  /**
   * Persists this turn's images and returns their paths, in the order they
   * were attached. Named by task so `recentPaths()` can return one turn's
   * set whole rather than a mix of two.
   */
  save(
    conversationId: string,
    taskId: string,
    images: ImageAttachment[] | undefined
  ): string[] {
    if (!images || images.length === 0) return [];
    const dir = this.dirFor(conversationId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const saved = images.map((image, index) => {
        const ext = EXTENSIONS[image.mediaType] ?? "png";
        const file = `${Date.now()}-${safe(taskId)}-${index}.${ext}`;
        const abs = path.join(dir, file);
        fs.writeFileSync(abs, Buffer.from(image.data, "base64"));
        return abs;
      });
      this.prune(dir);
      return saved;
    } catch (error) {
      this.log.warn(
        { err: error, conversationId },
        "could not persist this turn's attachments"
      );
      return [];
    }
  }

  /**
   * Paths of the most recent turn's images. One turn's set — not every
   * image the conversation ever held — because a follow-up refers to what
   * was just shown.
   */
  recentPaths(conversationId: string): string[] {
    const dir = this.dirFor(conversationId);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return []; // nothing was ever attached here
    }
    if (files.length === 0) return [];
    const newest = [...files].sort().reverse();
    // Same task id => same turn. Everything older is a previous exchange.
    const taskOf = (file: string) => file.split("-").slice(1, -1).join("-");
    const turn = taskOf(newest[0] ?? "");
    return newest
      .filter((file) => taskOf(file) === turn)
      .sort()
      .map((file) => path.join(dir, file));
  }

  /**
   * Reads one stored image back for `view_image`. Confined to the store's
   * own directory: the path reaches this from model-authored tool input,
   * and an arbitrary path would turn a viewer into a file exfiltrator.
   */
  load(absPath: string): ImageAttachment | null {
    const resolved = path.resolve(absPath);
    const root = path.resolve(this.root);
    const inside =
      resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep);
    if (!inside) {
      this.log.warn({ absPath }, "refused to view a file outside the store");
      return null;
    }
    try {
      const ext = path.extname(resolved).slice(1).toLowerCase();
      return {
        mediaType: MEDIA_TYPES[ext] ?? "image/png",
        data: fs.readFileSync(resolved).toString("base64"),
      };
    } catch (error) {
      this.log.warn({ err: error, absPath }, "could not read a stored image");
      return null;
    }
  }

  /** Screenshots are large; a conversation keeps only its recent ones. */
  private prune(dir: string): void {
    const files = fs.readdirSync(dir).sort().reverse();
    for (const file of files.slice(KEEP_PER_CONVERSATION)) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch {
        // already gone, or held open — the next save tries again
      }
    }
  }
}

/** Ids are generated, but they end up as path segments — keep them inert. */
function safe(id: string): string {
  return id.replace(/[^\w.-]/g, "_");
}
