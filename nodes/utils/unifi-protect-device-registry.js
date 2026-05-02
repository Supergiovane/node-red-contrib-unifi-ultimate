"use strict";

const {
    buildObservableHelpText,
    buildFieldHelpText,
    formatFieldLabel,
    formatObservableLabel,
    formatValueWithMetadata
} = require("./unifi-protect-field-metadata");

// Central Protect registry used by:
// - the editor for device/capability discovery
// - the runtime for request validation/building
// - the event layer for observable matching
const DEVICE_TYPE_DEFINITIONS = {
    camera: {
        type: "camera",
        label: "Camera",
        modelKey: "camera",
        listPath: "/v1/cameras",
        detailPath: "/v1/cameras/:id"
    },
    sensor: {
        type: "sensor",
        label: "Sensor",
        modelKey: "sensor",
        listPath: "/v1/sensors",
        detailPath: "/v1/sensors/:id"
    },
    light: {
        type: "light",
        label: "Light",
        modelKey: "light",
        listPath: "/v1/lights",
        detailPath: "/v1/lights/:id"
    },
    chime: {
        type: "chime",
        label: "Chime",
        modelKey: "chime",
        listPath: "/v1/chimes",
        detailPath: "/v1/chimes/:id"
    },
    viewer: {
        type: "viewer",
        label: "Viewer",
        modelKey: "viewer",
        listPath: "/v1/viewers",
        detailPath: "/v1/viewers/:id"
    },
    liveview: {
        type: "liveview",
        label: "Live View",
        modelKey: "liveview",
        listPath: "/v1/liveviews",
        detailPath: "/v1/liveviews/:id"
    },
    nvr: {
        type: "nvr",
        label: "NVR",
        modelKey: "nvr",
        listPath: "/v1/nvrs",
        detailPath: "/v1/nvrs"
    }
};

// Baseline actions available across most Protect resources.
const COMMON_CAPABILITIES = [
    {
        id: "observe",
        label: "Receive Events",
        description: "Fetch current state and keep listening to Protect streams.",
        method: "GET",
        pathKind: "detail",
        mode: "observe"
    },
    {
        id: "getDetails",
        label: "Read Device State",
        description: "Fetch the full object payload once.",
        method: "GET",
        pathKind: "detail",
        mode: "request"
    },
    {
        id: "patchSettings",
        label: "Send Raw Update",
        description: "PATCH the selected device using the configured node action.",
        method: "PATCH",
        pathKind: "detail",
        mode: "request"
    }
];

const RTSPS_QUALITY_OPTIONS = ["high", "medium", "low", "package"].map((quality) => ({
    value: quality,
    label: quality
}));

const SENSOR_OBSERVABLE_DEFINITIONS = [
    {
        id: "contact",
        label: "Contact open/closed",
        eventTypes: ["sensorOpened", "sensorClosed"]
    },
    {
        id: "motion",
        label: "Motion",
        eventTypes: ["sensorMotion"]
    },
    {
        id: "alarm",
        label: "Alarm",
        eventTypes: ["sensorAlarm"]
    },
    {
        id: "waterLeak",
        label: "Water leak",
        eventTypes: ["sensorWaterLeak"]
    },
    {
        id: "batteryLow",
        label: "Battery low",
        eventTypes: ["sensorBatteryLow"]
    },
    {
        id: "tamper",
        label: "Tamper",
        eventTypes: ["sensorTamper"]
    },
    {
        id: "smokeTest",
        label: "Smoke test",
        eventTypes: ["sensorSmokeTest"]
    },
    {
        id: "extremeValues",
        label: "Extreme values",
        eventTypes: ["sensorExtremeValues"]
    }
];

const CAMERA_OBSERVABLE_DEFINITIONS = [
    {
        id: "ring",
        label: "Ring",
        eventTypes: ["ring"]
    },
    {
        id: "motion",
        label: "Motion",
        eventTypes: ["motion"]
    },
    {
        id: "smartAudioDetect",
        label: "Smart audio detect",
        eventTypes: ["smartAudioDetect"]
    },
    {
        id: "smartDetectZone",
        label: "Smart detect zone",
        eventTypes: ["smartDetectZone"]
    },
    {
        id: "smartDetectLine",
        label: "Smart detect line",
        eventTypes: ["smartDetectLine"]
    },
    {
        id: "smartDetectLoiterZone",
        label: "Smart detect loiter",
        eventTypes: ["smartDetectLoiterZone"]
    }
];

const LIGHT_OBSERVABLE_DEFINITIONS = [
    {
        id: "motion",
        label: "Motion",
        eventTypes: ["lightMotion"]
    },
    {
        id: "lightOn",
        label: "Light on",
        eventTypes: []
    }
];

function createSetPropertyCapability() {
    // "Update One Property" is built once and reused across multiple device
    // families. The real property list is discovered dynamically per device.
    return {
        id: "setProperty",
        label: "Update One Property",
        description: "Patch a single property discovered from the selected device.",
        method: "PATCH",
        pathKind: "detail",
        mode: "request",
        ignoreInputPayload: true,
        useConfiguredPayload: true,
        editor: {
            fields: [
                {
                    id: "propertyPath",
                    label: "Property",
                    type: "select",
                    placeholder: "Select a property",
                    reloadOnChange: true
                },
                {
                    id: "valueType",
                    type: "hidden"
                },
                {
                    id: "propertyValue",
                    label: "Value",
                    type: "text",
                    placeholder: "Select a property first"
                }
            ]
        },
        requestComposer: ({ capabilityConfig }) => ({
            payload: buildNestedPatchPayload(
                capabilityConfig.propertyPath,
                parseConfiguredPropertyValue(capabilityConfig.propertyValue, capabilityConfig.valueType)
            )
        })
    };
}

