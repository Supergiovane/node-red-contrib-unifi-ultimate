"use strict";

// Registry used by both the editor and the runtime. The same definitions drive:
// - the device type dropdown
// - the list/detail API discovery paths
// - capability validation at runtime
const DEVICE_TYPE_DEFINITIONS = {
    site: {
        type: "site",
        label: "Site",
        listPath: "/v1/sites"
    },
    device: {
        type: "device",
        label: "UniFi Device",
        listPath: "/v1/sites/{siteId}/devices",
        detailPath: "/v1/sites/{siteId}/devices/{deviceId}"
    },
    client: {
        type: "client",
        label: "Client",
        listPath: "/v1/sites/{siteId}/clients",
        detailPath: "/v1/sites/{siteId}/clients/{clientId}"
    }
};

// Capabilities shared by every Network resource family.
const COMMON_CAPABILITIES = [
    {
        id: "observe",
        label: "Read State",
        description: "Fetch the selected item state.",
        mode: "observe"
    },
    {
        id: "getDetails",
        label: "Read Details",
        description: "Fetch full details for the selected item once.",
        mode: "fetch"
    }
];

// Type-specific actions. Each entry can optionally describe editor fields and a
// requestComposer that turns editor/runtime values into a concrete API request.
const TYPE_CAPABILITIES = {
    site: [
        {
            id: "getApplicationInfo",
            label: "Read Application Info",
            description: "Fetch UniFi Network application metadata.",
            method: "GET",
            path: "/v1/info",
            mode: "request"
        },
        {
            id: "listSiteDevices",
            label: "List Site Devices",
            description: "Fetch all adopted devices for the selected site.",
            method: "GET",
            path: "/v1/sites/{siteId}/devices",
            mode: "request"
        },
        {
            id: "listSiteClients",
            label: "List Site Clients",
            description: "Fetch connected clients for the selected site.",
            method: "GET",
            path: "/v1/sites/{siteId}/clients",
            mode: "request"
        }
    ],
    device: [
        {
            id: "getLatestStatistics",
            label: "Read Latest Statistics",
            description: "Fetch the latest statistics for the selected UniFi device.",
            method: "GET",
            path: "/v1/sites/{siteId}/devices/{deviceId}/statistics/latest",
            mode: "request"
        },
        {
            id: "restartDevice",
            label: "Restart Device",
            description: "Restart the selected UniFi device.",
            method: "POST",
            path: "/v1/sites/{siteId}/devices/{deviceId}/actions",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            requestComposer: () => ({
                payload: {
                    action: "RESTART"
                }
            })
        },
        {
            id: "powerCyclePort",
            label: "Power Cycle Port",
            description: "Power-cycle PoE on a specific port of the selected device.",
            method: "POST",
            path: "/v1/sites/{siteId}/devices/{deviceId}/interfaces/ports/{portIdx}/actions",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "portIdx",
                        label: "Port Index",
                        type: "select",
                        placeholder: "Select a port",
                        allowEmpty: false,
                        options: [],
                        helpText: "Physical switch port. Connected clients are shown when available."
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => {
                const portIdx = resolveIntegerValue(
                    undefined,
                    capabilityConfig && capabilityConfig.portIdx,
                    0
                );

                if (!Number.isInteger(portIdx)) {
                    throw new Error("Port index is required for Power Cycle Port.");
                }

                return {
                    params: {
                        portIdx
                    },
                    payload: {
                        action: "POWER_CYCLE"
                    }
                };
            }
        }
    ],
    client: [
        {
            id: "authorizeGuestAccess",
            label: "Authorize Guest Access",
            description: "Authorize a guest client with optional limits.",
            method: "POST",
            path: "/v1/sites/{siteId}/clients/{clientId}/actions",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "timeLimitMinutes",
                        label: "Time Limit (minutes)",
                        type: "number",
                        placeholder: "Optional, 1..1000000"
                    },
                    {
                        id: "dataUsageLimitMBytes",
                        label: "Data Limit (MB)",
                        type: "number",
                        placeholder: "Optional, 1..1048576"
                    },
                    {
                        id: "rxRateLimitKbps",
                        label: "Download Limit (Kbps)",
                        type: "number",
                        placeholder: "Optional, 2..100000"
                    },
                    {
                        id: "txRateLimitKbps",
                        label: "Upload Limit (Kbps)",
                        type: "number",
                        placeholder: "Optional, 2..100000"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => {
                const payloadOverrides = {};
                const payload = {
                    action: "AUTHORIZE_GUEST_ACCESS"
                };

                assignOptionalBoundedInteger(
                    payload,
                    "timeLimitMinutes",
                    payloadOverrides.timeLimitMinutes,
                    capabilityConfig && capabilityConfig.timeLimitMinutes,
                    1,
                    1000000
                );
                assignOptionalBoundedInteger(
                    payload,
                    "dataUsageLimitMBytes",
                    payloadOverrides.dataUsageLimitMBytes,
                    capabilityConfig && capabilityConfig.dataUsageLimitMBytes,
                    1,
                    1048576
                );
                assignOptionalBoundedInteger(
                    payload,
                    "rxRateLimitKbps",
                    payloadOverrides.rxRateLimitKbps,
                    capabilityConfig && capabilityConfig.rxRateLimitKbps,
                    2,
                    100000
                );
                assignOptionalBoundedInteger(
                    payload,
                    "txRateLimitKbps",
                    payloadOverrides.txRateLimitKbps,
                    capabilityConfig && capabilityConfig.txRateLimitKbps,
                    2,
                    100000
                );

                return { payload };
            }
        },
        {
            id: "unauthorizeGuestAccess",
            label: "Revoke Guest Access",
            description: "Revoke guest access and disconnect the selected guest client.",
            method: "POST",
            path: "/v1/sites/{siteId}/clients/{clientId}/actions",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            requestComposer: () => ({
                payload: {
                    action: "UNAUTHORIZE_GUEST_ACCESS"
                }
            })
        }
    ]
};

