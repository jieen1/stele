import { describe, expect, it } from "vitest";
import {
  REGISTERED_BACKENDS,
  listRegisteredBackends,
  loadBackend,
  type RegisteredBackend,
} from "../src/backend-registry.js";

describe("backend-registry", () => {
  describe("REGISTERED_BACKENDS", () => {
    it("includes the python pytest entry", () => {
      const entry = REGISTERED_BACKENDS.find(
        (registered: RegisteredBackend) => registered.language === "python" && registered.framework === "pytest",
      );
      expect(entry).toBeDefined();
      expect(entry?.packageName).toBe("@stele/backend-python");
      expect(entry?.displayName).toBe("Python (pytest)");
    });

    it("is frozen", () => {
      expect(Object.isFrozen(REGISTERED_BACKENDS)).toBe(true);
    });
  });

  describe("listRegisteredBackends", () => {
    it("returns the registered backends snapshot", () => {
      const list = listRegisteredBackends();
      expect(list).toBe(REGISTERED_BACKENDS);
      expect(Object.isFrozen(list)).toBe(true);
    });
  });

  describe("loadBackend", () => {
    it("returns the python backend for python/pytest", async () => {
      const backend = await loadBackend("python", "pytest");
      expect(backend.name).toBe("python");
      expect(backend.framework).toBe("pytest");
      expect(backend.fileExtension).toBe(".py");
      expect(typeof backend.generate).toBe("function");
    });

    it("returns the python backend when framework is undefined", async () => {
      const backend = await loadBackend("python", undefined);
      expect(backend.name).toBe("python");
    });

    it("throws E_UNSUPPORTED_BACKEND for an unknown language", async () => {
      const error = await loadBackend("ruby", "rspec").catch((thrown: Error) => thrown);
      expect(error).toBeInstanceOf(Error);
      expect((error as { code?: string }).code).toBe("E_UNSUPPORTED_BACKEND");
      expect((error as { category?: string }).category).toBe("BackendError");
    });

    it("includes the supported display name in the unsupported error message", async () => {
      const error = await loadBackend("ruby", "rspec").catch((thrown: Error) => thrown);
      expect((error as Error).message).toContain("Python (pytest)");
    });

    it("rejects with E_UNSUPPORTED_BACKEND when the framework does not match", async () => {
      const error = await loadBackend("python", "unittest").catch((thrown: Error) => thrown);
      expect((error as { code?: string }).code).toBe("E_UNSUPPORTED_BACKEND");
    });
  });
});
