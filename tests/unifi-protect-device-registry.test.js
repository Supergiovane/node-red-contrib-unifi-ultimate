"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilityOptions,
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