function getDeviceTypes() {
    return Object.values(DEVICE_TYPE_DEFINITIONS);
}

function getDeviceTypeDefinition(deviceType) {
    return DEVICE_TYPE_DEFINITIONS[String(deviceType || "").trim()] || null;
}

function getCapabilitiesForType(deviceType) {
    const definition = getDeviceTypeDefinition(deviceType);
    if (!definition) {
        return [];
    }

    // The editor needs a light "hasConfiguration" hint to decide whether it
    // should render the dynamic options section for the selected capability.
    return COMMON_CAPABILITIES
        .concat(TYPE_CAPABILITIES[definition.type] || [])
        .map((capability) => ({
            ...capability,
            hasConfiguration: Boolean(capability.editor && Array.isArray(capability.editor.fields) && capability.editor.fields.length > 0)
        }));
}

function getCapabilityDefinition(deviceType, capabilityId) {
    return getCapabilitiesForType(deviceType).find((capability) => capability.id === capabilityId) || null;
}

async function getCapabilityOptions(deviceType, capabilityId, context) {
    const capability = getCapabilityDefinition(deviceType, capabilityId);
    if (!capability || !capability.editor || !Array.isArray(capability.editor.fields)) {
        return {
            capabilityId,
            fields: []
        };
    }

    if (capabilityId === "powerCyclePort") {
        return buildPowerCyclePortCapabilityOptions(capabilityId, capability, context);
    }

    return {
        capabilityId,
        fields: capability.editor.fields.map((field) => ({ ...field }))
    };
}

async function buildPowerCyclePortCapabilityOptions(capabilityId, capability, context) {
    const safeContext = context && typeof context === "object" ? context : {};
    const scopedDeviceId = String(safeContext.deviceId || "").trim();
    const baseFields = capability.editor.fields.map((field) => ({ ...field }));

    if (!scopedDeviceId || typeof safeContext.fetchDevicePorts !== "function") {
        return {
            capabilityId,
            fields: baseFields
        };
    }

    let ports = [];
    try {
        ports = await safeContext.fetchDevicePorts(scopedDeviceId);
    } catch (error) {
        ports = [];
    }

    const options = Array.isArray(ports)
        ? ports
            .map((port) => {
                const idx = Number(port && port.idx);
                if (!Number.isFinite(idx) || idx < 0) {
                    return null;
                }

                const portName = String(port && port.name || `Port ${Math.trunc(idx)}`).trim();
                const clientNames = Array.isArray(port && port.connectedClientNames)
                    ? port.connectedClientNames.map((name) => String(name || "").trim()).filter(Boolean)
                    : [];
                const clientSuffix = clientNames.length > 0
                    ? ` -> ${clientNames.join(", ")}`
                    : "";
                const stateSuffix = String(port && port.state || "").trim()
                    ? ` [${String(port.state || "").trim()}]`
                    : "";

                return {
                    value: String(Math.trunc(idx)),
                    label: `${portName}${stateSuffix}${clientSuffix}`
                };
            })
            .filter(Boolean)
        : [];

    return {
        capabilityId,
        fields: baseFields.map((field) => {
            if (field.id !== "portIdx") {
                return field;
            }
            return {
                ...field,
                options,
                placeholder: options.length > 0 ? "Select a port" : "No ports found"
            };
        })
    };
}

