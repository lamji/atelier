import type { ValidationResult } from "@atelier/protocol";
import { NotImplementedError } from "../not-implemented.js";

/** Phase 6: lint/test/typecheck runners via execa, parsed into findings. */
export class ValidationRunners {
  constructor(private workspaceRoot: string) {}

  async runTests(_paths?: string[]): Promise<ValidationResult> {
    throw new NotImplementedError("tests.run");
  }

  async runLint(_paths?: string[]): Promise<ValidationResult> {
    throw new NotImplementedError("lint.run");
  }

  async runTypecheck(): Promise<ValidationResult> {
    throw new NotImplementedError("typecheck.run");
  }
}
