"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilityOptions,
    getCapabilitiesForType,
    getDeviceTypeDefinition,
    resolveObservableEventValue,
    resolveObservableState
} = require("../nodes/utils/unifi-protect-device-registry");

describe("new UniFi Protect resource families", () => {
    test.each([
        ["bridge", "/v1/bridges", "/v1/bridges/:id"],
        ["linkStation", "/v1/link-stations", "/v1/link-stations/:id"],
        ["alarmHub", "/v1/alarm-hubs", "/v1/alarm-hubs/:id"],
        ["fob", "/v1/fobs", "/v1/fobs/:id"],
        ["relay", "/v1/relays", "/v1/relays/:id"],
        ["siren", "/v1/sirens", "/v1/sirens/:id"],
        ["speaker", "/v1/speakers", "/v1/speakers/:id"]
    ])("%s exposes read and event support without raw PATCH", (type, listPath, detailPath) => {
        expect(getDeviceTypeDefinition(type)).toMatchObject({
            type,
            listPath,
            detailPath,
            supportsRawUpdate: false
        });

        const capabilityIds = getCapabilitiesForType(type).map((capability) => capability.id);
        expect(capabilityIds).toContain("observe");
        expect(capabilityIds).toContain("getDetails");
        expect(capabilityIds).not.toContain("patchSettings");
    });
});

describe("new UniFi Protect actions", () => {
    test("uses the official highQuality query parameter for snapshots", () => {
        const execution = composeCapabilityExecution("camera", "getSnapshot", {
            forceHighQuality: "true"
        });
        const request = buildCapabilityRequest(
            "camera",
            "getSnapshot",
            "camera-1",
            execution.params
        );

        expect(request).toMatchObject({
            method: "GET",
            path: "/v1/cameras/camera-1/snapshot"
        });
        expect(execution.query).toEqual({ highQuality: "true" });
    });

    test("composes an explicit relay output command", () => {
        const execution = composeCapabilityExecution("relay", "activateRelayOutput", {
            outputId: "1",
            state: "on",
            pulseDuration: "1500"
        });
        const request = buildCapabilityRequest(
            "relay",
            "activateRelayOutput",
            "relay/id",
            execution.params
        );

        expect(request).toMatchObject({
            method: "POST",
            path: "/v1/relays/relay%2Fid/outputs/1/activate"
        });
        expect(execution.payload).toEqual({
            state: "on",
            pulseDuration: 1500
        });
    });

    test("does not send pulseDuration when switching a relay off", () => {
        const execution = composeCapabilityExecution("relay", "activateRelayOutput", {
            outputId: "0",
            state: "off",
            pulseDuration: "5000"
        });

        expect(execution.payload).toEqual({ state: "off" });
    });

    test("composes bounded siren and speaker test volumes", () => {
        expect(composeCapabilityExecution("siren", "playSiren", { duration: "12" }).payload)
            .toEqual({ duration: 12 });
        expect(composeCapabilityExecution("siren", "testSirenSound", { volume: "999" }).payload)
            .toEqual({ volume: 50 });
        expect(composeCapabilityExecution("speaker", "testSpeakerSound", { volume: "0" }).payload)
            .toEqual({ volume: 0 });
    });

    test.each([
        ["getArmProfiles", "GET", "/v1/arm-profiles"],
        ["enableArmAlarm", "POST", "/v1/arm-profiles/enable"],
        ["disableArmAlarm", "POST", "/v1/arm-profiles/disable"]
    ])("builds the %s Alarm Manager request", (capabilityId, method, path) => {
        expect(buildCapabilityRequest("nvr", capabilityId, "nvr-1")).toMatchObject({
            method,
            path
        });
    });

    test("selects an arm profile using the official settings payload", () => {
        const execution = composeCapabilityExecution("nvr", "setCurrentArmProfile", {
            armProfileId: "profile-away"
        });
        const request = buildCapabilityRequest(
            "nvr",
            "setCurrentArmProfile",
            "nvr-1",
            execution.params
        );

        expect(request).toMatchObject({
            method: "PATCH",
            path: "/v1/arm-profiles/settings"
        });
        expect(execution.payload).toEqual({ armProfileId: "profile-away" });
    });

    test("requires an arm profile for the select action", () => {
        expect(() => composeCapabilityExecution("nvr", "setCurrentArmProfile", {}))
            .toThrow("Select an arm profile");
    });

    test("loads arm profiles and defaults to the NVR's current profile", async () => {
        const fetchArmProfiles = jest.fn(async () => [
            { id: "profile-home", name: "Home" },
            { id: "profile-away", name: "Away" }
        ]);

        const result = await getCapabilityOptions("nvr", "setCurrentArmProfile", {
            device: { armMode: { armProfileId: "profile-away" } },
            capabilityConfig: {},
            fetchArmProfiles
        });

        expect(fetchArmProfiles).toHaveBeenCalledTimes(1);
        expect(result.fields[0]).toMatchObject({
            id: "armProfileId",
            type: "select",
            defaultValue: "profile-away",
            options: [
                { value: "profile-home", label: "Home" },
                { value: "profile-away", label: "Away" }
            ]
        });
    });

    test("preserves a configured arm profile that is temporarily unavailable", async () => {
        const result = await getCapabilityOptions("nvr", "setCurrentArmProfile", {
            device: { armMode: { armProfileId: "profile-home" } },
            capabilityConfig: { armProfileId: "profile-saved" },
            fetchArmProfiles: async () => [{ id: "profile-home", name: "Home" }]
        });

        expect(result.fields[0]).toMatchObject({
            defaultValue: "profile-saved",
            options: [
                { value: "profile-home", label: "Home" },
                {
                    value: "profile-saved",
                    label: "profile-saved (saved; currently unavailable)"
                }
            ]
        });
    });
});