function encodeScopedDeviceId(siteId, resourceId) {
    // UniFi Network resources are only unique inside a site, so the editor
    // stores them as a synthetic "siteId::resourceId" identifier.
    const normalizedSiteId = String(siteId || "").trim();
    const normalizedResourceId = String(resourceId || "").trim();

    if (!normalizedSiteId || !normalizedResourceId) {
        return "";
    }

    return `${normalizedSiteId}::${normalizedResourceId}`;
}

function decodeScopedDeviceId(value) {
    const normalized = String(value || "").trim();
    if (!normalized) {
        return {
            siteId: "",
            resourceId: ""
        };
    }

    const separatorIndex = normalized.indexOf("::");
    if (separatorIndex === -1) {
        return {
            siteId: "",
            resourceId: normalized
        };
    }

    return {
        siteId: normalized.slice(0, separatorIndex).trim(),
        resourceId: normalized.slice(separatorIndex + 2).trim()
    };
}

function resolveScopedIdentifiers(deviceType, deviceId, device) {
    // Runtime calls can come from:
    // - a scoped id persisted by the editor
    // - a plain id already enriched in currentDevice
    // - a site object, where siteId and resourceId collapse to the same value
    const normalizedType = String(deviceType || "").trim();
    const normalizedDevice = device && typeof device === "object" && !Array.isArray(device)
        ? device
        : {};

    if (normalizedType === "site") {
        const siteId = String(
            deviceId ||
            normalizedDevice.siteId ||
            normalizedDevice.site_id ||
            normalizedDevice.id ||
            ""
        ).trim();

        return {
            siteId,
            resourceId: siteId
        };
    }

    const parsed = decodeScopedDeviceId(deviceId);
    const siteId = String(
        parsed.siteId ||
        normalizedDevice.siteId ||
        normalizedDevice.site_id ||
        ""
    ).trim();
    const resourceId = String(
        parsed.resourceId ||
        normalizedDevice.id ||
        normalizedDevice.clientId ||
        normalizedDevice.deviceId ||
        ""
    ).trim();

    return {
        siteId,
        resourceId
    };
}

function buildPathFromTemplate(path, params) {
    const map = params && typeof params === "object" ? params : {};
    return String(path || "")
        .replace(/\{siteId\}|:siteId/g, encodeURIComponent(String(map.siteId || "")))
        .replace(/\{deviceId\}|:deviceId/g, encodeURIComponent(String(map.deviceId || "")))
        .replace(/\{clientId\}|:clientId/g, encodeURIComponent(String(map.clientId || "")))
        .replace(/\{portIdx\}|:portIdx/g, encodeURIComponent(String(map.portIdx !== undefined ? map.portIdx : "")));
}

function buildCapabilityRequest(deviceType, capabilityId, deviceId, params, device) {
    const capability = getCapabilityDefinition(deviceType, capabilityId);
    if (!capability) {
        throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
    }

    if (!capability.path) {
        throw new Error(`Capability '${capabilityId}' does not define a request path.`);
    }

    const scoped = resolveScopedIdentifiers(deviceType, deviceId, device);
    if (!scoped.siteId) {
        throw new Error("This capability requires a site id.");
    }

    // Path params are computed from both the selected scoped id and any
    // capability-specific values such as portIdx.
    const normalizedParams = normalizeObject(params);
    const path = buildPathFromTemplate(capability.path, {
        siteId: scoped.siteId,
        deviceId: scoped.resourceId,
        clientId: scoped.resourceId,
        portIdx: normalizedParams.portIdx
    });

    if (/\{[^}]+\}/.test(path) || /:[a-zA-Z]/.test(path)) {
        throw new Error(`Missing path parameters for capability '${capabilityId}'.`);
    }

    return {
        capability,
        method: capability.method || "GET",
        path,
        siteId: scoped.siteId,
        resourceId: scoped.resourceId
    };
}

