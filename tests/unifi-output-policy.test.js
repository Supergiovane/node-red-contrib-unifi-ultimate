"use strict";

const { EventEmitter } = require("events");
const registerProtect = require("../nodes/unifi-protect-device");
const registerAccess = require("../nodes/unifi-access-device");
const registerNetwork = require("../nodes/unifi-network-device");
const { sendWithPayload } = require("../nodes/utils/common-utils");

function createDevice(register, config, initial) {
    let Constructor;
    const server = {
        addClient: jest.fn(), removeClient: jest.fn(),
        fetchDeviceByTypeAndId: jest.fn(async () => initial)
    };
    register({ nodes: {
        createNode(node) {
            const emitter = new EventEmitter();
            node.on = emitter.on.bind(emitter);
            node.emit = emitter.emit.bind(emitter);
            for (const method of ["send", "status", "warn", "error"]) node[method] = jest.fn();
        },
        getNode: () => server,
        registerType: (_name, ctor) => { Constructor = ctor; }
    } });
    return new Constructor({ server: "server", deviceId: "device-1",
        capability: "observe", ...config });
}

function createProtect(config = {}, initial = { id: "device-1", modelKey: "fob" }) {
    return createDevice(registerProtect, { deviceType: "fob",
        capabilityConfig: '{"observable":"left"}', ...config }, initial);
}

function press(node, button) {
    node.handleProtectEventUpdate({ type: "add", item: {
        modelKey: "event", device: "device-1", type: "sensorButtonPressed",
        metadata: button === undefined ? {} : { button: { text: button } }
    } });
}

async function refresh(node, send) {
    await new Promise((resolve, reject) => node.emit("input", {}, send,
        (error) => error ? reject(error) : resolve()));
}

describe("missing UniFi readings", () => {
    test.each([undefined, null, "undefined", " UNDEFINED "])("blocks missing payload %p by default", (payload) => {
        const send = jest.fn();
        sendWithPayload(send, { payload });
        sendWithPayload(send, {});
        expect(send).not.toHaveBeenCalled();
        sendWithPayload(send, { payload }, true);
        expect(send).toHaveBeenCalledWith({ payload });
    });

    test("retains false, zero and output pin positions", () => {
        const send = jest.fn();
        sendWithPayload(send, [{ payload: undefined }, [{ payload: false }, { payload: 0 }]]);
        expect(send).toHaveBeenCalledWith([null, [{ payload: false }, { payload: 0 }]]);
    });

    test("keyfob is silent at startup and does not replay a press on refresh or device update", async () => {
        const node = createProtect();
        await Promise.resolve();
        expect(node.send).not.toHaveBeenCalled();
        press(node, undefined);
        press(node, "right");
        expect(node.send).not.toHaveBeenCalled();
        press(node, "left");
        expect(node.send.mock.calls[0][0].payload).toBe(true);
        node.send.mockClear();
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "device-1", modelKey: "fob" } });
        const send = jest.fn();
        await refresh(node, send);
        expect(node.send).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        node.emit("close");
    });

    test("explicit opt-in emits undefined at startup and on manual refresh", async () => {
        const node = createProtect({ emitStartupAndUndefined: true });
        await Promise.resolve();
        expect(node.send).toHaveBeenCalledTimes(1);
        expect(node.send.mock.calls[0][0]).toHaveProperty("payload", undefined);
        const send = jest.fn();
        await refresh(node, send);
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ payload: undefined }));
        node.emit("close");
    });

    test.each([false, true])("startup with a known state is opt-in (%p)", async (enabled) => {
        const node = createProtect({ deviceType: "sensor", capabilityConfig: '{"observable":"contact"}',
            emitStartupAndUndefined: enabled }, { id: "device-1", modelKey: "sensor", isOpened: false });
        await Promise.resolve();
        expect(node.send).toHaveBeenCalledTimes(enabled ? 1 : 0);
        node.send.mockClear();
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "device-1", modelKey: "sensor", isOpened: false } });
        expect(node.send.mock.calls[0][0].payload).toBe(false);
        node.send.mockClear();
        node.handleProtectDeviceUpdate({ type: "update", item: { id: "device-1", modelKey: "sensor" } });
        expect(node.send).toHaveBeenCalledTimes(enabled ? 1 : 0);
        if (enabled) expect(node.send.mock.calls[0][0]).toHaveProperty("payload", undefined);
        node.emit("close");
    });
});


describe.each([
    ["Access", registerAccess, { deviceType: "door", capability: "observe" }],
    ["Network", registerNetwork, { deviceType: "device", capability: "observeUnofficialEvents" }]
])("%s output policy", (_name, register, config) => {
    test.each([undefined, false, true, "true"])("startup requires explicit opt-in (%p)", async (enabled) => {
        const initial = { id: "device-1", name: "Test device" };
        const node = createDevice(register, { ...config, emitStartupAndUndefined: enabled }, initial);
        await Promise.resolve();
        try {
            expect(node.currentDevice).toEqual(initial);
            const optedIn = enabled === true || enabled === "true";
            expect(node.send).toHaveBeenCalledTimes(optedIn ? 1 : 0);
            if (optedIn) expect(node.send.mock.calls[0][0].payload.id).toBe("device-1");
            const send = jest.fn();
            await refresh(node, send);
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0][0].payload.id).toBe("device-1");
        } finally {
            node.emit("close");
        }
    });

    test.each([undefined, null, "undefined"])("missing reading %p is silent unless enabled", async (payload) => {
        for (const enabled of [false, true]) {
            const node = createDevice(register, { ...config, emitStartupAndUndefined: enabled }, payload);
            await Promise.resolve();
            try {
                expect(node.send).toHaveBeenCalledTimes(enabled ? 1 : 0);
                const send = jest.fn();
                await refresh(node, send);
                expect(send).toHaveBeenCalledTimes(enabled ? 1 : 0);
                if (enabled) expect(send.mock.calls[0][0]).toHaveProperty("payload", payload);
            } finally {
                node.emit("close");
            }
        }
    });

    test.each([false, 0])("manual refresh retains the valid reading %p", async (payload) => {
        const node = createDevice(register, config, payload);
        await Promise.resolve();
        try {
            expect(node.send).not.toHaveBeenCalled();
            const send = jest.fn();
            await refresh(node, send);
            expect(send).toHaveBeenCalledTimes(1);
            expect(send.mock.calls[0][0]).toHaveProperty("payload", payload);
        } finally {
            node.emit("close");
        }
    });
});
