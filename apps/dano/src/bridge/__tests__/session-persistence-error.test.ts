import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SessionPersistenceError,
  commandErrorMessage,
  wrapSessionPersistenceError,
} from "../session-persistence-error.js";
import { DANO_SESSION_PERSISTENCE_ERROR } from "../types.js";

describe("session persistence errors", () => {
  it("wraps a structured filesystem failure for the current session", () => {
    const sessionPath = path.resolve("/private/runtime/session.jsonl");
    const cause = Object.assign(new Error("write failed"), {
      code: "ENOSPC",
      path: sessionPath,
    });

    const error = wrapSessionPersistenceError(
      new Error("prompt failed", { cause }),
      sessionPath,
    );

    expect(error).toBeInstanceOf(SessionPersistenceError);
    expect(commandErrorMessage(error)).toBe(DANO_SESSION_PERSISTENCE_ERROR);
  });

  it.each(["ENOENT", "ENOTDIR", "EISDIR"])(
    "wraps a %s failure for the current session path",
    code => {
      const sessionPath = path.resolve("/private/runtime/session.jsonl");
      const error = Object.assign(new Error("session path failed"), {
        code,
        path: sessionPath,
      });

      expect(
        wrapSessionPersistenceError(error, sessionPath),
      ).toBeInstanceOf(SessionPersistenceError);
    },
  );

  it("wraps a descriptor write failure without a path", () => {
    const error = Object.assign(new Error("write failed"), {
      code: "ENOSPC",
      syscall: "write",
    });

    expect(
      wrapSessionPersistenceError(error, "/private/runtime/session.jsonl"),
    ).toBeInstanceOf(SessionPersistenceError);
  });

  it.each([undefined, "open", "read"])(
    "does not relabel a pathless failure with syscall %s",
    syscall => {
      const error = Object.assign(new Error("operation failed"), {
        code: "ENOENT",
        ...(syscall ? { syscall } : {}),
      });

      expect(
        wrapSessionPersistenceError(error, "/private/runtime/session.jsonl"),
      ).toBe(error);
    },
  );

  it("does not relabel a filesystem failure for another path", () => {
    const error = Object.assign(new Error("write failed"), {
      code: "ENOSPC",
      path: "/private/runtime/unrelated.jsonl",
    });

    expect(
      wrapSessionPersistenceError(error, "/private/runtime/session.jsonl"),
    ).toBe(error);
    expect(commandErrorMessage(error)).toBe("write failed");
  });

  it("does not infer persistence failures from error text", () => {
    const error = new Error(
      "EPERM: operation not permitted, open '/private/runtime/session.jsonl'",
    );

    expect(
      wrapSessionPersistenceError(error, "/private/runtime/session.jsonl"),
    ).toBe(error);
  });

  it("stops when a cause chain is cyclic", () => {
    const error = new Error("prompt failed") as Error & { cause: unknown };
    error.cause = error;

    expect(
      wrapSessionPersistenceError(error, "/private/runtime/session.jsonl"),
    ).toBe(error);
  });
});
