"use strict";

const EventEmitter = require("events");
const registerAccessConfigNode = require("../nodes/unifi-access-config");
const registerAccessDeviceNode = require("../nodes/unifi-access-device");

const DEVICE_ID = "aabbccddeeff";
const START_TIME = Date.parse("2026-09-12T09:25:00Z");

function createHarness() {
    const constructors = {};
    let server;
    const RED = {
        nodes: {
            createNode(node) {
                const emitter = new EventEmitter();
                node.on = emitter.on.bind(emitter);
                node.emit = emitter.emit.bind(emitter);
                node.credentials = { apiToken: "test-token" };
                node.status = jest.fn();
                node.send = jest.fn();
                node.warn = jest.fn();
                node.error = jest.fn();
            },
            getNode: () => server,
            registerType(name, constructor) {
                constructors[name] = constructor;
            }
        },
        httpAdmin: { get: jest.fn() },
        auth: { needsPermission: () => jest.fn() }
    };
    registerAccessConfigNode(RED);
    registerAccessDeviceNode(RED);
    server = new constructors["unifi-access-config"]({ host: "controller.test" });
    server.addClient = jest.fn();
    server.fetchDeviceByTypeAndId = jest.fn(async () => ({
        id: DEVICE_ID,
        alias: "Test intercom",
        type: "UA-G3-Intercom"
    }));
    server.executeAccessRequest = jest.fn(async () => ({
        statusCode: 200,
        headers: {},
        payload: { code: "SUCCESS", data: "success", msg: "success" }
    }));
    server.apiRequest = jest.fn(async () => ({ statusCode: 200, payload: { data: { hits: [] } } }));

    const cancel = new constructors["unifi-access-device"]({
        server: "test-config",
        name: "Cancel test intercom",
        deviceType: "device",
        deviceId: DEVICE_ID,
        capability: "cancelDoorbell",
        capabilityConfig: "{}"
    });

    return { server, cancel };
}

function incoming(server, requestId = "call-1", deviceId = DEVICE_ID) {
    server.updateDoorbellState({
        event: "access.remote_view",
        data: { device_id: deviceId, request_id: requestId }
    });
}

function completed(server, requestId = "call-1") {
    server.updateDoorbellState({
        event: "access.remote_view.change",
        data: { remote_call_request_id: requestId, reason_code: 108 }
    });
}

function callLog(published, completion = false, deviceId = DEVICE_ID) {
    // Shape observed on a UA-G3-Intercom: logs are newest first and call
    // outcomes use access.door.unlock with a doorbell-specific log key.
    return {
        _id: `${deviceId}-${published}-${completion}`,
        _source: {
            event: {
                type: completion ? "access.door.unlock" : "access.remotecall.request",
                log_key: completion ? "access.doorbell.from_door.missed" : "access.doorbell.visitor.rang.remotecall",
                published
            },
            target: [{ id: deviceId, type: "UA-G3-Intercom" }]
        }
    };
}

async function invoke(cancel) {
    const send = jest.fn();
    await new Promise((resolve, reject) => {
        cancel.emit("input", {}, send, (error) => error ? reject(error) : resolve());
    });
    return send;
}

describe("UniFi Access doorbell lifecycle", () => {
    beforeEach(() => jest.useFakeTimers({ now: START_TIME }));
    afterEach(() => jest.useRealTimers());

    test("cancels a websocket-tracked call after 30 seconds even after log polling", async () => {
        const { server, cancel } = createHarness();
        incoming(server);
        jest.advanceTimersByTime(10000);
        server.processDoorbellLogEntry(callLog(START_TIME));
        jest.advanceTimersByTime(20000);

        const send = await invoke(cancel);

        expect(server.executeAccessRequest).toHaveBeenCalledWith(expect.objectContaining({
            method: "POST",
            path: `/api/v1/developer/devices/${DEVICE_ID}/doorbell`,
            payload: { cancel: true }
        }));
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ eventName: "request:cancelDoorbell" }));
        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);
    });

    test("logs preserve the request id needed by websocket completion events", () => {
        const { server } = createHarness();
        incoming(server);
        jest.advanceTimersByTime(10000);
        // Even when the log timestamp slightly follows websocket delivery,
        // it must not replace the stronger live state.
        server.processDoorbellLogEntry(callLog(START_TIME + 100));

        expect(server.getActiveDoorbell(DEVICE_ID)).toMatchObject({
            requestId: "call-1",
            source: "event",
            expiresAt: START_TIME + 180000
        });
        completed(server);
        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);
    });

    test("processes newest-first log batches in lifecycle order", async () => {
        const { server } = createHarness();
        server.apiRequest.mockResolvedValue({
            statusCode: 200,
            payload: { data: { hits: [callLog(START_TIME - 1000, true), callLog(START_TIME - 2000)] } }
        });

        await server.refreshDoorbellState();

        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);
    });

    test("a delayed completion log cannot clear a newer live call", () => {
        const { server } = createHarness();
        incoming(server, "new-call");

        server.processDoorbellLogEntry(callLog(START_TIME - 5000, true));

        expect(server.getActiveDoorbell(DEVICE_ID)).toMatchObject({ requestId: "new-call" });
    });

    test("a delayed incoming log cannot revive a completed websocket call", () => {
        const { server } = createHarness();
        incoming(server);
        jest.advanceTimersByTime(2000);
        completed(server);
        jest.advanceTimersByTime(1000);

        server.processDoorbellLogEntry(callLog(START_TIME));

        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);
    });

    test("a delayed incoming log cannot revive a call canceled by a node", () => {
        const { server } = createHarness();
        server.markDoorbellTriggered(DEVICE_ID);
        jest.advanceTimersByTime(2000);
        server.markDoorbellCanceled(DEVICE_ID);

        server.processDoorbellLogEntry(callLog(START_TIME));

        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);
    });

    test("retains the short fallback window for calls known only from logs", () => {
        const { server } = createHarness();
        server.processDoorbellLogEntry(callLog(START_TIME - 1000));
        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(true);

        jest.advanceTimersByTime(25000);
        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);

        server.processDoorbellLogEntry(callLog(Date.now()));
        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(true);
    });

    test("an older log cannot shorten a more recent log-tracked call", () => {
        const { server } = createHarness();
        server.processDoorbellLogEntry(callLog(START_TIME - 1000));
        server.processDoorbellLogEntry(callLog(START_TIME - 20000));

        jest.advanceTimersByTime(10000);

        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(true);
    });

    test("a call on another device cannot authorize cancel on the selected device", async () => {
        const { server, cancel } = createHarness();
        incoming(server, "other-call", "112233445566");

        const send = await invoke(cancel);

        expect(server.executeAccessRequest).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            eventName: "request:cancelDoorbell:skipped",
            payload: expect.objectContaining({ skipped: true })
        }));
    });

    test("stale request completions leave the current call active", () => {
        const { server } = createHarness();
        incoming(server, "old-call");
        jest.advanceTimersByTime(1000);
        incoming(server, "new-call");
        completed(server, "old-call");

        expect(server.getActiveDoorbell(DEVICE_ID)).toMatchObject({ requestId: "new-call" });
        completed(server, "new-call");
        expect(server.hasActiveDoorbell(DEVICE_ID)).toBe(false);
    });
});
