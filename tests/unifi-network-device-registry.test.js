"use strict";

const {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilitiesForType,
    getCapabilityDefinition
} = require("../nodes/utils/unifi-network-device-registry");

const READ_ONLY_SITE_CAPABILITIES = [
    ["listSiteNetworks", "/v1/sites/{siteId}/networks"],
    ["listWifiBroadcasts", "/v1/sites/{siteId}/wifi/broadcasts"],
    ["listWanInterfaces", "/v1/sites/{siteId}/wans"],
    ["listVpnServers", "/v1/sites/{siteId}/vpn/servers"],
    ["listSiteToSiteVpnTunnels", "/v1/sites/{siteId}/vpn/site-to-site-tunnels"],
    ["listGuestVouchers", "/v1/sites/{siteId}/hotspot/vouchers"]
];

describe("UniFi Network read-only site capabilities", () => {
    test.each(READ_ONLY_SITE_CAPABILITIES)(
        "%s is a GET request capability",
        (capabilityId, path) => {
            const capability = getCapabilityDefinition("site", capabilityId);

            expect(capability).toMatchObject({
                id: capabilityId,
                method: "GET",
                path,
                mode: "request"
            });
            expect(capability.requestComposer).toBeUndefined();
        }
    );

    test.each(READ_ONLY_SITE_CAPABILITIES)(
        "%s resolves the selected site without accepting message data",
        (capabilityId, path) => {
            const request = buildCapabilityRequest(
                "site",
                capabilityId,
                "site id/with spaces",
                {},
                null
            );
            const execution = composeCapabilityExecution("site", capabilityId, {});

            expect(request).toMatchObject({
                method: "GET",
                path: path.replace("{siteId}", "site%20id%2Fwith%20spaces"),
                siteId: "site id/with spaces",
                resourceId: "site id/with spaces"
            });
            expect(execution).toEqual({
                params: {},
                query: {},
                headers: {},
                payload: undefined
            });
        }
    );

    test("all new capabilities are exposed only by the Site resource", () => {
        const siteIds = getCapabilitiesForType("site").map((capability) => capability.id);
        const deviceIds = getCapabilitiesForType("device").map((capability) => capability.id);
        const clientIds = getCapabilitiesForType("client").map((capability) => capability.id);

        READ_ONLY_SITE_CAPABILITIES.forEach(([capabilityId]) => {
            expect(siteIds).toContain(capabilityId);
            expect(deviceIds).not.toContain(capabilityId);
            expect(clientIds).not.toContain(capabilityId);
        });
    });
});
