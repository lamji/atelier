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