// Per-type capability registry. Definitions can expose dynamic editor fields,
// custom request composers and additional runtime filtering heuristics.
const TYPE_CAPABILITIES = {
    camera: [
        {
            id: "getSnapshot",
            label: "Take Snapshot",
            description: "Fetch a JPEG snapshot for the selected camera.",
            method: "GET",
            path: "/v1/cameras/:id/snapshot",
            mode: "request",
            ignoreInputPayload: true,
            editor: {
                fields: [
                    {
                        id: "forceHighQuality",
                        label: "High quality",
                        type: "select",
                        allowEmpty: true,
                        emptyLabel: "Default",
                        options: [
                            { value: "true", label: "True" },
                            { value: "false", label: "False" }
                        ]
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => ({
                query: capabilityConfig.forceHighQuality
                    ? { forceHighQuality: capabilityConfig.forceHighQuality }
                    : {}
            })
        },
        {
            id: "getRtspsStreams",
            label: "List RTSPS Streams",
            description: "Fetch current RTSPS streams for the selected camera.",
            method: "GET",
            path: "/v1/cameras/:id/rtsps-stream",
            mode: "request"
        },
        {
            id: "createRtspsStreams",
            label: "Create RTSPS Stream",
            description: "Create RTSPS streams using the configured node action.",
            method: "POST",
            path: "/v1/cameras/:id/rtsps-stream",
            mode: "request"
        },
        {
            id: "deleteRtspsStreams",
            label: "Delete RTSPS Stream",
            description: "Delete RTSPS streams using the configured node action.",
            method: "DELETE",
            path: "/v1/cameras/:id/rtsps-stream",
            mode: "request"
        },
        {
            id: "createTalkbackSession",
            label: "Start Talkback Session",
            description: "Create a talkback session using the configured node action.",
            method: "POST",
            path: "/v1/cameras/:id/talkback-session",
            mode: "request"
        },
        {
            id: "disableMicPermanently",
            label: "Disable Microphone Permanently",
            description: "Permanently disable the selected camera microphone.",
            method: "POST",
            path: "/v1/cameras/:id/disable-mic-permanently",
            mode: "request",
            ignoreInputPayload: true
        },
        {
            id: "startPtzPatrol",
            label: "Start PTZ Patrol",
            description: "Start a PTZ patrol.",
            method: "POST",
            path: "/v1/cameras/:id/ptz/patrol/start/:slot",
            mode: "request",
            parameterNames: ["slot"],
            ignoreInputPayload: true,
            editor: {
                fields: [
                    {
                        id: "slot",
                        label: "Patrol slot",
                        type: "select",
                        options: [
                            { value: "0", label: "Patrol 0" },
                            { value: "1", label: "Patrol 1" },
                            { value: "2", label: "Patrol 2" },
                            { value: "3", label: "Patrol 3" },
                            { value: "4", label: "Patrol 4" }
                        ]
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => ({
                params: {
                    slot: capabilityConfig.slot
                }
            })
        },
        {
            id: "stopPtzPatrol",
            label: "Stop PTZ Patrol",
            description: "Stop the active PTZ patrol.",
            method: "POST",
            path: "/v1/cameras/:id/ptz/patrol/stop",
            mode: "request"
        },
        {
            id: "gotoPtzPreset",
            label: "Recall PTZ Preset",
            description: "Move the PTZ camera to a preset.",
            method: "POST",
            path: "/v1/cameras/:id/ptz/goto/:slot",
            mode: "request",
            parameterNames: ["slot"],
            ignoreInputPayload: true,
            editor: {
                fields: [
                    {
                        id: "slot",
                        label: "PTZ preset",
                        type: "select",
                        placeholder: "Select a preset"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => ({
                params: {
                    slot: capabilityConfig.slot
                }
            })
        },
        {
            id: "setDoorbellMessage",
            label: "Show Doorbell Message",
            description: "Set a predefined, custom, or image message on the camera doorbell.",
            method: "PATCH",
            pathKind: "detail",
            mode: "request",
            ignoreInputPayload: true,
            useConfiguredPayload: true,
            editor: {
                fields: [
                    {
                        id: "messageType",
                        label: "Message type",
                        type: "select",
                        reloadOnChange: true,
                        options: [
                            { value: "DO_NOT_DISTURB", label: "Do not disturb" },
                            { value: "LEAVE_PACKAGE_AT_DOOR", label: "Leave package at door" },
                            { value: "CUSTOM_MESSAGE", label: "Custom message" },
                            { value: "IMAGE", label: "Image" }
                        ]
                    },
                    {
                        id: "messageText",
                        label: "Text",
                        type: "text",
                        placeholder: "Hello"
                    },
                    {
                        id: "messageImage",
                        label: "Image asset",
                        type: "select",
                        placeholder: "Select an asset"
                    },
                    {
                        id: "resetAt",
                        label: "Reset at",
                        type: "text",
                        placeholder: "empty=default, null=forever, or unix timestamp"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => ({
                payload: {
                    lcdMessage: buildDoorbellMessagePayload(capabilityConfig)
                }
            })
        },
        createSetPropertyCapability()
    ],
    liveview: [
        createSetPropertyCapability()
    ],
    sensor: [
        createSetPropertyCapability()
    ],
    light: [
        createSetPropertyCapability()
    ],
    chime: [
        createSetPropertyCapability()
    ],
    viewer: [
        {
            id: "setLiveview",
            label: "Switch Live View",
            description: "Assign the selected live view to the viewer.",
            method: "PATCH",
            pathKind: "detail",
            mode: "request",
            editor: {
                fields: [
                    {
                        id: "liveview",
                        label: "Live view",
                        type: "select",
                        placeholder: "Select a live view",
                        allowEmpty: true,
                        emptyLabel: "No live view"
                    }
                ]
            },
            requestComposer: ({ capabilityConfig }) => ({
                payload: {
                    liveview: capabilityConfig.liveview ? capabilityConfig.liveview : null
                }
            }),
            useConfiguredPayload: true
        },
        createSetPropertyCapability()
    ],
    nvr: [
        {
            id: "getApplicationInfo",
            label: "Read Application Info",
            description: "Fetch Protect application metadata from /v1/meta/info.",
            method: "GET",
            path: "/v1/meta/info",
            mode: "request"
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

    // Device-aware filtering removes actions that the selected hardware cannot
    // support, such as PTZ actions on non-PTZ cameras.
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

function buildDevicePath(deviceType, kind, deviceId, params) {
    // Some Protect endpoints come from the generic type definition (list/detail),
    // while others provide their own custom path template.
    const definition = getDeviceTypeDefinition(deviceType);
    if (!definition) {
        throw new Error(`Unsupported device type: ${deviceType}`);
    }

    let path;
    if (kind === "list") {
        path = definition.listPath;
    } else {
        path = definition.detailPath;
    }

    if (path.includes(":id")) {
        if (!deviceId) {
            throw new Error(`Device type '${deviceType}' requires a device id.`);
        }
        path = path.replace(":id", encodeURIComponent(String(deviceId)));
    }

    Object.entries(params || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") {
            return;
        }
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
    });

    if (path.includes(":")) {
        throw new Error(`Missing required path parameters for ${path}`);
    }

    return path;
}

function buildCapabilityRequest(deviceType, capabilityId, deviceId, params, device) {
    const capability = getCapabilityDefinition(deviceType, capabilityId, device);
    if (!capability) {
        throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
    }

    const path = capability.path
        ? buildPathFromTemplate(capability.path, deviceId, params)
        : buildDevicePath(deviceType, capability.pathKind === "list" ? "list" : "detail", deviceId, params);

    return {
        capability,
        method: capability.method,
        path
    };
}

function composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, device) {
    const capability = getCapabilityDefinition(deviceType, capabilityId, device);
    if (!capability) {
        throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
    }

    // Input messages are triggers only. Execution data comes from the editor
    // configuration and capability defaults.
    if (typeof capability.requestComposer !== "function") {
        return {
            params: {},
            query: {},
            headers: {},
            payload: undefined
        };
    }

    const composedRequest = capability.requestComposer({
        capabilityConfig: normalizeObject(capabilityConfig)
    }) || {};

    const params = {
        ...normalizeObject(composedRequest.params)
    };
    const query = {
        ...normalizeObject(composedRequest.query)
    };
    const headers = {
        ...normalizeObject(composedRequest.headers)
    };

    let payload;
    if (capability.useConfiguredPayload) {
        payload = Object.prototype.hasOwnProperty.call(composedRequest, "payload")
            ? composedRequest.payload
            : undefined;
    } else if (capability.ignoreInputPayload) {
        payload = Object.prototype.hasOwnProperty.call(composedRequest, "payload")
            ? composedRequest.payload
            : undefined;
    } else if (Object.prototype.hasOwnProperty.call(composedRequest, "payload")) {
        payload = composedRequest.payload;
    }

    return {
        params,
        query,
        headers,
        payload
    };
}

async function getCapabilityOptions(deviceType, capabilityId, context) {
    // The editor asks the registry for action options. Some actions are fully
    // static, while others need live API discovery before the fields can exist.
    if (capabilityId === "observe") {
        const observableDefinitions = getObservableDefinitions(deviceType);
        if (observableDefinitions.length > 0) {
            return buildObservableFields(deviceType, context);
        }
    }

    const capability = getCapabilityDefinition(deviceType, capabilityId, context && context.device);
    if (!capability || !capability.editor || !Array.isArray(capability.editor.fields) || capability.editor.fields.length === 0) {
        return {
            capabilityId,
            fields: []
        };
    }

    if (deviceType === "camera" && capabilityId === "gotoPtzPreset") {
        if (!context || !context.deviceId) {
            return {
                capabilityId,
                fields: [{
                    ...capability.editor.fields[0],
                    type: "text",
                    placeholder: "Select a camera first",
                    helpText: "Select a camera to discover available PTZ presets, or enter the slot manually."
                }]
            };
        }

        const camera = context && typeof context.fetchDevice === "function"
            ? await context.fetchDevice("camera", context.deviceId)
            : null;
        return {
            capabilityId,
            fields: [buildPtzPresetField(camera, capability.editor.fields[0])]
        };
    }

    if (deviceType === "viewer" && capabilityId === "setLiveview") {
        const liveviews = context && typeof context.fetchDevices === "function"
            ? await context.fetchDevices("liveview")
            : [];
        return {
            capabilityId,
            fields: [buildLiveviewField(liveviews, capability.editor.fields[0])]
        };
    }

    if (deviceType === "camera" && capabilityId === "setDoorbellMessage") {
        return buildDoorbellMessageFields(context, capability);
    }

    if (capabilityId === "setProperty") {
        return buildSetPropertyFields(deviceType, context, capability);
    }

    return {
        capabilityId,
        fields: capability.editor.fields.map((field) => ({ ...field }))
    };
}

function buildPathFromTemplate(pathTemplate, deviceId, params) {
    // Custom capability paths can combine the selected device id with optional
    // params such as PTZ slots or patrol numbers.
    let path = String(pathTemplate || "");

    if (path.includes(":id")) {
        if (!deviceId) {
            throw new Error("This capability requires a device id.");
        }
        path = path.replace(":id", encodeURIComponent(String(deviceId)));
    }

    Object.entries(params || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") {
            return;
        }
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
    });

    if (path.includes(":")) {
        throw new Error(`Missing required path parameters for ${path}`);
    }

    return path;
}

function normalizeDeviceCollection(deviceType, payload) {
    const definition = getDeviceTypeDefinition(deviceType);
    if (!definition) {
        return [];
    }

    if (Array.isArray(payload)) {
        return payload;
    }

    if (payload && typeof payload === "object") {
        return [payload];
    }

    return [];
}

function summarizeDevice(deviceType, device) {
    const definition = getDeviceTypeDefinition(deviceType);
    const modelKey = definition ? definition.modelKey : String(deviceType || "");
    const fallbackId = `${deviceType || "device"}`;

    return {
        id: String(device && device.id ? device.id : fallbackId),
        name: String((device && (device.name || device.displayName)) || (device && device.id) || fallbackId),
        modelKey,
        state: String((device && device.state) || ""),
        mac: String((device && device.mac) || ""),
        raw: device
    };
}

function buildPtzPresetField(camera, baseField) {
    // Prefer a friendly select when presets are discoverable; otherwise fall
    // back to free text so the action still remains usable.
    const options = extractPtzPresetOptions(camera);
    if (options.length > 0) {
        return {
            ...baseField,
            type: "select",
            options
        };
    }

    return {
        ...baseField,
        type: "text",
        placeholder: "Preset slot",
        helpText: "No preset list was discovered on this camera. Enter the PTZ preset slot manually."
    };
}

function buildLiveviewField(liveviews, baseField) {
    return {
        ...baseField,
        type: "select",
        options: buildLiveviewOptions(liveviews, baseField.allowEmpty, baseField.emptyLabel)
    };
}

function buildLiveviewOptions(liveviews, allowEmpty, emptyLabel) {
    const options = Array.isArray(liveviews)
        ? liveviews.map((liveview) => ({
            value: String(liveview && liveview.id ? liveview.id : ""),
            label: String((liveview && (liveview.name || liveview.displayName)) || (liveview && liveview.id) || "Live view")
        })).filter((option) => option.value)
        : [];

    if (allowEmpty) {
        options.unshift({
            value: "",
            label: emptyLabel || "None"
        });
    }

    return options;
}

function isCapabilitySupportedForDevice(deviceType, capability, device) {
    // Protect exposes one broad family of camera APIs, but not every camera
    // model supports every feature. Filter those actions in the editor.
    if (!capability || !device || typeof device !== "object" || Array.isArray(device)) {
        return true;
    }

    if (String(deviceType || "").trim() !== "camera") {
        return true;
    }

    if (["startPtzPatrol", "stopPtzPatrol", "gotoPtzPreset"].includes(capability.id)) {
        return isPtzCapableCamera(device);
    }

    if (capability.id === "setDoorbellMessage") {
        return isDoorbellCamera(device);
    }

    if (capability.id === "disableMicPermanently") {
        return hasCameraMicrophone(device);
    }

    return true;
}

function isPtzCapableCamera(device) {
    // Use a layered heuristic:
    // 1. explicit feature flags
    // 2. discovered presets
    // 3. model/name signature
    // 4. nested key search as last fallback
    const directValue = firstDefinedValue(device, [
        "isPtz",
        "hasPtz",
        "featureFlags.hasPtz",
        "featureFlags.isPtz",
        "ptz.isEnabled",
        "ptz.enabled",
        "ptz.canMove"
    ]);
    if (directValue !== undefined) {
        return normalizeBooleanState(directValue, false);
    }

    if (extractPtzPresetOptions(device).length > 0) {
        return true;
    }

    const signature = [
        device.type,
        device.model,
        device.modelKey,
        device.marketName,
        device.name,
        device.displayName
    ].map((value) => String(value || "").trim().toUpperCase()).join(" ");

    if (signature.includes("PTZ")) {
        return true;
    }

    return hasNestedKeyMatching(device, /ptz/i, 3);
}

function isDoorbellCamera(device) {
    if (getValueAtPath(device, "lcdMessage") !== undefined || getValueAtPath(device, "featureFlags.isDoorbell") !== undefined) {
        return true;
    }

    const directValue = firstDefinedValue(device, [
        "isDoorbell",
        "featureFlags.isDoorbell",
        "featureFlags.hasLcdScreen",
        "hasChime"
    ]);
    if (directValue !== undefined) {
        return normalizeBooleanState(directValue, false);
    }

    const signature = [
        device.type,
        device.model,
        device.modelKey,
        device.marketName,
        device.name,
        device.displayName
    ].map((value) => String(value || "").trim().toUpperCase()).join(" ");

    return signature.includes("DOORBELL");
}

function hasCameraMicrophone(device) {
    const directValue = firstDefinedValue(device, [
        "isMicEnabled",
        "micVolume",
        "speakerSettings.volume",
        "recordingSettings.isMicEnabled",
        "audioSettings.isMicEnabled"
    ]);
    return directValue !== undefined;
}

async function buildDoorbellMessageFields(context, capability) {
    // Doorbell message options are conditional: text for custom messages,
    // asset picker for image messages, and reset policy for both.
    const capabilityConfig = normalizeObject(context && context.capabilityConfig);
    const messageType = String(capabilityConfig.messageType || "DO_NOT_DISTURB").trim() || "DO_NOT_DISTURB";
    const fields = [
        {
            ...capability.editor.fields[0],
            defaultValue: messageType
        }
    ];

    if (messageType === "CUSTOM_MESSAGE") {
        fields.push({
            ...capability.editor.fields[1],
            defaultValue: capabilityConfig.messageText || ""
        });
    }

    if (messageType === "IMAGE") {
        const files = context && typeof context.fetchAssetFiles === "function"
            ? await context.fetchAssetFiles("animations")
            : [];
        fields.push({
            ...capability.editor.fields[2],
            options: buildAssetFileOptions(files),
            defaultValue: capabilityConfig.messageImage || ""
        });
    }

    fields.push({
        ...capability.editor.fields[3],
        defaultValue: capabilityConfig.resetAt !== undefined ? String(capabilityConfig.resetAt) : ""
    });

    return {
        capabilityId: capability.id,
        fields
    };
}

function buildAssetFileOptions(files) {
    return Array.isArray(files)
        ? files.map((file) => ({
            value: String(file && file.name ? file.name : ""),
            label: String((file && (file.originalName || file.name)) || "Asset")
        })).filter((option) => option.value)
        : [];
}

function buildObservableFields(deviceType, context) {
    // Observables let the generic "Receive Events" capability expose a simple
    // boolean output tailored to the selected Protect device family.
    const capabilityConfig = normalizeObject(context && context.capabilityConfig);
    const observableOptions = getObservableOptions(deviceType);
    const selectedObservable = resolveSelectedObservable(observableOptions, capabilityConfig.observable);

    return {
        capabilityId: "observe",
        fields: [
            {
                id: "observable",
                label: "Observable",
                type: "select",
                options: observableOptions,
                defaultValue: selectedObservable,
                helpText: selectedObservable
                    ? buildObservableHelpText(deviceType, selectedObservable)
                    : "Select which boolean state should be exposed on msg.payload."
            }
        ]
    };
}

async function buildSetPropertyFields(deviceType, context, capability) {
    // Property patching is driven by the live device payload so the editor can
    // list valid paths, value types and friendly labels.
    if (!context || !context.deviceId || typeof context.fetchDevice !== "function") {
        return {
            capabilityId: capability.id,
            fields: [{
                id: "propertyPath",
                label: "Property",
                type: "text",
                placeholder: "Select a device first",
                helpText: "Select a device to discover configurable properties."
            }]
        };
    }

    const device = await context.fetchDevice(deviceType, context.deviceId);
    const capabilityConfig = normalizeObject(context.capabilityConfig);
    const propertyOptions = collectConfigurablePropertyOptions(deviceType, device);
    const selectedPath = resolveSelectedPropertyPath(propertyOptions, capabilityConfig.propertyPath);
    const liveviews = deviceType === "viewer" && typeof context.fetchDevices === "function"
        ? await context.fetchDevices("liveview")
        : [];

    const fields = [
        {
            id: "propertyPath",
            label: "Property",
            type: "select",
            placeholder: "Select a property",
            reloadOnChange: true,
            options: propertyOptions,
            helpText: selectedPath
                ? buildFieldHelpText(deviceType, selectedPath, {
                    currentValueText: formatValueWithMetadata(deviceType, selectedPath, getValueAtPath(device, selectedPath))
                })
                : "Select a property to see a human-friendly label and contextual help."
        }
    ];

    if (!selectedPath) {
        return {
            capabilityId: capability.id,
            fields
        };
    }

    const fieldDefinition = buildPropertyValueFields(deviceType, device, selectedPath, capabilityConfig, {
        liveviews
    });
    return {
        capabilityId: capability.id,
        fields: fields.concat(fieldDefinition)
    };
}

function resolveSelectedPropertyPath(propertyOptions, configuredPath) {
    const normalizedPath = String(configuredPath || "").trim();
    if (!normalizedPath) {
        return "";
    }

    return propertyOptions.some((option) => option.value === normalizedPath)
        ? normalizedPath
        : "";
}

function buildPropertyValueFields(deviceType, device, propertyPath, capabilityConfig, extra) {
    const currentValue = getValueAtPath(device, propertyPath);
    const descriptor = inferPropertyDescriptor(deviceType, propertyPath, currentValue, extra);
    const currentValueText = formatValueWithMetadata(deviceType, propertyPath, currentValue);

    return [
        {
            id: "valueType",
            type: "hidden",
            defaultValue: descriptor.valueType
        },
        {
            id: "propertyValue",
            label: formatFieldLabel(deviceType, propertyPath),
            ...descriptor.field,
            defaultValue: normalizeDefaultPropertyValue(capabilityConfig.propertyValue, descriptor, currentValue),
            helpText: buildFieldHelpText(deviceType, propertyPath, {
                currentValueText
            })
        }
    ];
}

function inferPropertyDescriptor(deviceType, propertyPath, currentValue, extra) {
    if (deviceType === "viewer" && propertyPath === "liveview") {
        return {
            valueType: "string",
            field: {
                type: "select",
                allowEmpty: true,
                emptyLabel: "No live view",
                options: buildLiveviewOptions(extra && extra.liveviews, true, "No live view")
            }
        };
    }

    if (deviceType === "camera" && propertyPath === "lcdMessage.type") {
        return {
            valueType: "string",
            field: {
                type: "select",
                options: [
                    { value: "DO_NOT_DISTURB", label: "Do not disturb" },
                    { value: "LEAVE_PACKAGE_AT_DOOR", label: "Leave package at door" },
                    { value: "CUSTOM_MESSAGE", label: "Custom message" },
                    { value: "IMAGE", label: "Image" }
                ]
            }
        };
    }

    if (typeof currentValue === "boolean") {
        return {
            valueType: "boolean",
            field: {
                type: "select",
                options: [
                    { value: "true", label: "True" },
                    { value: "false", label: "False" }
                ]
            }
        };
    }

    if (typeof currentValue === "number") {
        return {
            valueType: "number",
            field: {
                type: "number"
            }
        };
    }

    if (currentValue === null) {
        return {
            valueType: "nullish-string",
            field: {
                type: "text",
                placeholder: "Value"
            }
        };
    }

    return {
        valueType: "string",
        field: {
            type: "text",
            placeholder: "Value"
        }
    };
}

function normalizeDefaultPropertyValue(configuredValue, descriptor, currentValue) {
    if (configuredValue !== undefined && configuredValue !== null && configuredValue !== "") {
        return configuredValue;
    }

    if (descriptor.valueType === "boolean") {
        return currentValue === true ? "true" : "false";
    }

    if (descriptor.valueType === "number" && typeof currentValue === "number") {
        return String(currentValue);
    }

    if (currentValue === null || currentValue === undefined) {
        return "";
    }

    return typeof currentValue === "string"
        ? currentValue
        : String(currentValue);
}

function collectConfigurablePropertyOptions(deviceType, device) {
    const collected = [];
    const visited = new Set();

    function walk(value, pathSegments) {
        if (value && typeof value === "object") {
            if (visited.has(value)) {
                return;
            }
            visited.add(value);
        }

        if (pathSegments.length > 0 && isPrimitivePatchValue(value) && isConfigurablePath(pathSegments)) {
            const path = pathSegments.join(".");
            collected.push({
                value: path,
                label: `${formatFieldLabel(deviceType, path)} (${formatValueWithMetadata(deviceType, path, value)})`
            });
        }

        if (!value || typeof value !== "object" || Array.isArray(value) || pathSegments.length >= 4) {
            return;
        }

        Object.entries(value).forEach(([key, nestedValue]) => {
            walk(nestedValue, pathSegments.concat(key));
        });
    }

    walk(device, []);

    return deduplicateOptions(collected)
        .sort((left, right) => left.label.localeCompare(right.label))
        .filter((option) => filterPropertyOption(deviceType, option.value));
}

function filterPropertyOption(deviceType, propertyPath) {
    if (deviceType === "viewer" && propertyPath === "liveview") {
        return true;
    }

    if (deviceType === "camera" && propertyPath.startsWith("lcdMessage.")) {
        return true;
    }

    return true;
}

function isPrimitivePatchValue(value) {
    return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isConfigurablePath(pathSegments) {
    const lastSegment = String(pathSegments[pathSegments.length - 1] || "");
    const normalizedPath = pathSegments.join(".");
    const lowerSegments = pathSegments.map((segment) => String(segment).toLowerCase());
    const readonlyNames = new Set([
        "id", "modelkey", "type", "state", "mac", "host", "guid", "serial", "version",
        "hardwarerevision", "firmwareversion", "lastseen", "connectedsince", "uptime",
        "marketname", "ip", "bridge", "bluetoothconnectionstate", "wificonnectionstate",
        "connectionstate", "isconnected", "isadopted", "isattemptingtoconnect", "isupdating"
    ]);

    if (readonlyNames.has(lastSegment.toLowerCase())) {
        return false;
    }

    if (lowerSegments.some((segment) => readonlyNames.has(segment))) {
        return false;
    }

    if (lowerSegments.some((segment) => /stats?$|channels?$|zones?$|features?$|capabilities?$|permissions?$|events?$/.test(segment))) {
        return false;
    }

    if (/\.\d+(\.|$)/.test(normalizedPath)) {
        return false;
    }

    return true;
}

function deduplicateOptions(options) {
    const seen = new Map();
    options.forEach((option) => {
        if (!seen.has(option.value)) {
            seen.set(option.value, option);
        }
    });
    return Array.from(seen.values());
}

function getValueAtPath(value, propertyPath) {
    return String(propertyPath || "").split(".").filter(Boolean).reduce((current, segment) => {
        if (!current || typeof current !== "object") {
            return undefined;
        }
        return current[segment];
    }, value);
}

function buildNestedPatchPayload(propertyPath, propertyValue) {
    const segments = String(propertyPath || "").split(".").filter(Boolean);
    if (segments.length === 0) {
        return {};
    }

    const payload = {};
    let cursor = payload;

    segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
            cursor[segment] = propertyValue;
            return;
        }

        cursor[segment] = {};
        cursor = cursor[segment];
    });

    return payload;
}

function parseConfiguredPropertyValue(value, valueType) {
    if (valueType === "boolean") {
        return value === true || value === "true";
    }

    if (valueType === "number") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    return value;
}

function buildDoorbellMessagePayload(capabilityConfig) {
    const messageType = String(capabilityConfig.messageType || "").trim();
    const payload = {
        type: messageType || "DO_NOT_DISTURB"
    };

    const resetAtValue = parseResetAtValue(capabilityConfig.resetAt);
    if (resetAtValue !== undefined) {
        payload.resetAt = resetAtValue;
    }

    if (payload.type === "CUSTOM_MESSAGE") {
        payload.text = String(capabilityConfig.messageText || "").trim();
    }

    if (payload.type === "IMAGE") {
        payload.text = String(capabilityConfig.messageImage || "").trim();
    }

    return payload;
}

function parseResetAtValue(value) {
    const normalized = String(value === undefined || value === null ? "" : value).trim();
    if (normalized === "") {
        return undefined;
    }
    if (normalized.toLowerCase() === "null") {
        return null;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function getObservableDefinitions(deviceType) {
    const definitionsByDeviceType = {
        sensor: SENSOR_OBSERVABLE_DEFINITIONS,
        camera: CAMERA_OBSERVABLE_DEFINITIONS,
        light: LIGHT_OBSERVABLE_DEFINITIONS
    };

    return definitionsByDeviceType[String(deviceType || "").trim()] || [];
}

function getObservableOptions(deviceType) {
    return getObservableDefinitions(deviceType).map((definition) => ({
        value: definition.id,
        label: formatObservableLabel(deviceType, definition.id, definition.label)
    }));
}

function resolveSelectedObservable(options, configuredObservable) {
    const normalized = String(configuredObservable || "").trim();
    if (normalized && options.some((option) => option.value === normalized)) {
        return normalized;
    }

    return options.length > 0 ? options[0].value : "";
}

function resolveObservableState(deviceType, device, observable, fallbackValue) {
    if (deviceType === "sensor") {
        return resolveSensorObservableState(device, observable, fallbackValue);
    }

    if (deviceType === "camera") {
        return resolveCameraObservableState(device, observable, fallbackValue);
    }

    if (deviceType === "light") {
        return resolveLightObservableState(device, observable, fallbackValue);
    }

    return fallbackValue;
}

function resolveSensorObservableState(sensor, observable, fallbackValue) {
    const definition = getObservableDefinitions("sensor").find((entry) => entry.id === observable);
    if (!definition) {
        return fallbackValue;
    }

    const directValueResolvers = {
        contact: () => firstDefinedValue(sensor, [
            "isOpened",
            "opened",
            "open",
            "status.isOpened",
            "stats.isOpened"
        ]),
        motion: () => firstDefinedValue(sensor, [
            "isMotionDetected",
            "motionDetected",
            "status.motionDetected"
        ]),
        alarm: () => firstDefinedValue(sensor, [
            "isAlarmDetected",
            "alarmDetected",
            "status.alarmDetected"
        ]),
        waterLeak: () => firstDefinedValue(sensor, [
            "isWaterLeakDetected",
            "waterLeakDetected",
            "status.waterLeakDetected"
        ]),
        batteryLow: () => {
            const direct = firstDefinedValue(sensor, [
                "isBatteryLow",
                "batteryLow",
                "status.batteryLow"
            ]);
            if (direct !== undefined) {
                return direct;
            }

            const batteryStatus = firstDefinedValue(sensor, ["batteryStatus", "status.batteryStatus"]);
            if (typeof batteryStatus === "string") {
                return ["low", "critical"].includes(batteryStatus.toLowerCase());
            }

            return undefined;
        },
        tamper: () => firstDefinedValue(sensor, [
            "isTampered",
            "tampered",
            "status.tampered"
        ]),
        smokeTest: () => firstDefinedValue(sensor, [
            "isSmokeTestRunning",
            "smokeTestRunning",
            "status.smokeTestRunning"
        ]),
        extremeValues: () => firstDefinedValue(sensor, [
            "isExtremeValuesDetected",
            "extremeValuesDetected",
            "status.extremeValuesDetected",
            "isExtremeValueDetected",
            "extremeValueDetected",
            "status.extremeValueDetected"
        ])
    };

    const rawValue = typeof directValueResolvers[observable] === "function"
        ? directValueResolvers[observable]()
        : undefined;

    if (rawValue === undefined) {
        return fallbackValue;
    }

    return normalizeBooleanState(rawValue, fallbackValue);
}

function resolveCameraObservableState(camera, observable, fallbackValue) {
    const definition = getObservableDefinitions("camera").find((entry) => entry.id === observable);
    if (!definition) {
        return fallbackValue;
    }

    const directValueResolvers = {
        ring: () => firstDefinedValue(camera, ["isRinging", "ringing", "status.ringing"]),
        motion: () => firstDefinedValue(camera, ["isMotionDetected", "motionDetected", "status.motionDetected"]),
        smartAudioDetect: () => firstDefinedValue(camera, ["isSmartAudioDetected", "smartAudioDetected", "status.smartAudioDetected"]),
        smartDetectZone: () => firstDefinedValue(camera, ["isSmartDetecting", "smartDetecting", "status.smartDetecting"]),
        smartDetectLine: () => firstDefinedValue(camera, ["isSmartDetecting", "smartDetecting", "status.smartDetecting"]),
        smartDetectLoiterZone: () => firstDefinedValue(camera, ["isSmartDetecting", "smartDetecting", "status.smartDetecting"])
    };

    const rawValue = typeof directValueResolvers[observable] === "function"
        ? directValueResolvers[observable]()
        : undefined;

    if (rawValue === undefined) {
        return fallbackValue;
    }

    return normalizeBooleanState(rawValue, fallbackValue);
}

function resolveLightObservableState(light, observable, fallbackValue) {
    const definition = getObservableDefinitions("light").find((entry) => entry.id === observable);
    if (!definition) {
        return fallbackValue;
    }

    const directValueResolvers = {
        motion: () => firstDefinedValue(light, ["isMotionDetected", "motionDetected", "status.motionDetected"]),
        lightOn: () => firstDefinedValue(light, ["isLightOn", "lightOn", "status.lightOn", "isOn", "on"])
    };

    const rawValue = typeof directValueResolvers[observable] === "function"
        ? directValueResolvers[observable]()
        : undefined;

    if (rawValue === undefined) {
        return fallbackValue;
    }

    return normalizeBooleanState(rawValue, fallbackValue);
}

function resolveObservableEventValue(deviceType, event, observable) {
    if (deviceType === "sensor") {
        return resolveSensorObservableEventValue(event, observable);
    }

    if (deviceType === "camera") {
        return resolveCameraObservableEventValue(event, observable);
    }

    if (deviceType === "light") {
        return resolveLightObservableEventValue(event, observable);
    }

    return { matched: false };
}

function resolveSensorObservableEventValue(event, observable) {
    if (!event || typeof event !== "object") {
        return { matched: false };
    }

    const eventType = String(event.type || "").trim();
    if (!eventType) {
        return { matched: false };
    }

    if (observable === "contact") {
        if (eventType === "sensorOpened") {
            return { matched: true, value: true };
        }
        if (eventType === "sensorClosed") {
            return { matched: true, value: false };
        }
        return { matched: false };
    }

    const definition = SENSOR_OBSERVABLE_DEFINITIONS.find((entry) => entry.id === observable);
    if (!definition || !definition.eventTypes.includes(eventType)) {
        return { matched: false };
    }

    return {
        matched: true,
        value: event.end === null || event.end === undefined
    };
}

function resolveCameraObservableEventValue(event, observable) {
    if (!event || typeof event !== "object") {
        return { matched: false };
    }

    const eventType = String(event.type || "").trim();
    const definition = getObservableDefinitions("camera").find((entry) => entry.id === observable);
    if (!definition || !definition.eventTypes.includes(eventType)) {
        return { matched: false };
    }

    return {
        matched: true,
        value: event.end === null || event.end === undefined
    };
}

function resolveLightObservableEventValue(event, observable) {
    if (!event || typeof event !== "object") {
        return { matched: false };
    }

    const eventType = String(event.type || "").trim();
    if (observable === "motion" && eventType === "lightMotion") {
        return {
            matched: true,
            value: event.end === null || event.end === undefined
        };
    }

    return { matched: false };
}

function normalizeBooleanState(value, fallbackValue) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value > 0;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "on", "open", "opened", "active", "detected", "alarm", "running", "low", "critical"].includes(normalized)) {
            return true;
        }
        if (["false", "off", "closed", "inactive", "normal", "ok"].includes(normalized)) {
            return false;
        }
    }

    return fallbackValue;
}

function firstDefinedValue(value, paths) {
    for (const path of paths) {
        const current = getValueAtPath(value, path);
        if (current !== undefined) {
            return current;
        }
    }
    return undefined;
}

function extractPtzPresetOptions(camera) {
    const optionsByValue = new Map();
    const visited = new Set();

    function addOption(slotValue, labelValue) {
        const value = slotValue === undefined || slotValue === null ? "" : String(slotValue).trim();
        if (!value || !/^-?\d+$/.test(value)) {
            return;
        }

        if (!optionsByValue.has(value)) {
            optionsByValue.set(value, {
                value,
                label: String(labelValue || `Preset ${value}`).trim() || `Preset ${value}`
            });
        }
    }

    function walk(value, pathSegments) {
        if (!value || typeof value !== "object" || visited.has(value)) {
            return;
        }
        visited.add(value);

        const inPresetBranch = pathSegments.some((segment) => /preset/i.test(segment));

        if (Array.isArray(value)) {
            if (inPresetBranch) {
                value.forEach((entry) => {
                    const slot = getPresetSlot(entry);
                    if (slot !== null) {
                        addOption(slot, getPresetLabel(entry, slot));
                    }
                });
            }

            value.forEach((entry, index) => {
                walk(entry, pathSegments.concat(String(index)));
            });
            return;
        }

        if (inPresetBranch) {
            Object.entries(value).forEach(([key, entry]) => {
                if (/^-?\d+$/.test(String(key))) {
                    addOption(key, getPresetLabel(entry, key));
                }

                const slot = getPresetSlot(entry);
                if (slot !== null) {
                    addOption(slot, getPresetLabel(entry, slot));
                }
            });
        }

        Object.entries(value).forEach(([key, entry]) => {
            walk(entry, pathSegments.concat(key));
        });
    }

    walk(camera, []);

    return Array.from(optionsByValue.values()).sort((left, right) => Number(left.value) - Number(right.value));
}

function getPresetSlot(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }

    const candidateKeys = ["slot", "presetSlot", "slotId", "presetIndex", "index"];
    for (const key of candidateKeys) {
        if (entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== "") {
            return entry[key];
        }
    }

    return null;
}

function getPresetLabel(entry, fallbackValue) {
    if (!entry || typeof entry !== "object") {
        return `Preset ${fallbackValue}`;
    }

    const candidateKeys = ["name", "displayName", "label", "presetName"];
    for (const key of candidateKeys) {
        if (entry[key] !== undefined && entry[key] !== null && String(entry[key]).trim() !== "") {
            return entry[key];
        }
    }

    return `Preset ${fallbackValue}`;
}

function hasNestedKeyMatching(value, pattern, maxDepth) {
    const visited = new Set();

    function walk(current, depth) {
        if (!current || typeof current !== "object" || visited.has(current) || depth > maxDepth) {
            return false;
        }
        visited.add(current);

        return Object.entries(current).some(([key, nestedValue]) => {
            if (pattern.test(String(key || ""))) {
                return true;
            }

            return walk(nestedValue, depth + 1);
        });
    }

    return walk(value, 0);
}

function normalizeObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}

module.exports = {
    getDeviceTypes,
    getDeviceTypeDefinition,
    getCapabilitiesForType,
    getCapabilityDefinition,
    buildDevicePath,
    buildCapabilityRequest,
    composeCapabilityExecution,
    getCapabilityOptions,
    getObservableOptions,
    resolveObservableState,
    resolveObservableEventValue,
    normalizeDeviceCollection,
    summarizeDevice
};
