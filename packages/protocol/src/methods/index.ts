import type { z } from "zod";
import { sessionMethods } from "./session.js";

export { SlashCommand, McpServerInfo } from "./session.js";
export { ImageAttachment } from "./task.js";
import { taskMethods } from "./task.js";
import { fsMethods } from "./fs.js";
import { terminalMethods } from "./terminal.js";
import { cliMethods } from "./cli.js";
import { gitMethods } from "./git.js";
import { validationMethods } from "./validation.js";
import { knowledgeMethods } from "./knowledge.js";
import { hooksMethods } from "./hooks.js";
import { settingsMethods } from "./settings.js";
import { usageMethods } from "./usage.js";
import { modelsMethods } from "./models.js";
import { projectsMethods } from "./projects.js";
import { contextMethods } from "./context.js";
import { providersMethods } from "./providers.js";
import { previewMethods } from "./preview.js";

export const methods = {
  ...sessionMethods,
  ...taskMethods,
  ...fsMethods,
  ...terminalMethods,
  ...cliMethods,
  ...gitMethods,
  ...validationMethods,
  ...knowledgeMethods,
  ...hooksMethods,
  ...settingsMethods,
  ...usageMethods,
  ...modelsMethods,
  ...projectsMethods,
  ...contextMethods,
  ...providersMethods,
  ...previewMethods,
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;

export type MethodParams<M extends MethodName> =
  Methods[M]["params"] extends z.ZodTypeAny
    ? z.infer<Methods[M]["params"]>
    : never;

export type MethodResult<M extends MethodName> =
  Methods[M]["result"] extends z.ZodTypeAny
    ? z.infer<Methods[M]["result"]>
    : never;

export {
  sessionMethods,
  taskMethods,
  fsMethods,
  terminalMethods,
  cliMethods,
  gitMethods,
  validationMethods,
  knowledgeMethods,
  hooksMethods,
  settingsMethods,
  usageMethods,
  modelsMethods,
  projectsMethods,
  contextMethods,
  providersMethods,
  previewMethods,
};
export {
  ProjectInfo,
  ProjectStatus,
  ProjectEndpoint,
} from "./projects.js";
export { PreviewConsoleCapture, PreviewConsoleEntry } from "./preview.js";
export {
  PreviewTestStep,
  PreviewTestCase,
  PreviewTestStepResult,
  PreviewTestReport,
} from "./preview.js";
