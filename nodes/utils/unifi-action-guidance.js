"use strict";

function actionGuidance(product, capability, options = {}) {
    if (product === "protect") {
        const lpr = capability === "observe" && options.observable === "licensePlate" || options.detectionType === "licensePlate";
        if (lpr || ["observeWithImage", "getRecentDetections"].includes(capability)) {
            return ["Requires a Protect API key with permission for this action."];
        }
    }
    if (product === "access" && capability === "observeDoorOpenTooLong") {
        return ["Requires a door position sensor (DPS)."];
    }
    if (product === "network" && capability === "observeInternet") {
        return ["Requires a UniFi gateway."];
    }
    return [];
}

module.exports = { actionGuidance };
