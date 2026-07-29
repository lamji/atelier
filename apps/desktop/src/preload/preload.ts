import { contextBridge } from "electron";

// Minimal surface for now; the full typed IPC contract
// (pickFolder, openExternal, window controls) lands next.
contextBridge.exposeInMainWorld("atelierDesktop", {
  platform: process.platform,
  version: process.env.npm_package_version ?? "0.1.0",
});
