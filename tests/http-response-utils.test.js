"use strict";

const { maybeParseBody } = require("../nodes/utils/http-response-utils");

function buf(str) {
    return Buffer.from(str, "utf8");
}

describe("maybeParseBody", () => {
    test("returns empty string for empty buffer", () => {
        expect(maybeParseBody("application/json", Buffer.alloc(0))).toBe("");
    });

    test("parses JSON for application/json", () => {
        const result = maybeParseBody("application/json", buf('{"ok":true}'));
        expect(result).toEqual({ ok: true });
    });

    test("parses JSON for vendor+json type", () => {
        const result = maybeParseBody("application/problem+json", buf('{"status":404}'));
        expect(result).toEqual({ status: 404 });
    });

    test("returns raw string when JSON parse fails for application/json", () => {
        const result = maybeParseBody("application/json", buf("not-json"));
        expect(result).toBe("not-json");
    });

    test("returns text string for text/plain", () => {
        const result = maybeParseBody("text/plain", buf("hello world"));
        expect(result).toBe("hello world");
    });

    test("probes JSON shape for text/plain with JSON content", () => {
        const result = maybeParseBody("text/plain", buf('{"auto":true}'));
        expect(result).toEqual({ auto: true });
    });

    test("probes JSON array shape for text/plain", () => {
        const result = maybeParseBody("text/plain", buf("[1,2,3]"));
        expect(result).toEqual([1, 2, 3]);
    });

    test("returns Buffer for binary content type", () => {
        const result = maybeParseBody("image/jpeg", buf("binarydata"));
        expect(Buffer.isBuffer(result)).toBe(true);
    });

    test("returns Buffer for application/octet-stream", () => {
        const result = maybeParseBody("application/octet-stream", buf("data"));
        expect(Buffer.isBuffer(result)).toBe(true);
    });

    test("handles content-type with charset parameter", () => {
        const result = maybeParseBody("application/json; charset=utf-8", buf('{"x":1}'));
        expect(result).toEqual({ x: 1 });
    });

    test("handles uppercase content-type", () => {
        const result = maybeParseBody("Application/JSON", buf('{"y":2}'));
        expect(result).toEqual({ y: 2 });
    });

    test("handles content-type as array (first element used)", () => {
        const result = maybeParseBody(["application/json", "text/html"], buf('{"z":3}'));
        expect(result).toEqual({ z: 3 });
    });

    test("probes JSON for unknown/empty content-type", () => {
        const result = maybeParseBody("", buf('{"probe":true}'));
        expect(result).toEqual({ probe: true });
    });

    test("returns raw string for unknown non-JSON content", () => {
        const result = maybeParseBody("", buf("plain text"));
        expect(result).toBe("plain text");
    });

    test("parses application/xml as text", () => {
        const result = maybeParseBody("application/xml", buf("<root/>"));
        expect(result).toBe("<root/>");
    });
});
