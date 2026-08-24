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

    test("registers cameras, snapshots and live smart events without a wired Protect node", async () => {
        let ProtectConfigNode;
        const RED = {
            auth: { needsPermission: () => (req, res, next) => next() },
            httpAdmin: { get: jest.fn() },
            nodes: {
                createNode(node) {
                    const emitter = new EventEmitter();
                    node.id = "protect-config-1";
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

        configNode.apiRequest = jest.fn(async (request) => ({
            statusCode: 200,
            headers: { "content-type": "image/jpeg" },
            payload: Buffer.from([1, 2, 3]),
            request
        }));
        const snapshot = await provider.takeSnapshot({ cameraId: cameras[0].cameraId, highQuality: true });
        expect(snapshot.data).toEqual(Buffer.from([1, 2, 3]));
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
                raw: { ...cameras[0].raw, state: "DISCONNECTED" }
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

        const events = [];
        const unsubscribe = provider.subscribe((event) => events.push(event));
        const bridgeClient = configNode.nodeClients.find((client) => String(client.id).startsWith("knx-ai-camera-adapter:"));
        expect(bridgeClient).toBeDefined();
        bridgeClient.handleProtectEventUpdate({
            type: "add",
            item: {
                id: "event-1",
                modelKey: "event",
                type: "smartDetectLine",
                device: "camera-1",
                start: Date.now(),
                end: null,
                smartDetectLineIds: ["line-1"],
                smartDetectTypes: ["person"]
            }
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

        unsubscribe();
        configNode.emit("close", jest.fn());
        expect(registry.providers.has(provider.id)).toBe(false);
    });
});
