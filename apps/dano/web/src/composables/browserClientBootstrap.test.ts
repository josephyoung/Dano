/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserClient } from "./browserClientBootstrap";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("browser Client bootstrap", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("serializes concurrent first-client requests across the origin", async () => {
    let lockQueue = Promise.resolve<unknown>(undefined);
    const requestLock = vi.fn(
      <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
        const result = lockQueue.then(callback);
        lockQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    vi.stubGlobal("navigator", { locks: { request: requestLock } });
    const firstResponse = deferred<Response>();
    const calls: string[] = [];

    const first = createBrowserClient(async () => {
      calls.push("first");
      return firstResponse.promise;
    });
    const second = createBrowserClient(async () => {
      calls.push("second");
      return new Response(null, { status: 201 });
    });
    await vi.waitFor(() => expect(calls).toEqual(["first"]));

    firstResponse.resolve(new Response(null, { status: 201 }));
    await Promise.all([first, second]);

    expect(calls).toEqual(["first", "second"]);
    expect(requestLock).toHaveBeenCalledTimes(2);
  });

  it("creates the Client directly when Web Locks is unavailable", async () => {
    vi.stubGlobal("navigator", { locks: undefined });
    const request = vi.fn(async () => new Response(null, { status: 201 }));

    await expect(createBrowserClient(request)).resolves.toMatchObject({
      status: 201,
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
