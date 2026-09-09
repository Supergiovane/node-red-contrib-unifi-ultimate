"use strict";

const { EventEmitter } = require("events");

const {
    KNX_AI_CAMERA_REGISTRY_KEY,
    collectDetectedObjectTypes,
    collectEventScopeIds,
    collectNamedScopes,
    getKnxAiCameraRegistry,
    normalizeProtectCameraEvent
} = require("../nodes/utils/knx-ai-camera-registry");

describe("KNX AI camera adapter registry", () => {
    afterEach(() => {
        delete globalThis[KNX_AI_CAMERA_REGISTRY_KEY];
    });

    test("publishes generic adapters and providers through one runtime registry", () => {
        const registry = getKnxAiCameraRegistry();
        const changes = [];
        const unsubscribe = registry.subscribe((change) => changes.push(change.type));
        const provider = { id: "unifi-ultimate:controller-1", adapterId: "unifi-ultimate" };

        registry.registerAdapter({ id: "unifi-ultimate", title: "UniFi Ultimate / Protect" });
        registry.registerProvider(provider);

        expect(registry.adapters.get("unifi-ultimate").title).toBe("UniFi Ultimate / Protect");
        expect(registry.providers.get(provider.id)).toBe(provider);
        expect(changes).toEqual(["adapter_registered", "provider_registered"]);

        registry.unregisterProvider(provider.id);
        unsubscribe();
        expect(changes).toEqual(["adapter_registered", "provider_registered", "provider_unregistered"]);
    });

    test("discovers named smart-detection lines and zones from a Protect camera", () => {
        const camera = {
            smartDetectSettings: {
                lines: [{ id: "line-1", name: "Vialetto" }],
                zones: [{ id: "zone-1", name: "Porta ingresso" }]
            }
        };

        expect(collectNamedScopes(camera, "line")).toEqual([{ id: "line-1", name: "Vialetto" }]);
        expect(collectNamedScopes(camera, "zone")).toEqual([{ id: "zone-1", name: "Porta ingresso" }]);
    });

    test("normalizes an active Protect line event for any KNX AI consumer", () => {
        const camera = {
            id: "camera-1",
            name: "Ingresso principale",
            state: "CONNECTED",
            smartDetectSettings: {
                lines: [{ id: "line-1", name: "Vialetto" }]
            }
        };
        const rawEvent = {
            id: "event-1",
            modelKey: "event",
            type: "smartDetectLine",
            device: "camera-1",
            start: Date.UTC(2026, 7, 24, 12, 0, 0),
            end: null,
            smartDetectLineIds: ["line-1"],
            smartDetectTypes: ["person"]
        };
        const event = normalizeProtectCameraEvent({
            event: rawEvent,
            camera,
            controllerId: "controller-1",
            controllerName: "Casa"
        });

        expect(collectEventScopeIds(rawEvent, "line")).toEqual(["line-1"]);
        expect(collectDetectedObjectTypes(rawEvent)).toEqual(["person"]);
        expect(event).toMatchObject({
            source: "unifi-ultimate",
            controllerId: "controller-1",
            controllerName: "Casa",
            cameraId: "controller-1:camera-1",
            nativeCameraId: "camera-1",
            cameraName: "Ingresso principale",
            eventId: "event-1",
            eventType: "smartDetectLine",
            active: true,
            scopeId: "line-1",
            scopeName: "Vialetto",
            objectTypes: ["person"]
        });
    });

    test("marks a completed Protect event inactive and ignores unsupported events", () => {
        const completed = normalizeProtectCameraEvent({
            event: {
                modelKey: "event",
                type: "motion",
                device: "camera-1",
                start: 1000,
                end: 2000
            },
            camera: { name: "Garage" },
            controllerId: "controller-1"
        });
        expect(completed.active).toBe(false);
        expect(normalizeProtectCameraEvent({
            event: { modelKey: "event", type: "recording", device: "camera-1" },
            controllerId: "controller-1"
        })).toBeNull();
    });
});

