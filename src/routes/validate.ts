/**
 * Validation helper: run a zod schema and throw a BadRequestError listing the
 * field issues on failure.
 */
import type { ZodSchema } from "zod";
import { BadRequestError } from "../utils/errors.ts";

export function validate<T>(schema: ZodSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    throw new BadRequestError("Validation failed", issues);
  }
  return result.data;
}
