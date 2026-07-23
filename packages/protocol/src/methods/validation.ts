import { z } from "zod";
import { ValidationResult } from "../models/validation.js";

export const validationMethods = {
  "tests.run": {
    params: z.object({ paths: z.array(z.string()).optional() }).optional(),
    result: z.object({ result: ValidationResult }),
  },
  "lint.run": {
    params: z.object({ paths: z.array(z.string()).optional() }).optional(),
    result: z.object({ result: ValidationResult }),
  },
  "typecheck.run": {
    params: z.object({}).optional(),
    result: z.object({ result: ValidationResult }),
  },
} as const;