describe("UniFi Protect Key Fob events", () => {
    test("lists every Key Fob button as an event option", async () => {
        const result = await getCapabilityOptions("fob", "observe", {
            capabilityConfig: {}
        });

        expect(result.fields[0]).toMatchObject({
            id: "observable",
            defaultValue: "all",
            options: [
                { value: "all", label: "All" },
                { value: "arm", label: "Arm (1)" },
                { value: "night", label: "Night (2)" },
                { value: "disarm", label: "Disarm (3)" },
                { value: "panic", label: "Panic (4)" },
                { value: "left", label: "Left" },
                { value: "right", label: "Right" }
            ]
        });
    });

    test("matches only the selected Key Fob button", () => {
        const event = {
            type: "sensorButtonPressed",
            metadata: { button: { text: "left" } }
        };

        expect(resolveObservableEventValue("fob", event, "left")).toEqual({
            matched: true,
            eventTypeMatched: true,
            value: true
        });
        expect(resolveObservableEventValue("fob", event, "right")).toEqual({
            matched: false,
            eventTypeMatched: true
        });
    });
});

describe("official UniFi Protect event capabilities", () => {
    test.each([
        ["camera", ["nfcCardScanned", "fingerprintIdentified", "digitalInput"]],
        ["sensor", ["vape", "button", "smokeBatteryLow", "smokeNeedsCleaning", "smokeFault", "coFault", "smokeEndOfLife"]],
        ["relay", ["inputChanged"]],
        ["alarmHub", ["motion", "entry", "smoke", "glassBreak", "emergencyButton", "tamper", "deviceTamper", "relaySwitched", "batteryLow", "batteryConnected"]]
    ])("lists the audited %s events", async (deviceType, expectedValues) => {
        const result = await getCapabilityOptions(deviceType, "observe", {
            capabilityConfig: {}
        });
        const values = result.fields[0].options.map((option) => option.value);

        expect(values).toEqual(expect.arrayContaining(expectedValues));
    });

    test("normalizes a relay input event to its circuit state", () => {
        const closed = {
            type: "relayInputChanged",
            metadata: { inputState: { text: "circuitClosed" }, inputChannel: { text: "0" } }
        };
        const open = {
            type: "relayInputChanged",
            metadata: { inputState: { text: "circuitOpen" }, inputChannel: { text: "0" } }
        };

        expect(resolveObservableEventValue("relay", closed, "inputChanged").value).toBe(true);
        expect(resolveObservableEventValue("relay", open, "inputChanged").value).toBe(false);
    });

    test("normalizes Alarm Hub entry open and closed events", () => {
        expect(resolveObservableEventValue("alarmHub", { type: "alarmHubEntryOpened" }, "entry").value).toBe(true);
        expect(resolveObservableEventValue("alarmHub", { type: "alarmHubEntryClosed" }, "entry").value).toBe(false);
    });

    test("builds the official Alarm Hub output trigger request", () => {
        const execution = composeCapabilityExecution("alarmHub", "triggerAlarmHubOutput", {
            outputId: "1",
            state: "on",
            delay: "250",
            duration: "5000"
        });
        const request = buildCapabilityRequest(
            "alarmHub",
            "triggerAlarmHubOutput",
            "hub-1",
            execution.params
        );

        expect(request).toMatchObject({
            method: "POST",
            path: "/v1/alarm-hubs/hub-1/outputs/1/trigger"
        });
        expect(execution.payload).toEqual({
            delay: 250,
            duration: 5000,
            enable: true
        });
    });
});

