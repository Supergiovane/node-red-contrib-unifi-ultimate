"use strict";

const {
    parseBoolean,
    parseIntervalSeconds,
    normalizePort,
    applyPortToHost,
    buildStatusTimestampText,
    appendStatusTimestamp,
    resolveNodeName,
    resolveDeviceName,
    extractDeviceNameFromPayload,
    attachDeviceNameToPayload,
    attachDetails,
    buildErrorOutputMessage
} = require("../nodes/utils/common-utils");

describe("parseBoolean", () => {
    test("returns true for boolean true", () => expect(parseBoolean(true)).toBe(true));
    test("returns true for string 'true'", () => expect(parseBoolean("true")).toBe(true));
    test("returns true for number 1", () => expect(parseBoolean(1)).toBe(true));
    test("returns true for string '1'", () => expect(parseBoolean("1")).toBe(true));
    test("returns false for boolean false", () => expect(parseBoolean(false)).toBe(false));
    test("returns false for string 'false'", () => expect(parseBoolean("false")).toBe(false));
    test("returns false for null", () => expect(parseBoolean(null)).toBe(false));
    test("returns false for undefined", () => expect(parseBoolean(undefined)).toBe(false));
    test("returns false for number 0", () => expect(parseBoolean(0)).toBe(false));
    test("returns false for empty string", () => expect(parseBoolean("")).toBe(false));
});

describe("parseIntervalSeconds", () => {
    test("returns truncated numeric value when >= 5", () => expect(parseIntervalSeconds(10, 60)).toBe(10));
    test("truncates decimal", () => expect(parseIntervalSeconds(7.9, 60)).toBe(7));
    test("returns fallback when value < 5", () => expect(parseIntervalSeconds(3, 60)).toBe(60));
    test("returns fallback when value is 0", () => expect(parseIntervalSeconds(0, 30)).toBe(30));
    test("returns fallback for non-numeric string", () => expect(parseIntervalSeconds("abc", 60)).toBe(60));
    test("returns fallback for null", () => expect(parseIntervalSeconds(null, 60)).toBe(60));
    test("returns fallback for undefined", () => expect(parseIntervalSeconds(undefined, 60)).toBe(60));
    test("accepts string numeric >= 5", () => expect(parseIntervalSeconds("20", 60)).toBe(20));
    test("returns fallback for Infinity", () => expect(parseIntervalSeconds(Infinity, 60)).toBe(60));
    test("returns fallback for NaN", () => expect(parseIntervalSeconds(NaN, 60)).toBe(60));
});

describe("normalizePort", () => {
    test("returns numeric string for valid port", () => expect(normalizePort(11443)).toBe("11443"));
    test("accepts string numeric port", () => expect(normalizePort("443")).toBe("443"));
    test("trims surrounding whitespace", () => expect(normalizePort("  8443  ")).toBe("8443"));
    test("accepts lowest valid port", () => expect(normalizePort(1)).toBe("1"));
    test("accepts highest valid port", () => expect(normalizePort(65535)).toBe("65535"));
    test("returns empty for 0", () => expect(normalizePort(0)).toBe(""));
    test("returns empty for out-of-range port", () => expect(normalizePort(70000)).toBe(""));
    test("returns empty for negative", () => expect(normalizePort(-1)).toBe(""));
    test("returns empty for non-numeric string", () => expect(normalizePort("abc")).toBe(""));
    test("returns empty for decimal", () => expect(normalizePort("443.5")).toBe(""));
    test("returns empty for empty string", () => expect(normalizePort("")).toBe(""));
    test("returns empty for null", () => expect(normalizePort(null)).toBe(""));
    test("returns empty for undefined", () => expect(normalizePort(undefined)).toBe(""));
});

