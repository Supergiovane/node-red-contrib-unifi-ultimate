"use strict";

const {
    getDeviceTypeDefinition,
    getCapabilityDefinition,
    buildCapabilityRequest,
    composeCapabilityExecution,
    resolveObservableState,
    resolveObservableEventValue
} = require("./utils/unifi-protect-device-registry");
const {
    parseBoolean,
    parseIntervalSeconds,
    buildStatusTimestampText,
    appendStatusTimestamp,
    resolveNodeName,
    resolveDeviceName,
    extractDeviceNameFromPayload,
    attachDeviceNameToPayload,
    attachDetails,
    buildErrorOutputMessage,
    sendWithPayload,
    hasPayloadValue
} = require("./utils/common-utils");
const { parseKnownPlates, namePlate, matchesDetection, describeDetection } = require("./utils/unifi-protect-detections");
const { LICENSE_PLATE_EVENT_TYPES, extractLicensePlates, isLicensePlateEvent } = require("./utils/unifi-protect-lpr");
const { readAlarmState, matchesDeviceUpdate, mergeDeviceUpdate, buildRequestError } = require("./utils/unifi-protect-alarm");
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const LPR_FOLLOW_UP_DELAYS_MS = [150, 350, 750, 1500, 3000];

function resolveDeviceType(configuredDeviceType) {
    return String(configuredDeviceType || "").trim();
}

function resolveDeviceId(configuredDeviceId) {
    return String(configuredDeviceId || "").trim();
}

function resolveCapabilityId(configuredCapabilityId) {
    return String(configuredCapabilityId || "observe").trim();
}

function parseCapabilityConfig(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }

    if (typeof value !== "string" || value.trim() === "") {
        return {};
    }

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch (error) {
        return {};
    }
}

function resolveCapabilityConfig(configuredCapabilityConfig) {
    return parseCapabilityConfig(configuredCapabilityConfig);
}

function buildNodeStatus(deviceType, payload) {
    const label = payload && payload.name ? payload.name : deviceType;
    const state = payload && payload.state ? payload.state : "ready";
    return `${label} ${state}`;
}

function requiresDeviceSpecificCapabilityValidation(deviceType, capabilityId) {
    // Some camera actions only make sense on specific hardware variants, so the
    // registry needs the live device payload before validating them.
    return String(deviceType || "").trim() === "camera" && [
        "startPtzPatrol",
        "stopPtzPatrol",
        "gotoPtzPreset",
        "setDoorbellMessage",
        "disableMicPermanently"
    ].includes(String(capabilityId || "").trim());
}

function resolveConfiguredObservable(capabilityConfig) {
    const observable = String(
        capabilityConfig && capabilityConfig.observable !== undefined
            ? capabilityConfig.observable
            : ""
    ).trim();
    return observable.toLowerCase() === "all" ? "" : observable;
}

function resolveConfiguredObservableScope(capabilityConfig) {
    return String(
        capabilityConfig && capabilityConfig.observableScopeId !== undefined
            ? capabilityConfig.observableScopeId
            : ""
    ).trim();
}

