import { AppError } from "./errors.js";

/** Shared bounded-list input contract for the existing REST routes. */
export const parseOptionalLimit = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === "") return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw AppError.validation("limit must be an integer between 1 and 1000", { limit: raw });
  }
  return limit;
};
