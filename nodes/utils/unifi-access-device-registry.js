"use strict";

const DEVICE_TYPE_DEFINITIONS = {
    door: {
        type: "door",
        label: "Door",
        listPath: "/api/v1/developer/doors",
        detailPath: "/api/v1/developer/doors/:id"
    },
    device: {
        type: "device",
        label: "Access Device",
        listPath: "/api/v1/developer/devices"
    }
};

const COMMON_CAPABILITIES = [
    {
        id: "observe",
        label: "Receive Events",
        description: "Fetch the current state and subscribe to Access notifications.",
        mode: "observe"
    },
    {
        id: "getDetails",
        label: "Read State",
        description: "Fetch the selected Access object once.",
        mode: "fetch"
    }
];

const TYPE_CAPABILITIES = {
    door: [
        {
            id: "unlockDoor",
            label: "Unlock Door",
            description: "Trigger a remote door unlock. You can still send msg.payload for actor_id, actor_name, or extra.",
            method: "PUT",
            path: "/api/v1/developer/doors/:id/unlock",
            mode: "request"
        },
        {
            id: "getLockRule",
            label: "Read Lock Rule",
            description: "Fetch the current door lock rule.",
            method: "GET",
            path: "/api/v1/developer/doors/:id/lock_rule",
            mode: "request"
        },
        {
            id: "setTemporaryLockRule",
            label: "Set Temporary Lock Rule",
            description: "Set a temporary lock rule for the selected door.",
            method: "PUT",
            path: "/api/v1/developer/doors/:id/lock_rule",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "type",
                        label: "Rule",
                        type: "select",
                        options: [
                            { value: "keep_lock", label: "Keep Locked" },
                            { value: "keep_unlock", label: "Keep Unlocked" },
                            { value: "custom", label: "Custom Duration" },
                            { value: "lock_early", label: "End Unlock Early" },
                            { value: "schedule", label: "Schedule" }
                        ]
                    },
                    {
                        id: "ended_time",
                        label: "End Time",
                        type: "text",
                        placeholder: "Unix timestamp, only used for custom"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => {
                const payload = {
                    type: String(capabilityConfig.type || "keep_lock").trim() || "keep_lock"
                };

                const endedTime = Number(capabilityConfig.ended_time);
                if (payload.type === "custom" && Number.isFinite(endedTime)) {
                    payload.ended_time = endedTime;
                }

                return { payload };
            }
        },
        {
            id: "getEmergencyMode",
            label: "Read Emergency Mode",
            description: "Fetch the global emergency state for all doors.",
            method: "GET",
            path: "/api/v1/developer/doors/settings/emergency",
            mode: "request"
        },
        {
            id: "setEmergencyMode",
            label: "Set Emergency Mode",
            description: "Set the global emergency mode for all doors.",
            method: "PUT",
            path: "/api/v1/developer/doors/settings/emergency",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "mode",
                        label: "Mode",
                        type: "select",
                        options: [
                            { value: "normal", label: "Normal" },
                            { value: "lockdown", label: "Lockdown" },
                            { value: "evacuation", label: "Evacuation" }
                        ]
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => {
                const mode = String(capabilityConfig.mode || "normal").trim() || "normal";
                return {
                    payload: {
                        lockdown: mode === "lockdown",
                        evacuation: mode === "evacuation"
                    }
                };
            }
        }
    ],
    device: [
        {
            id: "getAccessMethods",
            label: "Read Access Methods",
            description: "Fetch the access method settings for the selected Access device.",
            method: "GET",
            path: "/api/v1/developer/devices/:id/settings",
            mode: "request"
        },
        {
            id: "updateAccessMethods",
            label: "Update Access Methods",
            description: "Update access method settings using msg.payload.",
            method: "PUT",
            path: "/api/v1/developer/devices/:id/settings",
            mode: "request"
        },
        {
            id: "triggerDoorbell",
            label: "Trigger Doorbell",
            description: "Trigger the doorbell on the selected Access device.",
            method: "POST",
            path: "/api/v1/developer/devices/:id/doorbell",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "room_name",
                        label: "Room Name",
                        type: "text",
                        allowEmpty: true,
                        placeholder: "Optional intercom directory name"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => {
                const payload = {};
                const roomName = String(capabilityConfig.room_name || "").trim();
                if (roomName) {
                    payload.room_name = roomName;
                }
                return { payload };
            }
        },
        {
            id: "cancelDoorbell",
            label: "Cancel Doorbell",
            description: "Cancel the current doorbell ring if it is still active.",
            method: "POST",
            path: "/api/v1/developer/devices/:id/doorbell",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "room_name",
                        label: "Room Name",
                        type: "text",
                        allowEmpty: true,
                        placeholder: "Leave empty to cancel all active rings"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => {
                const payload = {
                    cancel: true
                };
                const roomName = String(capabilityConfig.room_name || "").trim();
                if (roomName) {
                    payload.room_name = roomName;
                }
                return { payload };
            }
        }
    ]
};

function getDeviceTypes() {
    return Object.values(DEVICE_TYPE_DEFINITIONS);
}

function getDeviceTypeDefinition(deviceType) {
    return DEVICE_TYPE_DEFINITIONS[String(deviceType || "").trim()] || null;
}