function composeCapabilityExecution(deviceType, capabilityId, capabilityConfig) {
    const capability = getCapabilityDefinition(deviceType, capabilityId);
    if (!capability) {
        throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
    }

    // Input messages are triggers only. Execution data comes from the editor
    // configuration and capability defaults.
    const normalizedConfig = normalizeObject(capabilityConfig);
    const composedRequest = typeof capability.requestComposer === "function"
        ? capability.requestComposer({
            capabilityConfig: normalizedConfig
        }) || {}
        : {};

    return {
        params: normalizeObject(composedRequest.params),
        query: normalizeObject(composedRequest.query),
        headers: normalizeObject(composedRequest.headers),
        payload: composedRequest.payload
    };
}

function summarizeDevice(deviceType, device) {
    // The editor uses a normalized summary so different API payload shapes can
    // still be rendered through the same generic dropdown UI.
    const normalizedType = String(deviceType || "").trim();
    const item = device && typeof device === "object" ? device : {};

    if (normalizedType === "site") {
        const siteId = String(item.id || item.siteId || item.site_id || "").trim();
        const countryCode = String(item.countryCode || item.country || "").trim();

        return {
            id: siteId,
            name: String(item.displayName || item.name || siteId || "Site"),
            state: countryCode || String(item.timezone || "").trim(),
            siteId,
            raw: item
        };
    }

    const siteId = String(item.siteId || item.site_id || "").trim();
    const resourceId = String(item.id || item.deviceId || item.clientId || "").trim();
    const scopedId = encodeScopedDeviceId(siteId, resourceId) || resourceId;
    const siteName = String(item.siteName || item.site_name || "").trim();

    if (normalizedType === "device") {
        const model = String(item.model || item.modelName || item.type || "").trim();
        return {
            id: scopedId,
            name: String(item.displayName || item.name || item.hostname || resourceId || "Device"),
            state: model || String(item.status || item.state || "").trim(),
            siteId,
            siteName,
            resourceId,
            raw: item
        };
    }

    const isOffline = item.offline === true
        || item.isOnline === false
        || item.online === false
        || item.connected === false
        || item.isConnected === false
        || item.connectionState === "DISCONNECTED"
        || item.connectionState === "disconnected"
        || item.status === "OFFLINE"
        || item.status === "offline"
        || String(item.state || "").trim().toLowerCase() === "offline";
    const clientName = String(item.hostname || item.name || item.displayName || item.macAddress || resourceId || "Client");
    const displayName = isOffline && !/\(offline\)/i.test(clientName)
        ? `${clientName} (OffLine)`
        : clientName;

    return {
        id: scopedId,
        name: displayName,
        state: isOffline
            ? "offline"
            : String(item.ipAddress || item.network || item.type || item.state || "").trim(),
        siteId,
        siteName,
        resourceId,
        isOnline: !isOffline,
        online: !isOffline,
        offline: isOffline,
        raw: item
    };
}

function parseOptionalInteger(value) {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return undefined;
    }

    return Math.trunc(numeric);
}

function resolveIntegerValue(primaryValue, fallbackValue, minimum) {
    const primary = parseOptionalInteger(primaryValue);
    if (Number.isInteger(primary) && primary >= minimum) {
        return primary;
    }

    const fallback = parseOptionalInteger(fallbackValue);
    if (Number.isInteger(fallback) && fallback >= minimum) {
        return fallback;
    }

    return undefined;
}

function assignOptionalBoundedInteger(target, key, primaryValue, fallbackValue, minimum, maximum) {
    // Apply the first valid configured integer, but only when the value respects
    // the API contract bounds.
    const primary = parseOptionalInteger(primaryValue);
    if (Number.isInteger(primary) && primary >= minimum && primary <= maximum) {
        target[key] = primary;
        return;
    }

    const fallback = parseOptionalInteger(fallbackValue);
    if (Number.isInteger(fallback) && fallback >= minimum && fallback <= maximum) {
        target[key] = fallback;
    }
}

function normalizeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

module.exports = {
    buildCapabilityRequest,
    composeCapabilityExecution,
    decodeScopedDeviceId,
    encodeScopedDeviceId,
    getCapabilitiesForType,
    getCapabilityDefinition,
    getCapabilityOptions,
    getDeviceTypeDefinition,
    getDeviceTypes,
    resolveScopedIdentifiers,
    summarizeDevice
};
