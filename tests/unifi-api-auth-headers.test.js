"use strict";

const protectUtils = require("../nodes/utils/unifi-protect-utils");
const networkUtils = require("../nodes/utils/unifi-network-utils");

describe.each([
    ["Protect", protectUtils],
    ["Network", networkUtils]
])("%s API request headers", (_product, utils) => {
    test("always sends the API key with the official header", () => {
        expect(utils.buildRequestHeaders("secret", {})).toMatchObject({
            Accept: "application/json",
            "X-API-Key": "secret"
        });
    });

    test("does not allow request options to replace the API key", () => {
        expect(utils.buildRequestHeaders("secret", {
            "X-API-Key": "incorrect",
            "Content-Type": "application/json"
        })).toMatchObject({
            "X-API-Key": "secret",
            "Content-Type": "application/json"
        });
    });
});