describe("UniFi Protect 7.3 API additions", () => {
    test("normalizes a camera digital input event to its circuit state", () => {
        const event = (text) => ({
            type: "cameraDigitalInputChanged",
            metadata: { inputState: { text }, inputToken: { text: "DigitalInput_1" }, inputChannel: { text: "0" } }
        });

        expect(resolveObservableEventValue("camera", event("circuitClosed"), "digitalInput")).toMatchObject({ matched: true, value: true });
        expect(resolveObservableEventValue("camera", event("circuitOpen"), "digitalInput")).toMatchObject({ matched: true, value: false });
        expect(resolveObservableEventValue("camera", { type: "cameraDigitalInputChanged", metadata: {} }, "digitalInput").matched).toBe(false);
        expect(resolveObservableEventValue("camera", { type: "motion" }, "digitalInput").matched).toBe(false);
    });

    test("normalizes Alarm Hub enclosure tamper events and state", () => {
        const event = (text) => ({ type: "alarmHubDeviceTamper", metadata: { status: { text }, deviceId: { text: "hub-1" } } });

        expect(resolveObservableEventValue("alarmHub", event("tampered"), "deviceTamper")).toMatchObject({ matched: true, value: true });
        expect(resolveObservableEventValue("alarmHub", event("restored"), "deviceTamper")).toMatchObject({ matched: true, value: false });
        expect(resolveObservableEventValue("alarmHub", { type: "alarmHubTamper" }, "deviceTamper").matched).toBe(false);
        expect(resolveObservableState("alarmHub", { alarmHub: { deviceTamperStatus: "tampered" } }, "deviceTamper")).toBe(true);
        expect(resolveObservableState("alarmHub", { alarmHub: { deviceTamperStatus: "restored" } }, "deviceTamper")).toBe(false);
        expect(resolveObservableState("alarmHub", { alarmHub: {} }, "deviceTamper")).toBeUndefined();
    });

    test("shows only the events supported by sensor feature flags", async () => {
        const device = {
            featureFlags: {
                temperature: { channelCount: 1 },
                humidity: { channelCount: 1 },
                light: { channelCount: 1 },
                motion: { channelCount: 1 }
            }
        };
        const values = async (capabilityConfig) => (await getCapabilityOptions("sensor", "observe", { device, capabilityConfig }))
            .fields[0].options.map((option) => option.value);

        const supported = await values({});
        expect(supported).toEqual(expect.arrayContaining(["all", "motion", "temperature", "humidity", "lightLevel", "batteryLevel", "vape"]));
        expect(supported).not.toEqual(expect.arrayContaining(["contact"]));
        expect(supported).not.toEqual(expect.arrayContaining(["waterLeak"]));
        expect(supported).not.toEqual(expect.arrayContaining(["smokeFault"]));
        expect(await values({ observable: "contact" })).toEqual(expect.arrayContaining(["contact"]));
    });

    test("keeps every sensor event when feature flags are missing", async () => {
        const result = await getCapabilityOptions("sensor", "observe", { device: { featureFlags: {} }, capabilityConfig: {} });
        const values = result.fields[0].options.map((option) => option.value);

        expect(values).toEqual(expect.arrayContaining(["contact", "waterLeak", "smokeFault", "temperature"]));
    });

    test("builds the Alarm Manager webhook request", () => {
        const execution = composeCapabilityExecution("nvr", "triggerAlarmWebhook", { triggerId: " garage door " });
        const request = buildCapabilityRequest("nvr", "triggerAlarmWebhook", "nvr-1", execution.params);

        expect(request).toMatchObject({ method: "POST", path: "/v1/alarm-manager/webhook/garage%20door" });
        expect(execution.payload).toBeUndefined();
        expect(() => composeCapabilityExecution("nvr", "triggerAlarmWebhook", {})).toThrow("webhook ID");
    });

    test("builds a POS transaction from msg.payload", () => {
        const execution = composeCapabilityExecution("camera", "sendPosTransaction", { currency: "eur" }, null, {
            type: "Sale",
            externalId: 123,
            amount: "12.50",
            lineItems: [{ title: "Espresso", quantity: 2 }],
            location: { id: "r1" },
            timestamp: "1761300000000",
            note: "dropped"
        });
        const request = buildCapabilityRequest("camera", "sendPosTransaction", "camera-1", execution.params);

        expect(request).toMatchObject({ method: "POST", path: "/v1/pos/cameras/camera-1/transactions" });
        expect(execution.payload).toEqual({
            type: "sale",
            externalId: "123",
            amount: 12.5,
            currency: "EUR",
            lineItems: [{ title: "Espresso", quantity: 2 }],
            location: { id: "r1" },
            timestamp: 1761300000000
        });
    });

    test.each([
        [{ externalId: "1", amount: 1 }, "type"],
        [{ type: "sale", amount: 1 }, "externalId"],
        [{ type: "refund", externalId: "1", amount: -1 }, "amount"],
        [{ type: "sale", externalId: "1", amount: 1, timestamp: "not a date" }, "timestamp"]
    ])("rejects an invalid POS transaction %#", (payload, field) => {
        expect(() => composeCapabilityExecution("camera", "sendPosTransaction", {}, null, payload)).toThrow(field);
    });

    test("ignores msg.payload for actions that do not use it", () => {
        const execution = composeCapabilityExecution("siren", "playSiren", { duration: "3" }, null, { duration: 99 });

        expect(execution.payload).toEqual({ duration: 3 });
    });
});
