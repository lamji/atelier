import { Settings } from "@atelier/protocol";
import type { Db } from "../db.js";

export class SettingsRepo {
  constructor(
    private db: Db,
    private defaults: Settings
  ) {}

  get(): Settings {
    const rows = this.db
      .prepare("SELECT key, value FROM settings")
      .all() as Array<{ key: string; value: string }>;
    const stored: Record<string, unknown> = {};
    for (const row of rows) stored[row.key] = JSON.parse(row.value);
    return Settings.parse({ ...this.defaults, ...stored });
  }

  /**
   * Raw key access, for values that live in this table but aren't part of
   * the Settings schema (provider credentials). Settings.parse strips
   * unknown keys, so these never leak into settings.get.
   */
  getRaw(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as string;
    } catch {
      return undefined;
    }
  }

  setRaw(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, JSON.stringify(value));
  }

  save(partial: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) stmt.run(key, JSON.stringify(value));
    }
    return this.get();
  }
}