module.exports = function(RED) {
    function UnifiProtectDeviceNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        node.name = config.name;
        node.server = RED.nodes.getNode(config.server);
        node.deviceType = config.deviceType || "";
        node.deviceId = config.deviceId || "";
        node.capability = config.capability || "observe";
        node.capabilityConfig = config.capabilityConfig || "{}";
        node.emitStartupAndUndefined = parseBoolean(config.emitStartupAndUndefined);
        node.autoEmit = parseBoolean(config.autoEmit);
        node.autoEmitIntervalSeconds = parseIntervalSeconds(config.autoEmitInterval, 60);
        node.autoEmitTimer = null;
        node.autoEmitInFlight = false;
        node.deviceName = resolveDeviceName(config.deviceName);
        node.timeout = DEFAULT_REQUEST_TIMEOUT_MS;
        node.currentDevice = null;
        node.currentObservableValue = undefined;
        node.isObserving = false;
        const lprEventStates = new Map();
        let lprCredentialsWarningSent = false;
        const photoStates = new Map();
        const photoQueue = [];
        let photoInFlight = 0;
        let closed = false;
        const isPhotoObservation = () => node.deviceType === "camera" && node.capability === "observeWithImage";

        function isLicensePlateObservation() {
            return node.deviceType === "camera" && node.capability === "observe"
                && resolveConfiguredObservable(parseCapabilityConfig(node.capabilityConfig)) === "licensePlate";
        }

        if (isLicensePlateObservation() || isPhotoObservation()) node.protectStreams = ["events"];

        function setNodeStatus(status) {
            if (!status || typeof status !== "object" || Array.isArray(status)) {
                return;
            }
            node.status({
                ...status,
                text: appendStatusTimestamp(status.text)
            });
        }

        function protectErrorOutput(error) {
            const message = buildErrorOutputMessage(error, node.name);
            if (error.protectResponse) attachDetails(message, { response: error.protectResponse });
            return message;
        }

        function resolveOutputDeviceName(payload) {
            const extracted = extractDeviceNameFromPayload(payload);
            if (extracted) {
                node.deviceName = extracted;
                return extracted;
            }

            return resolveDeviceName(node.deviceName) || extractDeviceNameFromPayload(node.currentDevice);
        }

        function decorateOutputMessage(outputMsg, payload, eventName) {
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(payload);
            outputMsg.topic = nodeName;
            outputMsg.deviceName = resolvedDeviceName || undefined;
            outputMsg.eventName = String(eventName || "").trim() || undefined;
            outputMsg.payload = attachDeviceNameToPayload(outputMsg.payload, resolvedDeviceName);
        }

        function sendOutputs(send, stateMsg, eventMsg) {
            // Protect now emits on a single output pin. When both state and
            // event messages are available, forward them in sequence.
            try {
                if (stateMsg) {
                    sendWithPayload(send, stateMsg, node.emitStartupAndUndefined);
                }
                if (eventMsg) {
                    sendWithPayload(send, eventMsg, node.emitStartupAndUndefined);
                }
            } catch (error) {
                node.warn(`Protect output send failed: ${error && error.message ? error.message : error}`);
            }
        }

        function buildBaseMetadata(deviceType, deviceId, capabilityId, extra) {
            const nodeName = resolveNodeName(node.name);
            const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
            return {
                nodeType: "device",
                name: nodeName || undefined,
                deviceName: resolvedDeviceName || undefined,
                deviceType,
                deviceId,
                capability: capabilityId,
                ...(extra || {})
            };
        }

        function buildObservedStateMessage(deviceType, deviceId, capabilityConfig, payload, source, extra, eventName) {
            const resolvedDeviceName = resolveOutputDeviceName(payload);
            const observable = resolveConfiguredObservable(capabilityConfig);
            if (observable) {
                // Observables let the node collapse complex Protect payloads into
                // a stable typed value while preserving the original context in details.raw.
                const observableValue = resolveObservableState(deviceType, payload, observable);
                if (!node.emitStartupAndUndefined && !hasPayloadValue(observableValue)) return null;
                node.currentObservableValue = observableValue;

                const outputMsg = {
                    payload: node.currentObservableValue,
                    topic: resolveNodeName(node.name),
                    deviceName: resolvedDeviceName || undefined,
                    eventName: String(eventName || source || "observe").trim() || undefined
                };
                attachDetails(outputMsg, {
                    raw: {
                        device: payload,
                        observable,
                        source: source || "observe",
                        ...(extra || {})
                    },
                    device: payload,
                    unifiProtect: buildBaseMetadata(deviceType, deviceId, "observe", {
                        source: source || "observe",
                        observable,
                        ...(extra || {})
                    })
                });
                return outputMsg;
            }

            const outputMsg = {
                payload: attachDeviceNameToPayload(payload, resolvedDeviceName),
                topic: resolveNodeName(node.name),
                deviceName: resolvedDeviceName || undefined,
                eventName: String(eventName || source || "observe").trim() || undefined
            };
            attachDetails(outputMsg, {
                device: payload,
                unifiProtect: buildBaseMetadata(deviceType, deviceId, "observe", { source: source || "observe", ...(extra || {}) })
            });
            return outputMsg;
        }

        async function fetchDeviceState(deviceType, deviceId, capabilityConfig, send, source) {
            const payload = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
            node.currentDevice = payload;

            if (isPhotoObservation()) {
                parseKnownPlates(capabilityConfig.knownPlates);
                matchesDetection(null, capabilityConfig.detectionType || "all");
                setNodeStatus({ fill: "green", shape: "dot", text: "waiting for event photo" });
                return;
            }
            if (isLicensePlateObservation()) {
                parseKnownPlates(capabilityConfig.knownPlates);
                // Camera state has no plate text. Do not emit undefined or
                // replay the last plate during startup/manual refresh.
                setNodeStatus({ fill: "green", shape: "dot", text: "waiting for license plate" });
                return;
            }

            const stateMsg = buildObservedStateMessage(deviceType, deviceId, capabilityConfig, payload, source);

            setNodeStatus({ fill: "green", shape: "dot", text: buildNodeStatus(deviceType, payload) });
            if (source === "startup" && !node.emitStartupAndUndefined) return;
            sendOutputs(send, stateMsg, null);
        }

        async function invokeCapability(send, triggerSource) {
            if (!node.server) {
                throw new Error("Unifi Protect configuration is missing.");
            }

            // The incoming message is only a trigger. The node always uses the
            // device, capability and options configured in the editor.
            const deviceType = resolveDeviceType(node.deviceType);
            const deviceId = resolveDeviceId(node.deviceId);
            const capabilityId = resolveCapabilityId(node.capability);
            const capabilityConfig = resolveCapabilityConfig(node.capabilityConfig);
            let selectedDevice = node.currentDevice;
            if (!getDeviceTypeDefinition(deviceType)) {
                throw new Error(`Unsupported device type: ${deviceType || "(empty)"}`);
            }

            if (requiresDeviceSpecificCapabilityValidation(deviceType, capabilityId) && deviceId) {
                selectedDevice = await node.server.fetchDeviceByTypeAndId(deviceType, deviceId);
                if (selectedDevice && typeof selectedDevice === "object" && !Array.isArray(selectedDevice)) {
                    node.currentDevice = selectedDevice;
                }
            }

            const capability = getCapabilityDefinition(deviceType, capabilityId, selectedDevice);
            if (!capability) {
                throw new Error(`Unsupported capability '${capabilityId}' for device type '${deviceType}'.`);
            }

            if (capabilityId === "getRecentDetections") {
                const result = await node.server.readRecentDetections(deviceId, capabilityConfig);
                if (closed) return;
                const output = { payload: result.events };
                decorateOutputMessage(output, node.currentDevice, "recentDetections");
                const { events, ...history } = result;
                attachDetails(output, { history, unifiProtect: buildBaseMetadata(deviceType, deviceId, capabilityId, { source: "history" }) });
                setNodeStatus({ fill: result.hasMore ? "yellow" : "green", shape: "dot", text: `${events.length} detections${result.hasMore ? "; more available" : ""}` });
                sendWithPayload(send, output, node.emitStartupAndUndefined);
                return;
            }

            if (capability.mode === "observe") {
                // Manual input on an observe node acts like a forced refresh.
                await fetchDeviceState(deviceType, deviceId, capabilityConfig, send, triggerSource || "manual-refresh");
                return;
            }

            const execution = composeCapabilityExecution(deviceType, capabilityId, capabilityConfig, selectedDevice);
            const request = buildCapabilityRequest(deviceType, capabilityId, deviceId, execution.params, selectedDevice);

            setNodeStatus({ fill: "blue", shape: "dot", text: `${capability.label}` });

            const response = await node.server.executeProtectRequest({
                path: request.path,
                method: request.method,
                query: execution.query,
                headers: execution.headers,
                payload: execution.payload,
                timeout: node.timeout
            });

            if (response.statusCode < 200 || response.statusCode >= 300) {
                setNodeStatus({ fill: "yellow", shape: "ring", text: `${response.statusCode}` });
                const secrets = Object.values(node.server.credentials || {});
                if (typeof node.server.getApiKey === "function") secrets.push(node.server.getApiKey());
                throw buildRequestError(response, request.method, request.path, secrets);
            }

            if (response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)) {
                node.currentDevice = response.payload;
            }

            const stateMsg = {
                payload: response.payload
            };
            decorateOutputMessage(stateMsg, response.payload, `request:${capabilityId}`);
            if (capabilityId === "getAlarmState") {
                const alarmState = readAlarmState(deviceType, response.payload);
                if (alarmState === undefined) {
                    throw new Error(`The ${deviceType} response has no supported alarm state. Check the Protect version and alarm mode; missing state does not mean disarmed.`);
                }
                stateMsg.payload = alarmState;
            }
            attachDetails(stateMsg, {
                response: {
                    statusCode: response.statusCode,
                    headers: response.headers,
                    method: request.method,
                    path: request.path
                },
                capabilityConfig,
                device: node.currentDevice,
                unifiProtect: buildBaseMetadata(deviceType, deviceId, capabilityId, {
                    source: "request",
                    method: request.method,
                    path: request.path,
                    capabilityConfig
                })
            });

            setNodeStatus({ fill: "green", shape: "dot", text: `${capability.label}` });
            sendOutputs(send, stateMsg, null);
        }

        function resolveConfiguredCapabilityDefinition() {
            const deviceType = resolveDeviceType(node.deviceType);
            const capabilityId = resolveCapabilityId(node.capability);
            return getCapabilityDefinition(deviceType, capabilityId, node.currentDevice);
        }

        function configuredCapabilityOpensEventStream() {
            const capability = resolveConfiguredCapabilityDefinition();
            if (capability) {
                return capability.opensEventStream === true;
            }
            return resolveCapabilityId(node.capability) === "observe";
        }

        function configuredCapabilitySupportsAutoEmit() {
            const capability = resolveConfiguredCapabilityDefinition();
            if (!capability || capability.opensEventStream === true) {
                return false;
            }

            const method = String(capability.method || "").trim().toUpperCase();
            return !method || method === "GET";
        }

        function shouldObserveConfiguredDevice() {
            return node.server && configuredCapabilityOpensEventStream() && node.deviceType && node.deviceId;
        }

        function startObservation() {
            if (!shouldObserveConfiguredDevice() || node.isObserving) {
                return;
            }

            // Re-register the node to make sure the active websocket fan-out on
            // the config node uses the latest node instance.
            if (node.server && typeof node.server.removeClient === "function") {
                node.server.removeClient(node);
            }
            if (node.server && typeof node.server.addClient === "function") {
                node.server.addClient(node);
            }
            node.isObserving = true;
            if (isLicensePlateObservation() && typeof node.server.prepareLicensePlateSession === "function") {
                node.server.prepareLicensePlateSession().catch((error) => {
                    if (!node.isObserving) return;
                    if (error.code === "UNIFI_PROTECT_HISTORY_CREDENTIALS_REQUIRED") {
                        if (lprCredentialsWarningSent) return;
                        lprCredentialsWarningSent = true;
                    }
                    reportLicensePlateError(error);
                });
            }

            fetchDeviceState(node.deviceType, node.deviceId, parseCapabilityConfig(node.capabilityConfig), node.send.bind(node), "startup").catch((error) => {
                if (node.isObserving && (isPhotoObservation() || isLicensePlateObservation() || node.deviceType === "alarmHub" || node.deviceType === "nvr")) {
                    setNodeStatus({ fill: "red", shape: "ring", text: "check camera configuration" });
                    if (node.deviceType === "alarmHub" || node.deviceType === "nvr") setNodeStatus({ fill: "red", shape: "ring", text: "alarm state unavailable" });
                    node.send([null, protectErrorOutput(error)]);
                }
            });
        }

        function stopAutoEmitTimer() {
            if (node.autoEmitTimer) {
                clearInterval(node.autoEmitTimer);
                node.autoEmitTimer = null;
            }
            node.autoEmitInFlight = false;
        }

        function shouldStartAutoEmitTimer() {
            return Boolean(
                node.server
                && node.autoEmit
                && node.deviceType
                && node.deviceId
                && configuredCapabilitySupportsAutoEmit()
            );
        }

        function runAutoEmit() {
            if (node.autoEmitInFlight || !shouldStartAutoEmitTimer()) {
                return;
            }

            node.autoEmitInFlight = true;
            invokeCapability(node.send.bind(node), "interval")
                .catch((error) => {
                    setNodeStatus({ fill: "red", shape: "ring", text: "auto error" });
                    node.send([null, protectErrorOutput(error)]);
                    node.error(error);
                })
                .finally(() => {
                    node.autoEmitInFlight = false;
                });
        }

        function startAutoEmitTimer() {
            stopAutoEmitTimer();
            if (!shouldStartAutoEmitTimer()) {
                return;
            }

            node.autoEmitTimer = setInterval(runAutoEmit, node.autoEmitIntervalSeconds * 1000);
            setNodeStatus({ fill: "grey", shape: "ring", text: `every ${node.autoEmitIntervalSeconds}s` });
        }

        node.on("input", async function(_msg, send, done) {
            send = send || function() {
                node.send.apply(node, arguments);
            };

            try {
                await invokeCapability(send, "manual-refresh");
                if (typeof done === "function") {
                    done();
                }
            } catch (error) {
                setNodeStatus({ fill: "red", shape: "ring", text: "error" });
                node.send([null, protectErrorOutput(error)]);
                if (typeof done === "function") {
                    done(error);
                } else {
                    node.error(error);
                }
            }
        });

        node.handleProtectDeviceUpdate = (update) => {
            try {
                const item = update && update.item;
                if (!item || !node.isObserving) {
                    return;
                }

                // Only react to device updates that match both the selected
                // model family and the exact configured device id.
                const deviceDefinition = getDeviceTypeDefinition(node.deviceType);
                const alarmDevice = node.deviceType === "alarmHub" || node.deviceType === "nvr";
                if (!deviceDefinition || (alarmDevice
                    ? !matchesDeviceUpdate(node.deviceType, node.deviceId, item, deviceDefinition.modelKey)
                    : item.modelKey !== deviceDefinition.modelKey || item.id !== node.deviceId)) {
                    return;
                }

                if (alarmDevice && ["remove", "delete"].includes(update.type)) {
                    node.currentDevice = null;
                    node.currentObservableValue = undefined;
                    setNodeStatus({ fill: "yellow", shape: "ring", text: "device removed" });
                    return;
                }
                node.currentDevice = alarmDevice ? mergeDeviceUpdate(node.currentDevice, item) : item;
                if (isLicensePlateObservation() || isPhotoObservation()) return;
                const capabilityConfig = parseCapabilityConfig(node.capabilityConfig);
                const observable = resolveConfiguredObservable(capabilityConfig);
                // An unrelated partial update must not replay an old alarm value.
                if ((node.deviceType === "alarmHub" && observable === "armed" && !(item.alarmHub && Object.prototype.hasOwnProperty.call(item.alarmHub, "armed")))
                    || (node.deviceType === "nvr" && observable === "armStatus" && !(item.armMode && Object.prototype.hasOwnProperty.call(item.armMode, "status")))) return;
                setNodeStatus({ fill: "green", shape: "dot", text: buildNodeStatus(node.deviceType, item) });
                sendOutputs(node.send.bind(node), buildObservedStateMessage(
                    node.deviceType,
                    node.deviceId,
                    capabilityConfig,
                    node.currentDevice,
                    "devices",
                    { updateType: update.type || "" },
                    update.type || "devices"
                ), null);
            } catch (error) {
            }
        };

        function reportLicensePlateError(error) {
            if (!node.isObserving) return;
            setNodeStatus({ fill: "red", shape: "ring", text: "LPR error" });
            node.send([null, buildErrorOutputMessage(error, node.name)]);
            node.error(error);
        }

        function forgetLicensePlateEvent(id) {
            const state = lprEventStates.get(id);
            if (state && state.timer) clearTimeout(state.timer);
            lprEventStates.delete(id);
        }

        function isLicensePlateStateActive(state) {
            return node.isObserving && lprEventStates.get(state.latestEvent.id) === state;
        }

        function emitLicensePlateReadings(state, event, updateType) {
            const plates = extractLicensePlates(event);
            if (!plates.length) return false;
            const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
            const knownPlates = parseKnownPlates(parseCapabilityConfig(node.capabilityConfig).knownPlates);
            plates.forEach((rawPlate) => {
                const plate = namePlate(rawPlate, knownPlates);
                const key = plate.text.toUpperCase();
                const previous = state.emitted.get(key);
                const confidenceImproved = previous && typeof plate.confidence === "number"
                    && (typeof previous.confidence !== "number" || plate.confidence > previous.confidence);
                if (previous && !confidenceImproved) return;
                const isUpdate = state.emitted.size > 0;
                state.emitted.set(key, plate);
                node.currentObservableValue = plate.text;
                const outputMsg = {
                    payload: plate.text,
                    topic: resolveNodeName(node.name),
                    deviceName: resolvedDeviceName || undefined,
                    eventName: "licensePlate",
                    knownPlate: plate.known,
                    plateName: plate.name
                };
                attachDetails(outputMsg, {
                    lpr: { ...plate, eventId: event.id, start: event.start, end: event.end,
                        isUpdate },
                    raw: { device: node.currentDevice, event, observable: "licensePlate", source: "events" },
                    device: node.currentDevice,
                    unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                        source: "events", observable: "licensePlate", eventType: event.type, updateType: updateType || ""
                    })
                });
                setNodeStatus({ fill: "blue", shape: "dot", text: `LPR ${plate.text}` });
                sendOutputs(node.send.bind(node), outputMsg, null);
            });
            return true;
        }

        function scheduleLicensePlateFollowUp(state) {
            if (!isLicensePlateStateActive(state) || state.timer || state.followUpIndex >= LPR_FOLLOW_UP_DELAYS_MS.length) return;
            const delay = LPR_FOLLOW_UP_DELAYS_MS[state.followUpIndex++];
            state.timer = setTimeout(() => {
                state.timer = null;
                if (!isLicensePlateStateActive(state)) return;
                state.pending = { item: state.latestEvent, type: "lpr-refresh" };
                readLicensePlateUpdate(state);
            }, delay);
        }

        function readLicensePlateUpdate(state) {
            if (state.inFlight) return state.inFlight;
            state.inFlight = Promise.resolve().then(async () => {
                while (state.pending && isLicensePlateStateActive(state)) {
                    const next = state.pending;
                    state.pending = null;
                    const liveVersion = state.liveVersion;
                    let recordedEvent;
                    try {
                        recordedEvent = await node.server.fetchLicensePlateEvent(next.item.id, node.deviceId, { quick: true });
                    } catch (error) {
                        // Do not keep retrying a credentials/permission failure.
                        // A later real event can retry after configuration recovers.
                        state.followUpIndex = LPR_FOLLOW_UP_DELAYS_MS.length;
                        if (error.code === "UNIFI_PROTECT_HISTORY_CREDENTIALS_REQUIRED") {
                            if (lprCredentialsWarningSent) continue;
                            lprCredentialsWarningSent = true;
                        }
                        if (isLicensePlateStateActive(state)) reportLicensePlateError(error);
                        continue;
                    }
                    if (!isLicensePlateStateActive(state)) return;
                    // A native reading received during this request has already
                    // been emitted. Do not overwrite it with an older response.
                    if (state.liveVersion !== liveVersion) continue;
                    const plates = extractLicensePlates(recordedEvent);
                    if (plates.length) {
                        emitLicensePlateReadings(state, { ...next.item, ...recordedEvent, device: node.deviceId }, next.type);
                    } else if (!state.emitted.size) {
                        setNodeStatus({ fill: "yellow", shape: "ring", text: "waiting for plate text" });
                    }
                }
            }).catch((error) => {
                state.followUpIndex = LPR_FOLLOW_UP_DELAYS_MS.length;
                if (isLicensePlateStateActive(state)) reportLicensePlateError(error);
            }).finally(() => {
                state.inFlight = null;
                if (!isLicensePlateStateActive(state)) return;
                if (state.pending) readLicensePlateUpdate(state);
                else scheduleLicensePlateFollowUp(state);
            });
            return state.inFlight;
        }

        function handleLicensePlateUpdate(update) {
            const item = update.item;
            // Start looking when a vehicle is detected; Protect may add the LPR
            // classification later. Output still requires actual OCR metadata.
            const vehicleCandidate = LICENSE_PLATE_EVENT_TYPES.includes(item.type)
                && Array.isArray(item.smartDetectTypes) && item.smartDetectTypes.includes("vehicle");
            if ((!isLicensePlateEvent(item) && !vehicleCandidate) || !item.id) return;
            const now = Date.now();
            lprEventStates.forEach((state, id) => {
                if (now - state.lastSeen > 60 * 60 * 1000) forgetLicensePlateEvent(id);
            });
            let state = lprEventStates.get(item.id);
            if (!state) {
                if (lprEventStates.size >= 256) forgetLicensePlateEvent(lprEventStates.keys().next().value);
                state = { emitted: new Map(), pending: null, inFlight: null, timer: null, lastSeen: now,
                    liveVersion: 0, followUpIndex: 0, latestEvent: item };
                lprEventStates.set(item.id, state);
            }
            state.lastSeen = now;
            state.latestEvent = { ...state.latestEvent, ...item };
            state.followUpIndex = 0;
            if (state.timer) { clearTimeout(state.timer); state.timer = null; }
            // Fast path: native OCR bypasses both login and any outstanding read.
            if (extractLicensePlates(item).length) {
                state.liveVersion += 1;
                state.pending = null;
                try { emitLicensePlateReadings(state, item, update.type); }
                catch (error) { reportLicensePlateError(error); return; }
                if (!state.inFlight) scheduleLicensePlateFollowUp(state);
                return state.inFlight;
            }
            state.pending = { ...update, item: state.latestEvent };
            return readLicensePlateUpdate(state);
        }

        function handleEventPhoto(item) {
            const options = parseCapabilityConfig(node.capabilityConfig);
            if (!item.id || !matchesDetection(item, options.detectionType || "all")) return;
            const existing = photoStates.get(item.id);
            if (existing && existing.sent) return;
            if (existing && existing.pending) { existing.latest = item; return; }
            if (photoQueue.length >= 32) {
                node.send([null, buildErrorOutputMessage(new Error("Event photo queue is full. Narrow the detection filter."), node.name)]);
                return;
            }
            const state = { pending: true, sent: false };
            photoStates.set(item.id, state);
            photoQueue.push({ item, options, state });
            drainEventPhotos();
        }

        function drainEventPhotos() {
            while (node.isObserving && photoInFlight < 2 && photoQueue.length) {
                const { item, options, state } = photoQueue.shift();
                photoInFlight += 1;
                Promise.resolve().then(async () => {
                    if (!node.isObserving) return;
                    const names = parseKnownPlates(options.knownPlates);
                    let event = item;
                    if (isLicensePlateEvent(item) && !extractLicensePlates(item).length) {
                        event = await node.server.fetchLicensePlateEvent(item.id, node.deviceId) || item;
                    }
                    if (!node.isObserving) return;
                    const snapshot = await node.server.takeKnxAiCameraEventSnapshot({ eventId: item.id });
                    if (!node.isObserving) return;
                    const output = { payload: describeDetection(event, names), image: snapshot.data, imageType: snapshot.mediaType };
                    decorateOutputMessage(output, node.currentDevice, "detectionWithImage");
                    attachDetails(output, { raw: event, unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, node.capability, { source: "events" }) });
                    state.sent = true;
                    sendWithPayload(node.send.bind(node), output, node.emitStartupAndUndefined);
                    setNodeStatus({ fill: "blue", shape: "dot", text: "event photo received" });
                }).catch((error) => {
                    if (!node.isObserving) return;
                    setNodeStatus({ fill: "red", shape: "ring", text: "event photo unavailable" });
                    node.send([null, buildErrorOutputMessage(error, node.name)]);
                }).finally(() => {
                    state.pending = false;
                    photoInFlight -= 1;
                    if (!state.sent && state.latest && node.isObserving) handleEventPhoto(state.latest);
                    // Keep a bounded dedupe cache without evicting active work.
                    for (const [id, entry] of photoStates) {
                        if (photoStates.size <= 512) break;
                        if (!entry.pending) photoStates.delete(id);
                    }
                    drainEventPhotos();
                });
            }
        }

        node.handleProtectEventUpdate = (update) => {
            try {
                const item = update && update.item;
                if (!item || item.modelKey !== "event" || !node.isObserving || item.device !== node.deviceId) {
                    return;
                }

                if (isPhotoObservation()) return handleEventPhoto(item);
                if (isLicensePlateObservation()) return handleLicensePlateUpdate(update);

                const capabilityConfig = parseCapabilityConfig(node.capabilityConfig);
                const observable = resolveConfiguredObservable(capabilityConfig);
                const observableScopeId = resolveConfiguredObservableScope(capabilityConfig);
                if (observable) {
                    // When the user selected an observable, events can update the
                    // state output directly instead of only the event payload.
                    const observation = resolveObservableEventValue(node.deviceType, item, observable, observableScopeId);
                    if (observation.matched) {
                        if (!node.emitStartupAndUndefined && !hasPayloadValue(observation.value)) return;
                        const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
                        node.currentObservableValue = observation.value;
                        setNodeStatus({ fill: "blue", shape: "ring", text: `${item.type || "event"}` });
                        const stateMsg = {
                            payload: node.currentObservableValue,
                            topic: resolveNodeName(node.name),
                            deviceName: resolvedDeviceName || undefined,
                            eventName: String(item.type || "event").trim()
                        };
                        attachDetails(stateMsg, {
                            raw: {
                                device: node.currentDevice,
                                event: item,
                                observable,
                                observableScopeId: observableScopeId || undefined,
                                source: "events"
                            },
                            device: node.currentDevice,
                            unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                                source: "events",
                                observable,
                                observableScopeId: observableScopeId || undefined,
                                eventType: item.type || "",
                                updateType: update.type || ""
                            })
                        });
                        const eventMsg = {
                            payload: attachDeviceNameToPayload({
                                device: node.currentDevice,
                                event: item
                            }, resolvedDeviceName),
                            topic: resolveNodeName(node.name),
                            deviceName: resolvedDeviceName || undefined,
                            eventName: String(item.type || "event").trim()
                        };
                        attachDetails(eventMsg, {
                            raw: item,
                            device: node.currentDevice,
                            unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                                source: "events",
                                observable,
                                observableScopeId: observableScopeId || undefined,
                                eventType: item.type || "",
                                updateType: update.type || ""
                            })
                        });
                        sendOutputs(node.send.bind(node), stateMsg, eventMsg);
                        return;
                    }

                    // No value for the selected observable: do not emit a raw
                    // event as an alternative downstream command.
                    return;
                }

                setNodeStatus({ fill: "blue", shape: "ring", text: `${item.type || "event"}` });
                const resolvedDeviceName = resolveOutputDeviceName(node.currentDevice);
                const eventMsg = {
                    payload: attachDeviceNameToPayload({
                        device: node.currentDevice,
                        event: item
                    }, resolvedDeviceName),
                    topic: resolveNodeName(node.name),
                    deviceName: resolvedDeviceName || undefined,
                    eventName: String(item.type || "event").trim()
                };
                attachDetails(eventMsg, {
                    raw: item,
                    device: node.currentDevice,
                    unifiProtect: buildBaseMetadata(node.deviceType, node.deviceId, "observe", {
                        source: "events",
                        eventType: item.type || "",
                        updateType: update.type || ""
                    })
                });
                sendOutputs(node.send.bind(node), null, eventMsg);
            } catch (error) {
            }
        };

        if (!node.server) {
            setNodeStatus({ fill: "red", shape: "ring", text: "config missing" });
        } else if (configuredCapabilityOpensEventStream() && (!node.deviceType || !node.deviceId)) {
            setNodeStatus({ fill: "yellow", shape: "ring", text: "select device" });
        } else {
            startObservation();
            startAutoEmitTimer();
        }

        node.on("close", function(done) {
            try {
                closed = true;
                stopAutoEmitTimer();
                if (node.server && typeof node.server.removeClient === "function") {
                    node.server.removeClient(node);
                }
                node.isObserving = false;
                lprEventStates.forEach((_state, id) => forgetLicensePlateEvent(id));
                photoQueue.length = 0;
                photoStates.clear();
            } catch (error) {
            } finally {
                if (typeof done === "function") {
                    done();
                }
            }
        });
    }

    RED.nodes.registerType("unifi-protect-device", UnifiProtectDeviceNode);
};
