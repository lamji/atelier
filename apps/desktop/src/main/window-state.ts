import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow, Rectangle } from "electron";
import { screen } from "electron";

interface WindowState {
  bounds?: Rectangle;
  maximized?: boolean;
}

/** Mirrors atelierDataRoot() in @atelier/shared/node — same data dir. */
function dataRoot(): string {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier");
}

function stateFile(): string {
  return path.join(dataRoot(), "desktop-window.json");
}

export function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const state = JSON.parse(raw) as WindowState;
    if (state.bounds && !isOnScreen(state.bounds)) delete state.bounds;
    return state;
  } catch {
    return {};
  }
}

function isOnScreen(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const area = d.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;

  const save = (): void => {
    if (win.isDestroyed()) return;
    const state: WindowState = {
      maximized: win.isMaximized(),
      bounds: win.isMaximized() ? win.getNormalBounds() : win.getBounds(),
    };
    try {
      fs.mkdirSync(dataRoot(), { recursive: true });
      fs.writeFileSync(stateFile(), JSON.stringify(state));
    } catch {
      // best-effort persistence
    }
  };

  const debounced = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };

  win.on("resize", debounced);
  win.on("move", debounced);
  win.on("maximize", debounced);
  win.on("unmaximize", debounced);
  win.on("close", save);
}
