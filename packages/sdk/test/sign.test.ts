import { describe, expect, it } from "vitest";
import { signValue, verifyValue } from "../src";

const secret = "a-test-secret-of-32-characters-or-more";

describe("signValue", () => {
  it("gives a signature that verifyValue accepts for the same value", async () => {
    const signature = await signValue(secret, "confirm:asha@example.com");

    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await verifyValue(secret, "confirm:asha@example.com", signature)).toBe(true);
  });

  it("refuses another value, another secret, and a bad signature", async () => {
    const signature = await signValue(secret, "confirm:asha@example.com");

    expect(await verifyValue(secret, "leave:asha@example.com", signature)).toBe(false);
    expect(await verifyValue(`${secret}x`, "confirm:asha@example.com", signature)).toBe(false);
    expect(await verifyValue(secret, "confirm:asha@example.com", "not base64!")).toBe(false);
  });
});