function getCapabilitiesForType(deviceType, device) {
    const definition = getDeviceTypeDefinition(deviceType);
    if (!definition) {
        return [];
    }

    return COMMON_CAPABILITIES
        .concat(TYPE_CAPABILITIES[definition.type] || [])
        .filter((capability) => isCapabilitySupportedForDevice(definition.type, capability, device))
        .map((capability) => ({
        ...capability,
        hasConfiguration: Boolean(capability.editor && Array.isArray(capability.editor.fields) && capability.editor.fields.length > 0)
    }));
}

function getCapabilityDefinition(deviceType, capabilityId, device) {
    return getCapabilitiesForType(deviceType, device).find((capability) => capability.id === capabilityId) || null;
}

async function getCapabilityOptions(deviceType, capabilityId, context) {
    const capability = getCapabilityDefinition(deviceType, capabilityId, context && context.device);
    if (!capability || !capability.editor || !Array.isArray(capability.editor.fields)) {
        return {
            capabilityId,
            fields: []
        };
    }

    return {
        capabilityId,
        fields: capability.editor.fields.map((field) => ({ ...field }))
    };
}

function buildPathFromTemplate(path, deviceId) {
    return String(path || "").replace(":id", encodeURIComponent(String(deviceId || "").trim()));
}

function buildCapabilityRequest(deviceType, capabilityId, deviceId, device) {
    const capability = getCapabilityDefinition(deviceType, capabilityId, device);
    if (!capability) {
        throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
    }

    if (!capability.path) {
        throw new Error(`Capability '${capabilityId}' does not define a request path.`);
    }

    return {
        capability,
        method: capability.method || "GET",
        path: buildPathFromTemplate(capability.path, deviceId)
    };
}

function composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, msg, device) {
    const capability = getCapabilityDefinition(deviceType, capabilityId, device);
    if (!capability) {
        throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
    }

    const normalizedConfig = normalizeObject(capabilityConfig);
    const composedRequest = typeof capability.requestComposer === "function"
        ? capability.requestComposer({
            capabilityConfig: normalizedConfig,
            msg
        }) || {}
        : {};

    let payload = composedRequest.payload;
    if (capability.useConfiguredPayload) {
        payload = composedRequest.payload;
    } else if (!capability.ignoreInputPayload) {
        payload = msg.payload;
    }

    return {
        query: Object.assign({}, composedRequest.query, normalizeObject(msg.query)),
        headers: normalizeObject(msg.headers),
        payload
    };
}

function isCapabilitySupportedForDevice(deviceType, capability, device) {
    if (!capability || String(deviceType || "").trim() !== "device") {
        return true;
    }

    if (capability.id === "triggerDoorbell" || capability.id === "cancelDoorbell") {
        return isDoorbellCapableAccessDevice(device);
    }

    return true;
}

function isDoorbellCapableAccessDevice(device) {
    const item = normalizeObject(device);
    const signatures = [
        item.type,
        item.model,
        item.model_name,
        item.product,
        item.product_name,
        item.name,
        item.alias,
        item.full_name,
        item.display_name
    ]
        .map((value) => String(value || "").trim().toUpperCase())
        .filter(Boolean);

    if (signatures.length === 0) {
        return true;
    }

    const joined = signatures.join(" ");
    if (joined.includes("VIEWER") || joined.includes("UA-INT-VIEWER")) {
        return false;
    }

    if (joined.includes("INTERCOM") || joined.includes("UA-INTERCOM") || joined.includes("UA INT")) {
        return true;
    }

    return /READER[^A-Z0-9]*PRO/.test(joined) || /UA[-_ ]?G2[-_ ]?PRO/.test(joined);
}

function normalizeObjectArray(value) {
    return Array.isArray(value)
        ? value.filter((entry) => entry && typeof entry === "object")
        : [];
}

function summarizeDevice(deviceType, device) {
    const normalizedType = String(deviceType || "").trim();
    const item = device && typeof device === "object" ? device : {};
    const id = String(item.id || "").trim();

    if (normalizedType === "door") {
        const stateParts = [];
        if (item.door_lock_relay_status) {
            stateParts.push(item.door_lock_relay_status);
        }
        if (item.door_position_status) {
            stateParts.push(item.door_position_status);
        }

        return {
            id,
            name: String(item.name || item.full_name || id || "Door"),
            state: stateParts.join(" / "),
            raw: item
        };
    }

    return {
        id,
        name: String(item.alias || item.name || id || "Device"),
        state: String(item.type || "").trim(),
        raw: item
    };
}

function matchesEvent(deviceType, deviceId, currentDevice, eventPayload) {
    const selectedId = String(deviceId || "").trim();
    const event = eventPayload && typeof eventPayload === "object" ? eventPayload : {};
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const current = currentDevice && typeof currentDevice === "object" ? currentDevice : {};

    if (!selectedId) {
        return false;
    }

    if ([event.event_object_id, data.unique_id, data.up_id, data.id, data.device_id, data.connected_uah_id].some((value) => String(value || "").trim() === selectedId)) {
        return true;
    }

    if (String(deviceType || "").trim() === "door") {
        const currentNames = [current.name, current.full_name].map((value) => String(value || "").trim()).filter(Boolean);
        return [data.name, data.door_name, data.full_name].some((value) => currentNames.includes(String(value || "").trim()));
    }

    return false;
}

function normalizeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

module.exports = {
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilitiesForType,
    getCapabilityDefinition,
    getCapabilityOptions,
    getDeviceTypeDefinition,
    getDeviceTypes,
    matchesEvent,
    summarizeDevice
};
