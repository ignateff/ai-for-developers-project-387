import { expect, it } from "vitest";
import {
  credentialVariable,
  defaultOpenCodeModel,
  openCodeModelFromEnvironment,
  openCodeProviderCredentials,
  resolveOpenCodeModel,
} from "./opencode-model.ts";

it("uses one shared default when the repository variable is unset or empty", () => {
  expect(defaultOpenCodeModel).toBe("opencode-go/deepseek-v4.1-flash");
  for (const value of [undefined, "", "   "])
    expect(resolveOpenCodeModel(value)).toBe(defaultOpenCodeModel);
});

it("accepts a configured provider/model and trims surrounding whitespace", () => {
  expect(resolveOpenCodeModel(" deepseek/deepseek-flash ")).toBe("deepseek/deepseek-flash");
  expect(resolveOpenCodeModel("opencode-go/deepseek-v4.1-flash")).toBe(
    "opencode-go/deepseek-v4.1-flash",
  );
});

it.each([
  "deepseek/deepseek-flash; touch /tmp/owned",
  "deepseek/deepseek-flash$(id)",
  "deepseek/deepseek-flash\nOPENCODE_MODEL=attacker/model",
  "DeepSeek/deepseek-flash",
  "deepseek",
  "deepseek/",
  "/deepseek-flash",
  "deepseek/../model",
  "deepseek/deepseek/flash",
  "a".repeat(101) + "/model",
])("rejects an unsafe model value without echoing it", (value) => {
  let message = "";
  try {
    resolveOpenCodeModel(value);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toMatch(/^OpenCode model configuration is invalid/);
  if (value.trim()) expect(message).not.toContain(value.trim());
});

it("maps only supported providers to their credentials", () => {
  expect(credentialVariable(defaultOpenCodeModel)).toBe("OPENCODE_API_KEY");
  expect(credentialVariable("deepseek/deepseek-flash")).toBe("DEEPSEEK_API_KEY");
  expect(openCodeProviderCredentials).toEqual(["OPENCODE_API_KEY", "DEEPSEEK_API_KEY"]);
  expect(() => credentialVariable("unknown/model")).toThrow(
    /OpenCode model provider is unsupported/,
  );
});

it("requires the credential that belongs to the configured provider", () => {
  expect(
    openCodeModelFromEnvironment({
      OPENCODE_MODEL: "deepseek/deepseek-flash",
      DEEPSEEK_API_KEY: "fixture-deepseek",
      OPENCODE_API_KEY: "fixture-opencode-go",
    }),
  ).toEqual({
    model: "deepseek/deepseek-flash",
    credential: "DEEPSEEK_API_KEY",
    apiKey: "fixture-deepseek",
  });
  expect(() =>
    openCodeModelFromEnvironment({
      OPENCODE_MODEL: "deepseek/deepseek-flash",
      OPENCODE_API_KEY: "fixture-opencode-go",
    }),
  ).toThrow(/DEEPSEEK_API_KEY is required/);
  expect(() => openCodeModelFromEnvironment({})).toThrow(/OPENCODE_API_KEY is required/);
});
