"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilitiesForType,
    getDeviceTypeDefinition
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
});
