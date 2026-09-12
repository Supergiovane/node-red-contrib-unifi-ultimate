"use strict";

jest.mock("../nodes/utils/unifi-protect-utils", () => ({ ...jest.requireActual("../nodes/utils/unifi-protect-utils"), doRequest: jest.fn() }));
const { doRequest } = require("../nodes/utils/unifi-protect-utils");
const { runConnectionCheck, registerConnectionCheck } = require("../nodes/utils/unifi-connection-check");
const config = { host: "controller.test", rejectUnauthorized: true };
const good = { statusCode: 200, payload: [] };
const login = { statusCode: 200, headers: { "set-cookie": ["TOKEN=secret-session; Secure"], "x-csrf-token": "secret-csrf" }, payload: {} };

describe("guided connection check", () => {
    afterEach(() => jest.resetAllMocks());
    test.each(["protect", "network", "access"])("checks %s without changing devices or leaking credentials", async (product) => {
        const request = jest.fn(async () => good);
        const result = await runConnectionCheck(product, config, { apiKey: "secret-key", apiToken: "secret-token" }, request);
        expect(result.ok).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request.mock.calls[0][1].method).toBe("GET");
        expect(request.mock.calls[0][1].rejectUnauthorized).toBe(true);
        expect(JSON.stringify(result)).not.toContain("secret-");
        expect(request.mock.calls[0][0].port).toBe(product === "access" ? "12445" : "");
    });

    test("Protect local login checks history using only session headers", async () => {
        const request = jest.fn().mockResolvedValueOnce(good).mockResolvedValueOnce(login).mockResolvedValueOnce(good);
        const result = await runConnectionCheck("protect", config, { apiKey: "secret-key", localUsername: "local", localPassword: "secret-password" }, request);
        expect(result.ok).toBe(true);
        expect(JSON.parse(request.mock.calls[1][2])).toEqual({ username: "local", password: "secret-password", rememberMe: false });
        expect(request.mock.calls[2][0].pathname).toBe("/proxy/protect/api/events");
        expect(request.mock.calls[2][1].headers).not.toHaveProperty("X-API-Key");
        expect(JSON.stringify(result)).not.toContain("secret-");
    });

    test.each([[401, "rejected"], [403, "permissions"], [404, "endpoint"], [429, "rate limiting"]])("explains HTTP %i and discards remote diagnostics", async (statusCode, word) => {
        const request = jest.fn(async () => ({ statusCode, payload: { error: "private-controller-details" } }));
        const result = await runConnectionCheck("network", config, { apiKey: "key" }, request);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).toContain(word);
        expect(JSON.stringify(result)).not.toContain("private-controller-details");
    });

    test("missing fields, partial locals, unknown API formats and TLS failures are explained", async () => {
        const missing = await runConnectionCheck("protect", config, { localUsername: "only-user" }, jest.fn());
        expect(missing.checks.filter((item) => item.status === "error")).toHaveLength(2);
        const badFormat = await runConnectionCheck("protect", config, { apiKey: "key" }, async () => ({ statusCode: 200, payload: "Login page" }));
        expect(badFormat.ok).toBe(false);
        const tls = await runConnectionCheck("protect", config, { apiKey: "key" }, async () => { throw Object.assign(new Error("secret-url"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }); });
        expect(JSON.stringify(tls)).toContain("Certificate");
        expect(JSON.stringify(tls)).not.toContain("secret-url");
    });

    test("Access never submits the optional local account", async () => {
        const request = jest.fn(async () => good);
        const result = await runConnectionCheck("access", config, { apiToken: "token", localUsername: "user", localPassword: "private" }, request);
        expect(request).toHaveBeenCalledTimes(1);
        expect(result.checks.find((item) => item.id === "local").message).toContain("not used or tested");
    });
});

describe("admin diagnostics credentials", () => {
    afterEach(() => jest.resetAllMocks());
    function route(saved) {
        let handler;
        const permission = jest.fn(() => jest.fn());
        registerConnectionCheck({ httpAdmin: { post: (_url, _auth, fn) => { handler = fn; } }, auth: { needsPermission: permission }, nodes: { getNode: () => saved } }, "protect");
        const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        return { handler, response, permission };
    }
    const saved = { ...config, type: "unifi-protect-config", credentials: { apiKey: "saved-key", localUsername: "user", localPassword: "saved-password" } };

    test("reuses masked credentials only on the same saved controller", async () => {
        const { handler, response, permission } = route(saved);
        doRequest.mockResolvedValue(good);
        await handler({ body: { ...config, serverId: "one", credentials: { apiKey: "__PWRD__" } } }, response);
        expect(permission).toHaveBeenCalledWith("unifi-protect-config.write");
        expect(doRequest.mock.calls[0][1].headers["X-API-Key"]).toBe("saved-key");
        expect(JSON.stringify(response.json.mock.calls)).not.toContain("saved-key");
    });

    test.each([{ ...saved, host: "other.test" }, null, { ...saved, type: "unifi-network-config" }])("cannot send another configuration's saved secrets", async (node) => {
        const { handler, response } = route(node);
        await handler({ body: { ...config, serverId: "one", credentials: { apiKey: "__PWRD__" } } }, response);
        expect(doRequest).not.toHaveBeenCalled();
        expect(response.status).toHaveBeenCalledWith(400);
    });

    test("explicitly cleared credentials do not fall back to saved secrets", async () => {
        const { handler, response } = route(saved);
        await handler({ body: { ...config, serverId: "one", credentials: { apiKey: "", localUsername: "", localPassword: "" } } }, response);
        expect(doRequest).not.toHaveBeenCalled();
        expect(response.json.mock.calls[0][0].ok).toBe(false);
    });
});
