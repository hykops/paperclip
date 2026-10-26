import { describe, expect, it } from "vitest";
import { buildStackConfig, normalizeHostname, parseBoolean } from "./stack-config.ts";

const raw = (overrides: Partial<Parameters<typeof buildStackConfig>[0]> = {}) => ({
  hostname: "paperclip.example.com",
  zone: "",
  r2Assets: "",
  r2Bucket: "",
  ...overrides,
});

describe("normalizeHostname", () => {
  it("accepts a bare hostname and lowercases it", () => {
    expect(normalizeHostname(" Paperclip.Example.com ")).toBe("paperclip.example.com");
  });
  it("strips a scheme and path", () => {
    expect(normalizeHostname("https://paperclip.example.com/board")).toBe("paperclip.example.com");
  });
  it("rejects a single label and invalid characters", () => {
    expect(() => normalizeHostname("localhost")).toThrow(/bare hostname/);
    expect(() => normalizeHostname("paper_clip.example.com")).toThrow(/bare hostname/);
  });
});

describe("parseBoolean", () => {
  it("accepts common spellings", () => {
    expect(parseBoolean("", "X")).toBe(false);
    expect(parseBoolean("true", "X")).toBe(true);
    expect(parseBoolean("1", "X")).toBe(true);
    expect(parseBoolean("no", "X")).toBe(false);
  });
  it("rejects anything else", () => {
    expect(() => parseBoolean("maybe", "X")).toThrow(/X must be true or false/);
  });
});

describe("buildStackConfig", () => {
  it("applies defaults", () => {
    expect(buildStackConfig(raw())).toEqual({
      hostname: "paperclip.example.com",
      zone: undefined,
      r2Assets: false,
      r2Bucket: undefined,
    });
  });
  it("requires a hostname", () => {
    expect(() => buildStackConfig(raw({ hostname: "" }))).toThrow(/PAPERCLIP_HOSTNAME/);
  });
  it("reads the zone and the R2 switch", () => {
    expect(buildStackConfig(raw({ zone: " Example.COM ", r2Assets: "true" }))).toEqual({
      hostname: "paperclip.example.com",
      zone: "example.com",
      r2Assets: true,
      r2Bucket: undefined,
    });
    expect(() => buildStackConfig(raw({ r2Assets: "maybe" }))).toThrow(/PAPERCLIP_R2_ASSETS/);
  });
  it("reads the bucket name, which turns R2 on by itself", () => {
    expect(buildStackConfig(raw({ r2Bucket: " paperclip " }))).toEqual({
      hostname: "paperclip.example.com",
      zone: undefined,
      r2Assets: true,
      r2Bucket: "paperclip",
    });
    expect(buildStackConfig(raw({ r2Assets: "true", r2Bucket: "paperclip" })).r2Bucket).toBe(
      "paperclip",
    );
  });
  it("rejects invalid or contradictory bucket settings", () => {
    expect(() => buildStackConfig(raw({ r2Bucket: "Paperclip_Assets" }))).toThrow(
      /PAPERCLIP_R2_BUCKET/,
    );
    expect(() => buildStackConfig(raw({ r2Bucket: "ab" }))).toThrow(/PAPERCLIP_R2_BUCKET/);
    expect(() => buildStackConfig(raw({ r2Assets: "false", r2Bucket: "paperclip" }))).toThrow(
      /PAPERCLIP_R2_ASSETS is false/,
    );
  });
});