describe("UniFi Protect KNX AI provider", () => {
    afterEach(() => {
        delete globalThis[KNX_AI_CAMERA_REGISTRY_KEY];
    });

    test("filters unsupported event bursts and coalesces cold camera catalog refreshes", async () => {
        let ProtectConfigNode;
        const RED = {
            auth: { needsPermission: () => (req, res, next) => next() },
            httpAdmin: { get: jest.fn() },
            nodes: {
                createNode(node) {
                    const emitter = new EventEmitter();
                    node.id = "protect-burst-test";
                    node.credentials = { apiKey: "secret" };
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.warn = jest.fn();
                },
                registerType(type, constructor) {
                    if (type === "unifi-protect-config") ProtectConfigNode = constructor;
                }
            }
        };
        require("../nodes/unifi-protect-config")(RED);
        const configNode = new ProtectConfigNode({
            name: "Casa",
            host: "192.168.1.10",
            port: "443",
            rejectUnauthorized: false
        });
        configNode.ensureWebSockets = jest.fn();
        const provider = getKnxAiCameraRegistry().providers.get("unifi-ultimate:protect-burst-test");
        const received = [];
        const unsubscribe = provider.subscribe((event) => received.push(event));
        const bridgeClient = configNode.nodeClients.find((client) => String(client.id).startsWith("knx-ai-camera-adapter:"));

        let releaseColdRefresh;
        configNode.fetchDevices = jest.fn(() => new Promise((resolve) => {
            releaseColdRefresh = resolve;
        }));
        for (let index = 0; index < 100; index += 1) {
            bridgeClient.handleProtectEventUpdate({
                item: {
                    id: `unsupported-${index}`,
                    modelKey: "event",
                    type: "recording",
                    device: "camera-1",
                    start: Date.now()
                }
            });
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(configNode.fetchDevices).not.toHaveBeenCalled();

        for (let index = 0; index < 100; index += 1) {
            bridgeClient.handleProtectEventUpdate({
                item: {
                    id: `motion-${index}`,
                    modelKey: "event",
                    type: "motion",
                    device: "camera-1",
                    start: Date.now()
                }
            });
        }
        await new Promise((resolve) => setImmediate(resolve));
        expect(configNode.fetchDevices).toHaveBeenCalledTimes(1);
        releaseColdRefresh([{
            id: "camera-1",
            modelKey: "camera",
            name: "Ingresso",
            state: "CONNECTED"
        }]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(received).toHaveLength(100);

        let releaseStaleRefresh;
        configNode.fetchDevices.mockClear();
        configNode.fetchDevices.mockImplementationOnce(() => new Promise((resolve) => {
            releaseStaleRefresh = resolve;
        }));
        bridgeClient.handleProtectDeviceUpdate({ item: { modelKey: "camera", id: "camera-1" } });
        bridgeClient.handleProtectEventUpdate({
            item: {
                id: "motion-with-stale-catalog",
                modelKey: "event",
                type: "motion",
                device: "camera-1",
                start: Date.now()
            }
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(configNode.fetchDevices).toHaveBeenCalledTimes(1);
        expect(received.at(-1)).toMatchObject({
            eventId: "motion-with-stale-catalog",
            cameraName: "Ingresso"
        });
        releaseStaleRefresh([{
            id: "camera-1",
            modelKey: "camera",
            name: "Ingresso aggiornato",
            state: "CONNECTED"
        }]);
        await new Promise((resolve) => setImmediate(resolve));
        expect(configNode.knxAiCameraCache.cameras[0].cameraName).toBe("Ingresso aggiornato");

        unsubscribe();
        configNode.emit("close", jest.fn());
    });

    test("registers cameras, snapshots and live smart events without a wired Protect node", async () => {
        let ProtectConfigNode;
        const RED = {
            auth: { needsPermission: () => (req, res, next) => next() },
            httpAdmin: { get: jest.fn() },
            nodes: {
                createNode(node) {
                    const emitter = new EventEmitter();
                    node.id = "protect-config-1";
                    node.credentials = {
                        apiKey: "secret",
                        historyUsername: "cerebrum-history",
                        historyPassword: "history-secret"
                    };
                    node.on = emitter.on.bind(emitter);
                    node.emit = emitter.emit.bind(emitter);
                    node.warn = jest.fn();
                },
                registerType(type, constructor) {
                    if (type === "unifi-protect-config") ProtectConfigNode = constructor;
                }
            }
        };
        require("../nodes/unifi-protect-config")(RED);
        const registry = getKnxAiCameraRegistry();
        expect(registry.adapters.has("unifi-ultimate")).toBe(true);

        const configNode = new ProtectConfigNode({
            name: "Casa",
            host: "192.168.1.10",
            port: "443",
            rejectUnauthorized: false
        });
        const provider = registry.providers.get("unifi-ultimate:protect-config-1");
        expect(provider).toBeDefined();
        expect(provider.eventRetention).toBe("none");
        expect(provider.capabilities).toEqual(expect.arrayContaining(["event_history", "event_snapshot"]));
        expect(provider.queryEvents).toEqual(expect.any(Function));
        expect(provider.takeEventSnapshot).toEqual(expect.any(Function));

        configNode.fetchDevices = jest.fn(async () => [{
            id: "camera-1",
            modelKey: "camera",
            name: "Ingresso principale",
            state: "CONNECTED",
            smartDetectSettings: {
                lines: [{ id: "line-1", name: "Vialetto" }],
                objectTypes: ["person", "animal", "vehicle"]
            },
            featureFlags: { supportFullHdSnapshot: true }
        }]);
        const cameras = await provider.listCameras({ force: true });
        expect(cameras[0]).toMatchObject({
            cameraId: "protect-config-1:camera-1",
            cameraName: "Ingresso principale",
            controllerId: "protect-config-1",
            adapterId: "unifi-ultimate",
            state: "CONNECTED",
            online: true,
            objectTypes: ["person", "animal", "vehicle"],
            lines: [{ id: "line-1", name: "Vialetto" }]
        });
        expect(cameras[0]).not.toHaveProperty("raw");
        expect(configNode.knxAiCameraCache.cameras[0]).toHaveProperty("raw");

        configNode.apiRequest = jest.fn(async (request) => ({
            statusCode: 200,
            headers: { "content-type": "image/jpeg" },
            payload: Buffer.from([1, 2, 3]),
            request
        }));
        const snapshot = await provider.takeSnapshot({ cameraId: cameras[0].cameraId, highQuality: true });
        expect(snapshot.data).toEqual(Buffer.from([1, 2, 3]));
        expect(snapshot.camera).not.toHaveProperty("raw");
        expect(configNode.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
            path: "/v1/cameras/camera-1/snapshot",
            query: { highQuality: "true" }
        }));

        configNode.apiRequest.mockClear();
        const standardSnapshot = await provider.takeSnapshot({ cameraId: cameras[0].cameraId });
        expect(standardSnapshot.data).toEqual(Buffer.from([1, 2, 3]));
        expect(configNode.apiRequest).toHaveBeenCalledWith(expect.objectContaining({
            path: "/v1/cameras/camera-1/snapshot",
            query: {}
        }));

        configNode.apiRequest
            .mockReset()
            .mockResolvedValueOnce({ statusCode: 503, headers: {}, payload: { message: "Unavailable" } })
            .mockResolvedValueOnce({
                statusCode: 200,
                headers: { "content-type": "image/jpeg" },
                payload: Buffer.from([4, 5, 6])
            });
        const fallbackSnapshot = await provider.takeSnapshot({ cameraId: cameras[0].cameraId, highQuality: true });
        expect(fallbackSnapshot.data).toEqual(Buffer.from([4, 5, 6]));
        expect(configNode.apiRequest).toHaveBeenCalledTimes(2);
        expect(configNode.apiRequest.mock.calls[0][0].query).toEqual({ highQuality: "true" });
        expect(configNode.apiRequest.mock.calls[1][0].query).toEqual({});

        configNode.apiRequest
            .mockReset()
            .mockResolvedValue({ statusCode: 503, headers: {}, payload: { message: "Unavailable" } });
        await expect(provider.takeSnapshot({ cameraId: cameras[0].cameraId }))
            .rejects.toThrow("failed (HTTP 503: Unavailable) after one standard-quality retry");
        expect(configNode.apiRequest).toHaveBeenCalledTimes(2);

        configNode.knxAiCameraCache = {
            at: Date.now(),
            cameras: [{
                ...cameras[0],
                state: "DISCONNECTED",
                online: false,
                raw: { ...configNode.knxAiCameraCache.cameras[0].raw, state: "DISCONNECTED" }
            }]
        };
        configNode.apiRequest
            .mockReset()
            .mockResolvedValue({
                statusCode: 503,
                headers: { "content-type": "application/json; charset=utf-8" },
                payload: { detail: "Device 'camera' is unavailable: offline" }
            });
        const offlineSnapshot = provider.takeSnapshot({ cameraId: cameras[0].cameraId });
        await expect(offlineSnapshot).rejects.toMatchObject({
            code: "UNIFI_PROTECT_CAMERA_OFFLINE",
            statusCode: 503,
            cameraState: "DISCONNECTED"
        });
        await expect(provider.takeSnapshot({ cameraId: cameras[0].cameraId }))
            .rejects.toThrow("camera is offline (HTTP 503; state: DISCONNECTED)");
        expect(configNode.apiRequest).toHaveBeenCalledTimes(2);

        configNode.executeProtectHistoryRequest = jest.fn(async () => ({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            payload: [{
                id: "event-history-1",
                modelKey: "event",
                type: "motion",
                device: "camera-1",
                start: Date.now() - 5000,
                end: Date.now() - 2000,
                thumbnail: "e-event-history-1"
            }, {
                id: "malformed-event",
                modelKey: "event",
                type: "motion",
                device: "camera-1",
                start: "not-a-timestamp",
                thumbnail: "e-malformed-event"
            }]
        }));
        const history = await provider.queryEvents({
            cameraId: cameras[0].cameraId,
            eventType: "motion",
            limit: 1
        });
        expect(history.events).toHaveLength(1);
        expect(history.events[0]).toMatchObject({
            eventId: "event-history-1",
            cameraId: "protect-config-1:camera-1",
            cameraName: "Ingresso principale",
            eventType: "motion",
            thumbnailAvailable: true
        });
        expect(history.events[0]).not.toHaveProperty("raw");
        expect(configNode.executeProtectHistoryRequest).toHaveBeenCalledWith(expect.objectContaining({
            path: "events",
            query: expect.objectContaining({ orderDirection: "DESC", limit: 100 })
        }));

        const repeatedHistoryPage = Array.from({ length: 100 }, (_, index) => ({
            id: `repeated-history-${index}`,
            modelKey: "event",
            type: "motion",
            device: "camera-1",
            start: Date.now() - index * 1000,
            end: Date.now() - index * 1000 + 500,
            thumbnail: `e-repeated-history-${index}`
        }));
        configNode.executeProtectHistoryRequest = jest.fn(async () => ({
            statusCode: 200,
            headers: { "content-type": "application/json" },
            payload: repeatedHistoryPage
        }));
        const historyRequest = {
            eventType: "motion",
            from: "2026-09-09T06:00:00.000Z",
            to: "2026-09-09T12:00:00.000Z",
            limit: 20
        };
        const firstHistoryPage = await provider.queryEvents(historyRequest);
        const duplicateHistoryPage = await provider.queryEvents({ ...historyRequest, offset: 100 });
        expect(firstHistoryPage).toMatchObject({ hasMore: true, nextOffset: 100, duplicatePage: false });
        expect(duplicateHistoryPage).toMatchObject({
            events: [],
            hasMore: false,
            nextOffset: null,
            duplicatePage: true,
            continuationStoppedReason: "duplicate_page"
        });

        configNode.executeProtectHistoryRequest = jest.fn(async () => ({
            statusCode: 200,
            headers: { "content-type": "image/jpeg" },
            payload: Buffer.from([7, 8, 9])
        }));
        const eventSnapshot = await provider.takeEventSnapshot({ eventId: "event-history-1" });
        expect(eventSnapshot).toMatchObject({
            data: Buffer.from([7, 8, 9]),
            mediaType: "image/jpeg",
            eventId: "event-history-1"
        });
        expect(configNode.executeProtectHistoryRequest).toHaveBeenCalledWith(expect.objectContaining({
            path: "events/event-history-1/thumbnail",
            headers: { Accept: "image/jpeg" }
        }));

        const events = [];
        const unsubscribe = provider.subscribe((event) => events.push(event));
        const bridgeClient = configNode.nodeClients.find((client) => String(client.id).startsWith("knx-ai-camera-adapter:"));
        expect(bridgeClient).toBeDefined();
        const liveEventStart = Date.now();
        const liveEvent = {
            id: "event-1",
            modelKey: "event",
            type: "smartDetectLine",
            device: "camera-1",
            start: liveEventStart,
            end: null,
            smartDetectLineIds: ["line-1"],
            smartDetectTypes: ["person"]
        };
        bridgeClient.handleProtectEventUpdate({
            type: "add",
            item: { ...liveEvent }
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(events[0]).toMatchObject({
            cameraId: "protect-config-1:camera-1",
            eventType: "smartDetectLine",
            scopeId: "line-1",
            scopeName: "Vialetto",
            objectTypes: ["person"],
            active: true
        });
        expect(events[0]).not.toHaveProperty("raw");

        bridgeClient.handleProtectEventUpdate({ type: "update", item: { ...liveEvent } });
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toHaveLength(1);

        bridgeClient.handleProtectEventUpdate({
            type: "update",
            item: { ...liveEvent, end: liveEventStart + 1000 }
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toHaveLength(2);
        expect(events[1]).toMatchObject({ eventId: "event-1", active: false });

        const enrichedFinishedEvent = {
            ...liveEvent,
            end: liveEventStart + 1000,
            smartDetectLineIds: ["line-1", "line-2"],
            smartDetectTypes: ["person", "vehicle"]
        };
        bridgeClient.handleProtectEventUpdate({ type: "update", item: enrichedFinishedEvent });
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toHaveLength(3);
        expect(events[2]).toMatchObject({
            active: false,
            scopeIds: ["line-1", "line-2"],
            objectTypes: ["person", "vehicle"]
        });

        bridgeClient.handleProtectEventUpdate({ type: "update", item: { ...enrichedFinishedEvent } });
        await new Promise((resolve) => setImmediate(resolve));
        expect(events).toHaveLength(3);

        const normalDeviceClient = { id: "normal-protect-node", handleProtectEventUpdate: jest.fn() };
        configNode.nodeClients.push(normalDeviceClient);
        const broadcastEvent = {
            type: "add",
            item: { ...liveEvent, id: "event-broadcast", start: liveEventStart + 2000 }
        };
        configNode.broadcastEventUpdate(broadcastEvent);
        configNode.broadcastEventUpdate(broadcastEvent);
        await new Promise((resolve) => setImmediate(resolve));
        expect(normalDeviceClient.handleProtectEventUpdate).toHaveBeenCalledTimes(2);
        expect(events.filter((event) => event.eventId === "event-broadcast")).toHaveLength(1);

        unsubscribe();
        configNode.emit("close", jest.fn());
        expect(registry.providers.has(provider.id)).toBe(false);
    });
});