describe("applyPortToHost", () => {
    test("appends port when host has none", () => expect(applyPortToHost("192.168.1.10", 11443)).toBe("192.168.1.10:11443"));
    test("appends port to hostname", () => expect(applyPortToHost("controller.local", "8443")).toBe("controller.local:8443"));
    test("keeps existing host:port over port field", () => expect(applyPortToHost("192.168.1.10:443", 11443)).toBe("192.168.1.10:443"));
    test("returns host unchanged when port is empty", () => expect(applyPortToHost("192.168.1.10", "")).toBe("192.168.1.10"));
    test("returns host unchanged when port is invalid", () => expect(applyPortToHost("192.168.1.10", "abc")).toBe("192.168.1.10"));
    test("appends port to IPv6 literal without port", () => expect(applyPortToHost("[::1]", 11443)).toBe("[::1]:11443"));
    test("keeps IPv6 literal with explicit port", () => expect(applyPortToHost("[::1]:443", 11443)).toBe("[::1]:443"));
    test("trims host whitespace", () => expect(applyPortToHost("  host  ", 443)).toBe("host:443"));
    test("returns empty for empty host", () => expect(applyPortToHost("", 443)).toBe(""));
    test("returns empty for null host", () => expect(applyPortToHost(null, 443)).toBe(""));
});

describe("buildStatusTimestampText", () => {
    test("returns a string with day and time format", () => {
        const result = buildStatusTimestampText();
        expect(typeof result).toBe("string");
        expect(result).toMatch(/^\(day \d+, \d{2}:\d{2}:\d{2}\)$/);
    });
});

