"use strict";

const { EventEmitter } = require("events");
const registerProtectNode = require("../nodes/unifi-protect-device");
const { readAlarmState, buildRequestError } = require("../nodes/utils/unifi-protect-alarm");

function createNode(config = {}, response = { statusCode: 200, payload: {} }) {
    let Constructor;
    const server = {
        addClient: jest.fn(), removeClient: jest.fn(),
        fetchDeviceByTypeAndId: jest.fn(async () => ({ id: "hub-1", modelKey: "linkstation", name: "Hub", alarmHub: { armed: "on", battery: { voltage: 12 } } })),
        executeProtectRequest: jest.fn(async () => response),
        credentials: { apiKey: "secret-key", localPassword: "secret-password" },
        getApiKey: () => "secret-key"
    };
    registerProtectNode({ nodes: {
        createNode(node) {
            const emitter = new EventEmitter();
            node.on = emitter.on.bind(emitter);
            node.emit = emitter.emit.bind(emitter);
            for (const method of ["send", "status", "error", "warn"]) node[method] = jest.fn();
        },
        getNode: () => server,
        registerType(_type, ctor) { Constructor = ctor; }
    } });
    const node = new Constructor({ server: "server", deviceType: "alarmHub", deviceId: "hub-1", capability: "getAlarmState", ...config });
    return { node, server };
}

async function input(node) {
    const send = jest.fn();
    const error = await new Promise((resolve) => node.emit("input", {}, send, resolve));
    return { send, error };
}

describe("Protect alarm sources", () => {
    test.each([["on", true], ["off", false], [true, true], [false, false]])("normalizes hub state %s", (armed, expected) => {
        expect(readAlarmState("alarmHub", { alarmHub: { armed } })).toBe(expected);
    });
    test.each([null, undefined, "unknown", 0, ""])("does not treat unsupported state %s as disarmed", (armed) => {
        expect(readAlarmState("alarmHub", { alarmHub: { armed } })).toBeUndefined();
    });
    test.each(["arming", "armed", "breach", "disabled", "future-status"])("preserves NVR status %s", (status) => {
        expect(readAlarmState("nvr", { armMode: { status }, alarmHub: { armed: "off" } })).toBe(status);
    });
    test("polls the hub and preserves false and full device metadata", async () => {
        const { node, server } = createNode({}, { statusCode: 200, payload: { id: "hub-1", alarmHub: { armed: "off" } } });
        const { send, error } = await input(node);
        expect(error).toBeUndefined();
        expect(server.executeProtectRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", path: "/v1/alarm-hubs/hub-1" }));
        expect(send.mock.calls[0][0]).toMatchObject({ payload: false, details: { device: { alarmHub: { armed: "off" } } } });
    });
    test("missing state emits an error rather than a successful disarmed reading", async () => {
        const { node } = createNode();
        const { send, error } = await input(node);
        expect(error.message).toContain("missing state does not mean disarmed");
        expect(send).not.toHaveBeenCalled();
        expect(node.send.mock.calls[0][0][1].error.message).toContain("no supported alarm state");
    });
    test("NVR polling uses the NVR endpoint and keeps transitional state", async () => {
        const { node, server } = createNode({ deviceType: "nvr", deviceId: "nvr-1" }, { statusCode: 200, payload: { armMode: { status: "arming" } } });
        const { send, error } = await input(node);
        expect(error).toBeUndefined();
        expect(server.executeProtectRequest).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", path: "/v1/nvrs" }));
        expect(send.mock.calls[0][0].payload).toBe("arming");
    });
    test("NVR live state follows explicit status patches without replaying profile changes", async () => {
        const { node } = createNode({ deviceType: "nvr", deviceId: "nvr-1", capability: "observe", capabilityConfig: '{"observable":"armStatus"}' });
        await Promise.resolve();
        node.send.mockClear();
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "nvr-1", modelKey: "nvr", armMode: { status: "armed" } } });
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "nvr-1", armMode: { armProfileId: "home" } } });
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0].payload).toBe("armed");
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "nvr-1", armMode: { status: "disabled" } } });
        expect(node.send.mock.calls[1][0].payload).toBe("disabled");
    });
    test("accepts Link Station and partial state updates without replaying unrelated patches", async () => {
        const { node } = createNode({ capability: "observe", capabilityConfig: '{"observable":"armed"}' });
        await Promise.resolve();
        node.send.mockClear();
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "hub-1", modelKey: "linkstation", alarmHub: { armed: "off" } } });
        expect(node.send.mock.calls[0][0]).toMatchObject({ payload: false, details: { device: { name: "Hub", alarmHub: { battery: { voltage: 12 } } } } });
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "hub-1", alarmHub: { battery: { voltage: 11 } } } });
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "hub-2", alarmHub: { armed: "on" } } });
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "hub-1", modelKey: "camera", alarmHub: { armed: "on" } } });
        expect(node.send).toHaveBeenCalledTimes(1);
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "hub-1", alarmHub: { armed: "on" } } });
        expect(node.send.mock.calls[1][0].payload).toBe(true);
        node.handleProtectDeviceUpdate({ type: "remove", item: { id: "hub-1" } });
        expect(node.currentDevice).toBeNull();
        expect(node.currentObservableValue).toBeUndefined();
    });
    test("reports HTTP diagnostics on the error output and does not retry another control endpoint", async () => {
        const { node, server } = createNode({ deviceType: "nvr", capability: "enableArmAlarm" }, { statusCode: 400, payload: { message: "Local manager required" } });
        const { error } = await input(node);
        expect(error.message).toContain("local Alarm Manager");
        expect(server.executeProtectRequest).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0][1]).toMatchObject({ details: { response: { statusCode: 400, method: "POST", path: "/v1/arm-profiles/enable", apiMessage: "Local manager required" } } });
    });
    test.each([[401, "validity"], [403, "permissions"]])("distinguishes HTTP %s", (statusCode, hint) => {
        expect(buildRequestError({ statusCode }, "POST", "/v1/arm-profiles/enable").message).toContain(hint);
    });
    test("redacts configured credentials and bounds API diagnostics", () => {
        const error = buildRequestError({ statusCode: 400, payload: { message: `secret-key secret-password Bearer abc token=def ${"x".repeat(1000)}` } }, "POST", "/v1/arm-profiles/enable", ["secret-key", "secret-password"]);
        expect(error.protectResponse.apiMessage).not.toMatch(/secret-key|secret-password|abc|def/);
        expect(error.protectResponse.apiMessage.length).toBeLessThanOrEqual(500);
    });
});
