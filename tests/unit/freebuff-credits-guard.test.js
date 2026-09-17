/**
 * Unit tests for the Freebuff credits guard (spec P5).
 */
import { describe, it, expect } from "vitest";
import { isFreeModel, preCheckCredits } from "../../open-sse/services/freebuffModels.js";

const FREEBUCKS = { balance: 20, prices: { "openai/gpt-5.6-luna": 10 } };

describe("isFreeModel", () => {
  it("returns true when model not in prices map", () => {
    expect(isFreeModel("z-ai/glm-5.3-flash", FREEBUCKS)).toBe(true);
  });
  it("returns false when model in prices map", () => {
    expect(isFreeModel("openai/gpt-5.6-luna", FREEBUCKS)).toBe(false);
  });
  it("returns true when freebucks is null", () => {
    expect(isFreeModel("z-ai/glm-5.3-flash", null)).toBe(true);
  });
});

describe("preCheckCredits", () => {
  it("passes for free model (no price)", () => {
    expect(preCheckCredits("z-ai/glm-5.3-flash", FREEBUCKS)).toBe(true);
  });
  it("passes when balance >= price", () => {
    expect(preCheckCredits("openai/gpt-5.6-luna", FREEBUCKS)).toBe(true);
  });
  it("fails when balance < price", () => {
    expect(preCheckCredits("openai/gpt-5.6-luna", { balance: 5, prices: { "openai/gpt-5.6-luna": 10 } })).toBe(false);
  });
});