describe("appendStatusTimestamp", () => {
    test("appends timestamp to non-empty text", () => {
        const result = appendStatusTimestamp("connected");
        expect(result).toMatch(/^connected \(day \d+, \d{2}:\d{2}:\d{2}\)$/);
    });
    test("returns only timestamp when text is empty", () => {
        const result = appendStatusTimestamp("");
        expect(result).toMatch(/^\(day \d+, \d{2}:\d{2}:\d{2}\)$/);
    });
    test("handles null text", () => {
        const result = appendStatusTimestamp(null);
        expect(result).toMatch(/^\(day \d+, \d{2}:\d{2}:\d{2}\)$/);
    });
    test("handles undefined text", () => {
        const result = appendStatusTimestamp(undefined);
        expect(result).toMatch(/^\(day \d+, \d{2}:\d{2}:\d{2}\)$/);
    });
    test("trims whitespace before appending", () => {
        const result = appendStatusTimestamp("  ok  ");
        expect(result).toMatch(/^ok \(day/);
    });
});

describe("resolveNodeName", () => {
    test("trims string", () => expect(resolveNodeName("  my node  ")).toBe("my node"));
    test("returns empty string for null", () => expect(resolveNodeName(null)).toBe(""));
    test("returns empty string for undefined", () => expect(resolveNodeName(undefined)).toBe(""));
    test("returns string as-is when no whitespace", () => expect(resolveNodeName("node")).toBe("node"));
});

describe("resolveDeviceName", () => {
    test("trims string", () => expect(resolveDeviceName("  camera 1  ")).toBe("camera 1"));
    test("returns empty string for null", () => expect(resolveDeviceName(null)).toBe(""));
    test("returns empty string for undefined", () => expect(resolveDeviceName(undefined)).toBe(""));
});

describe("extractDeviceNameFromPayload", () => {
    test("returns name field when present", () => {
        expect(extractDeviceNameFromPayload({ name: "Camera" })).toBe("Camera");
    });
    test("falls back to displayName", () => {
        expect(extractDeviceNameFromPayload({ displayName: "My Camera" })).toBe("My Camera");
    });
    test("falls back to hostname", () => {
        expect(extractDeviceNameFromPayload({ hostname: "switch-01" })).toBe("switch-01");
    });
    test("falls back to alias", () => {
        expect(extractDeviceNameFromPayload({ alias: "front-door" })).toBe("front-door");
    });
    test("falls back to id", () => {
        expect(extractDeviceNameFromPayload({ id: "abc123" })).toBe("abc123");
    });
    test("returns empty string for null payload", () => {
        expect(extractDeviceNameFromPayload(null)).toBe("");
    });
    test("returns empty string for array payload", () => {
        expect(extractDeviceNameFromPayload([])).toBe("");
    });
    test("returns empty string for non-object", () => {
        expect(extractDeviceNameFromPayload("string")).toBe("");
    });
    test("prefers name over other fields", () => {
        expect(extractDeviceNameFromPayload({ name: "A", displayName: "B", id: "C" })).toBe("A");
    });
});

describe("attachDeviceNameToPayload", () => {
    test("adds deviceName to object payload", () => {
        const result = attachDeviceNameToPayload({ foo: "bar" }, "Camera");
        expect(result).toEqual({ foo: "bar", deviceName: "Camera" });
    });
    test("returns payload unchanged when deviceName is empty", () => {
        const payload = { foo: "bar" };
        expect(attachDeviceNameToPayload(payload, "")).toBe(payload);
    });
    test("returns payload unchanged when deviceName is null", () => {
        const payload = { foo: "bar" };
        expect(attachDeviceNameToPayload(payload, null)).toBe(payload);
    });
    test("returns non-object payload unchanged", () => {
        expect(attachDeviceNameToPayload("text", "Camera")).toBe("text");
    });
    test("returns array payload unchanged", () => {
        const arr = [1, 2, 3];
        expect(attachDeviceNameToPayload(arr, "Camera")).toBe(arr);
    });
    test("does not mutate original payload", () => {
        const original = { foo: "bar" };
        const result = attachDeviceNameToPayload(original, "Camera");
        expect(original).not.toHaveProperty("deviceName");
        expect(result).toHaveProperty("deviceName", "Camera");
    });
});

describe("attachDetails", () => {
    test("merges details into outputMsg.details", () => {
        const msg = {};
        attachDetails(msg, { source: "test" });
        expect(msg.details).toEqual({ source: "test" });
    });
    test("deep-merges with existing details", () => {
        const msg = { details: { existing: true } };
        attachDetails(msg, { source: "test" });
        expect(msg.details).toEqual({ existing: true, source: "test" });
    });
    test("does nothing when details is null", () => {
        const msg = {};
        attachDetails(msg, null);
        expect(msg.details).toBeUndefined();
    });
    test("does nothing when outputMsg is null", () => {
        expect(() => attachDetails(null, { source: "test" })).not.toThrow();
    });
    test("does nothing when details is an array", () => {
        const msg = {};
        attachDetails(msg, [1, 2, 3]);
        expect(msg.details).toBeUndefined();
    });
    test("overwrites conflicting detail keys", () => {
        const msg = { details: { source: "old" } };
        attachDetails(msg, { source: "new" });
        expect(msg.details.source).toBe("new");
    });
});

describe("buildErrorOutputMessage", () => {
    test("includes error message from Error object", () => {
        const result = buildErrorOutputMessage(new Error("something failed"), "my-node");
        expect(result.error.message).toBe("something failed");
    });
    test("payload is null", () => {
        const result = buildErrorOutputMessage(new Error("fail"), "node");
        expect(result.payload).toBeNull();
    });
    test("topic matches nodeName", () => {
        const result = buildErrorOutputMessage(new Error("fail"), "camera-node");
        expect(result.topic).toBe("camera-node");
    });
    test("topic is undefined when nodeName is empty", () => {
        const result = buildErrorOutputMessage(new Error("fail"), "");
        expect(result.topic).toBeUndefined();
    });
    test("handles string error", () => {
        const result = buildErrorOutputMessage("raw error string", "node");
        expect(result.error.message).toBe("raw error string");
    });
    test("handles null error gracefully", () => {
        const result = buildErrorOutputMessage(null, "node");
        expect(typeof result.error.message).toBe("string");
    });
});
