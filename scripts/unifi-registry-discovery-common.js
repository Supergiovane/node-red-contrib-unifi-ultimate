"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

function ask(question, defaultValue) {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(`${question}${suffix}: `, (answer) => {
            rl.close();
            const value = String(answer || "").trim();
            resolve(value || String(defaultValue || "").trim());
        });
    });
}

function askSecret(question) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
        return ask(question);
    }

    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        const previousRawMode = stdin.isRaw;
        let value = "";

        function cleanup() {
            stdin.removeListener("data", onData);
            stdin.setRawMode(Boolean(previousRawMode));
            stdout.write("\n");
        }

        function onData(chunk) {
            const text = String(chunk || "");

            if (text === "\u0003") {
                cleanup();
                process.exit(130);
            }

            if (text === "\r" || text === "\n") {
                cleanup();
                resolve(value.trim());
                return;
            }

            if (text === "\u007f" || text === "\b") {
                value = value.slice(0, -1);
                return;
            }

            value += text;
        }

        stdout.write(`${question}: `);
        stdin.setEncoding("utf8");
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
    });
}

async function askYesNo(question, defaultValue) {
    const defaultLabel = defaultValue ? "Y/n" : "y/N";
    const answer = String(await ask(`${question} [${defaultLabel}]`) || "").trim().toLowerCase();
    if (!answer) {
        return Boolean(defaultValue);
    }
    return ["y", "yes", "s", "si", "sì", "true", "1"].includes(answer);
}

function buildQueryString(query) {
    if (!query || typeof query !== "object" || Array.isArray(query)) {
        return "";
    }

    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((entry) => params.append(key, String(entry)));
            return;
        }
        params.append(key, String(value));
    });

    const rendered = params.toString();
    return rendered ? `?${rendered}` : "";
}

function maybeParseBody(contentType, buffer) {
    const raw = buffer.toString("utf8");
    if (!raw) {
        return raw;
    }

    const trimmed = raw.trim();
    const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    const isJson = String(contentType || "").toLowerCase().includes("application/json");
    if (isJson || looksJson) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            return raw;
        }
    }

    return raw;
}

function buildRequestBody(headers, method, payload) {
    if (method === "GET" || method === "HEAD" || payload === undefined) {
        return undefined;
    }

    let body;
    if (Buffer.isBuffer(payload)) {
        body = payload;
    } else if (typeof payload === "string") {
        body = payload;
    } else {
        body = JSON.stringify(payload);
        if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "application/json";
        }
    }

    if (!headers["Content-Length"] && !headers["content-length"]) {
        headers["Content-Length"] = Buffer.byteLength(body);
    }

    return body;
}

function requestJson({ baseUrl, path: requestPath, method = "GET", query, headers, payload, timeout = 15000, rejectUnauthorized = false }) {
    const normalizedPath = String(requestPath || "").startsWith("/") ? String(requestPath || "") : `/${String(requestPath || "")}`;
    const url = new URL(`${baseUrl}${normalizedPath}${buildQueryString(query)}`);
    const requestMethod = String(method || "GET").toUpperCase();
    const requestHeaders = {
        Accept: "application/json",
        ...(headers || {})
    };
    const body = buildRequestBody(requestHeaders, requestMethod, payload);

    return new Promise((resolve, reject) => {
        const transport = url.protocol === "http:" ? http : https;
        const req = transport.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: requestMethod,
            headers: requestHeaders,
            timeout,
            rejectUnauthorized
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const bodyBuffer = Buffer.concat(chunks);
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    payload: maybeParseBody(res.headers["content-type"], bodyBuffer)
                });
            });
        });

        req.on("timeout", () => req.destroy(new Error("Request timed out")));
        req.on("error", reject);

        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
}

async function safeRequest(options) {
    try {
        const response = await requestJson(options);
        return {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            payload: response.payload
        };
    } catch (error) {
        return {
            ok: false,
            statusCode: 0,
            error: error && error.message ? error.message : String(error)
        };
    }
}

function extractData(payload) {
    if (payload && typeof payload === "object" && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, "data")) {
        return payload.data;
    }
    return payload;
}

function normalizeCollection(payload) {
    const data = extractData(payload);
    if (!Array.isArray(data)) {
        return data && typeof data === "object" ? [data] : [];
    }
    return data.flat(Infinity).filter((entry) => entry && typeof entry === "object");
}

async function fetchPaged({ baseUrl, path: requestPath, headers, query, timeout, rejectUnauthorized }) {
    const collected = [];
    let offset = 0;
    const pageSize = 200;

    for (let page = 0; page < 1000; page += 1) {
        const response = await safeRequest({
            baseUrl,
            path: requestPath,
            method: "GET",
            query: {
                ...(query || {}),
                offset,
                limit: pageSize
            },
            headers,
            timeout,
            rejectUnauthorized
        });

        if (!response.ok) {
            return {
                ok: false,
                statusCode: response.statusCode,
                error: response.error,
                payload: response.payload,
                items: collected
            };
        }

        const items = normalizeCollection(response.payload);
        collected.push(...items);

        const payload = response.payload && typeof response.payload === "object" && !Array.isArray(response.payload)
            ? response.payload
            : {};
        const totalCount = Number(payload.totalCount);
        const count = Number(payload.count);
        const responseLimit = Number(payload.limit);
        const effectiveLimit = Number.isFinite(responseLimit) && responseLimit > 0 ? responseLimit : pageSize;

        if (items.length === 0) {
            break;
        }
        if (Number.isFinite(totalCount) && collected.length >= totalCount) {
            break;
        }
        if (Number.isFinite(count) && count < effectiveLimit) {
            break;
        }
        if (items.length < effectiveLimit) {
            break;
        }

        offset += items.length;
    }

    return {
        ok: true,
        statusCode: 200,
        items: collected
    };
}

function renderPath(template, values) {
    let rendered = String(template || "");
    Object.entries(values || {}).forEach(([key, value]) => {
        const encoded = encodeURIComponent(String(value || ""));
        rendered = rendered.replace(new RegExp(`\\{${key}\\}`, "g"), encoded);
        rendered = rendered.replace(new RegExp(`:${key}\\b`, "g"), encoded);
    });
    return rendered;
}

function getCapabilitiesSnapshot(registry) {
    return registry.getDeviceTypes().map((typeDefinition) => {
        const capabilities = registry.getCapabilitiesForType(typeDefinition.type).map((capability) => ({
            id: capability.id,
            label: capability.label,
            method: capability.method || "",
            path: capability.path || "",
            mode: capability.mode || "",
            hasConfiguration: Boolean(capability.hasConfiguration)
        }));

        return {
            type: typeDefinition.type,
            label: typeDefinition.label,
            listPath: typeDefinition.listPath || "",
            detailPath: typeDefinition.detailPath || "",
            capabilities
        };
    });
}

function flattenPrimitivePaths(value, options = {}) {
    const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 5;
    const maxItems = Number.isInteger(options.maxItems) ? options.maxItems : 250;
    const paths = [];
    const visited = new Set();

    function walk(current, prefix, depth) {
        if (paths.length >= maxItems || depth > maxDepth || current === null || current === undefined) {
            return;
        }

        if (typeof current !== "object") {
            paths.push({
                path: prefix.join("."),
                type: typeof current,
                sample: current
            });
            return;
        }

        if (visited.has(current)) {
            return;
        }
        visited.add(current);

        if (Array.isArray(current)) {
            current.slice(0, 3).forEach((entry, index) => walk(entry, prefix.concat(String(index)), depth + 1));
            return;
        }

        Object.keys(current).sort().forEach((key) => {
            walk(current[key], prefix.concat(key), depth + 1);
        });
    }

    walk(value, [], 0);
    return paths.filter((entry) => entry.path);
}

function extractUppercaseTokens(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value || {});
    const tokens = new Set();
    const matches = text.match(/[A-Z][A-Z0-9_]{2,}/g) || [];
    matches.forEach((match) => tokens.add(match));
    return Array.from(tokens).sort();
}

function sampleObject(value) {
    if (!value || typeof value !== "object") {
        return value;
    }

    const clone = Array.isArray(value) ? [] : {};
    Object.keys(value).slice(0, 40).forEach((key) => {
        const entry = value[key];
        if (entry && typeof entry === "object") {
            clone[key] = Array.isArray(entry) ? `[array:${entry.length}]` : "[object]";
        } else {
            clone[key] = entry;
        }
    });
    return clone;
}

function sanitizePayloadForReport(payload) {
    if (payload === undefined) {
        return undefined;
    }
    if (typeof payload === "string") {
        return payload.slice(0, 1000);
    }
    if (!payload || typeof payload !== "object") {
        return payload;
    }
    return sampleObject(payload);
}

function writeReport(product, report) {
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = path.resolve(process.cwd(), "reports", "unifi-registry-discovery");
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, `${product}-${safeTimestamp}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    return outputPath;
}

function decodeHtml(value) {
    return String(value || "")
        .replace(/&quot;/g, "\"")
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function normalizeNextHtml(value) {
    return decodeHtml(String(value || ""))
        .replace(/\\"/g, "\"")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");
}

function extractJsonValue(text, marker) {
    const start = text.indexOf(marker);
    if (start < 0) {
        return null;
    }

    const valueStart = start + marker.length;
    const open = text[valueStart];
    const close = open === "[" ? "]" : open === "{" ? "}" : "";
    if (!close) {
        return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = valueStart; index < text.length; index += 1) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (char === open) {
            depth += 1;
        } else if (char === close) {
            depth -= 1;
            if (depth === 0) {
                return text.slice(valueStart, index + 1);
            }
        }
    }

    return null;
}

function extractDeveloperPortalState(html) {
    const normalized = normalizeNextHtml(html);
    const sidebarJson = extractJsonValue(normalized, "\"sidebarData\":");
    const versionsJson = extractJsonValue(normalized, "\"versions\":");
    const currentServiceId = normalized.match(/"currentServiceId":"([^"]+)"/);
    const currentVersion = normalized.match(/"currentVersion":"([^"]+)"/);

    return {
        normalized,
        sidebarData: sidebarJson ? JSON.parse(sidebarJson) : [],
        versions: versionsJson ? JSON.parse(versionsJson) : [],
        currentServiceId: currentServiceId ? currentServiceId[1] : "",
        currentVersion: currentVersion ? currentVersion[1] : ""
    };
}

function collectSidebarDocs(items, categoryPath = []) {
    const docs = [];
    (items || []).forEach((item) => {
        if (!item || typeof item !== "object") {
            return;
        }

        if (item.type === "doc") {
            docs.push({
                label: item.label || "",
                method: item.method || "",
                docsPath: item.path || "",
                categoryPath
            });
            return;
        }

        if (Array.isArray(item.items)) {
            docs.push(...collectSidebarDocs(item.items, categoryPath.concat(item.label || item.categoryId || "")));
        }
    });
    return docs;
}

function extractEndpointPaths(text) {
    const normalized = normalizeNextHtml(text);
    const pathMatches = normalized.match(/\/(?:proxy\/[a-z]+\/integration\/)?(?:api\/v\d+\/developer|v\d+)\/[A-Za-z0-9_{}:./-]+/g) || [];
    return Array.from(new Set(pathMatches.map((entry) => entry.replace(/[",')\\]+$/g, "")))).sort();
}

function extractCandidateActions(text) {
    return extractUppercaseTokens(text)
        .filter((token) => token.includes("_") || ["RESTART", "ADOPT", "FORGET", "LOCATE"].includes(token));
}

function extractDeveloperEndpoint(html) {
    const normalized = normalizeNextHtml(html);
    const start = normalized.indexOf("\"endpoint\":");
    if (start < 0) {
        return null;
    }

    const fullSpecStart = normalized.indexOf("\"fullSpec\":", start);
    const pageIdStart = normalized.indexOf("\"pageId\":", start);
    const endCandidates = [fullSpecStart, pageIdStart].filter((index) => index > start);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : Math.min(normalized.length, start + 20000);
    const segment = normalized.slice(start, end);
    const pathMatch = segment.match(/"path":"([^"]+)"/);
    const methodMatch = segment.match(/"method":"([^"]+)"/);

    if (!pathMatch || !methodMatch) {
        return null;
    }

    const operationIdMatch = segment.match(/"operationId":"([^"]+)"/);
    const summaryMatch = segment.match(/"summary":"([^"]+)"/);
    const descriptionMatch = segment.match(/"description":"((?:\\.|[^"\\])*)"/);
    const tagsMatch = segment.match(/"tags":\[((?:"[^"]+",?)+)\]/);
    const tags = tagsMatch
        ? Array.from(tagsMatch[1].matchAll(/"([^"]+)"/g)).map((match) => match[1])
        : [];

    return {
        path: pathMatch[1],
        method: methodMatch[1],
        operationId: operationIdMatch ? operationIdMatch[1] : "",
        summary: summaryMatch ? summaryMatch[1] : "",
        description: descriptionMatch ? descriptionMatch[1] : "",
        tags,
        rawSegment: segment
    };
}

function extractCandidateActionsFromEndpoint(endpoint) {
    const actions = new Set();

    if (endpoint.rawSegment) {
        const actionMappingPattern = /"propertyName":"action","mapping":\{([^}]+)\}/g;
        let mappingMatch;
        while ((mappingMatch = actionMappingPattern.exec(endpoint.rawSegment))) {
            const keys = mappingMatch[1].match(/"([A-Z][A-Z0-9_]{2,})":/g) || [];
            keys.forEach((entry) => actions.add(entry.replace(/[":]/g, "")));
        }

        const actionEnumPattern = /"action":\{[^}]*"enum":\[([^\]]+)\]/g;
        let enumMatch;
        while ((enumMatch = actionEnumPattern.exec(endpoint.rawSegment))) {
            const values = enumMatch[1].match(/"([A-Z][A-Z0-9_]{2,})"/g) || [];
            values.forEach((entry) => actions.add(entry.replace(/"/g, "")));
        }
    }

    function walk(value, key) {
        if (!value || typeof value !== "object") {
            return;
        }

        if (key === "mapping" && !Array.isArray(value)) {
            Object.keys(value).forEach((entry) => {
                if (/^[A-Z][A-Z0-9_]{2,}$/.test(entry)) {
                    actions.add(entry);
                }
            });
        }

        if (Array.isArray(value)) {
            value.forEach((entry) => walk(entry, ""));
            return;
        }

        Object.entries(value).forEach(([entryKey, entryValue]) => {
            if (entryKey === "enum" && Array.isArray(entryValue)) {
                entryValue.forEach((entry) => {
                    if (/^[A-Z][A-Z0-9_]{2,}$/.test(String(entry || ""))) {
                        actions.add(String(entry));
                    }
                });
            }
            walk(entryValue, entryKey);
        });
    }

    walk(endpoint, "");
    return Array.from(actions).sort();
}

function getRegistryEndpointKeys(registry) {
    const keys = new Set();
    getCapabilitiesSnapshot(registry).forEach((type) => {
        if (type.listPath) {
            keys.add(`GET ${type.listPath}`);
        }
        if (type.detailPath) {
            keys.add(`GET ${type.detailPath}`);
        }
        type.capabilities.forEach((capability) => {
            if (capability.method && capability.path) {
                keys.add(`${capability.method} ${capability.path}`);
            }
        });
    });
    return keys;
}

function summarizeDocsAgainstRegistry(docs, registry) {
    const registryKeys = getRegistryEndpointKeys(registry);
    return docs.map((doc) => {
        const method = String(doc.method || "").toUpperCase();
        const documentedKeys = (doc.endpointPaths || []).map((endpointPath) => `${method || "GET"} ${endpointPath}`);
        const exactRegistryMatches = documentedKeys.filter((key) => registryKeys.has(key));

        return {
            ...doc,
            exactRegistryMatches,
            registryStatus: exactRegistryMatches.length > 0 ? "known" : "candidate"
        };
    });
}

function toCamelCase(value) {
    const words = String(value || "")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (words.length === 0) {
        return "unnamedCapability";
    }

    return words.map((word, index) => {
        const normalized = word.charAt(0).toUpperCase() + word.slice(1);
        return index === 0
            ? normalized.charAt(0).toLowerCase() + normalized.slice(1)
            : normalized;
    }).join("");
}

function inferTargetType(product, doc) {
    const text = [
        doc.label,
        doc.operationId,
        doc.endpointPaths && doc.endpointPaths[0],
        doc.tags && doc.tags.join(" ")
    ].join(" ").toLowerCase();

    if (product === "network") {
        if (text.includes("client")) {
            return "client";
        }
        if (text.includes("site")) {
            return "site";
        }
        if (text.includes("device") || text.includes("port")) {
            return "device";
        }
        return "site";
    }

    if (product === "protect") {
        if (text.includes("camera")) {
            return "camera";
        }
        if (text.includes("live view") || text.includes("liveview")) {
            return "liveview";
        }
        if (text.includes("viewer")) {
            return "viewer";
        }
        if (text.includes("sensor")) {
            return "sensor";
        }
        if (text.includes("light")) {
            return "light";
        }
        if (text.includes("chime")) {
            return "chime";
        }
        if (text.includes("nvr")) {
            return "nvr";
        }
        return "";
    }

    if (product === "access") {
        if (text.includes("door")) {
            return "door";
        }
        if (text.includes("device")) {
            return "device";
        }
        return "";
    }

    return "";
}

function classifySuggestion(doc) {
    const method = String(doc.method || "").toUpperCase();
    const pathValue = String(doc.endpointPaths && doc.endpointPaths[0] || "");
    const haystack = [
        doc.label,
        doc.operationId,
        pathValue,
        doc.context
    ].join(" ").toLowerCase();
    const reasons = [];

    if (!method || !pathValue) {
        return {
            risk: "requires-review",
            reasons: ["Missing method or endpoint path in the extracted documentation."]
        };
    }

    if (/\b(delete|remove|unadopt|forget|factory|erase|reboot|restart|power|lockdown|evacuation|adopt|upgrade|firmware)\b/.test(haystack)) {
        reasons.push("Potentially disruptive command or lifecycle operation.");
        return {
            risk: "dangerous",
            reasons
        };
    }

    if (method === "GET") {
        reasons.push("Read-only GET endpoint.");
        return {
            risk: "safe",
            reasons
        };
    }

    if (doc.candidateActions && doc.candidateActions.length > 0) {
        reasons.push("Action endpoint exposes explicit action token(s). A requestComposer is still required.");
        return {
            risk: "requires-review",
            reasons
        };
    }

    if (["POST", "PUT", "PATCH"].includes(method)) {
        reasons.push("Write endpoint. Payload schema must be reviewed before adding a runtime action.");
        return {
            risk: "requires-review",
            reasons
        };
    }

    reasons.push("Unsupported or uncommon HTTP method.");
    return {
        risk: "requires-review",
        reasons
    };
}

function buildRegistrySnippet(product, doc, targetType, risk) {
    const method = String(doc.method || "").toUpperCase();
    const pathValue = String(doc.endpointPaths && doc.endpointPaths[0] || "");
    const id = toCamelCase(doc.operationId || doc.label || pathValue);
    const label = String(doc.label || doc.operationId || pathValue || id).replace(/"/g, "\\\"");
    const description = risk === "safe"
        ? `Execute ${label}.`
        : `Candidate for ${label}. Review payload and side effects before enabling.`;

    const lines = [
        "{",
        `    id: "${id}",`,
        `    label: "${label}",`,
        `    description: "${description.replace(/"/g, "\\\"")}",`,
        `    method: "${method}",`,
        `    path: "${pathValue}",`,
        "    mode: \"request\""
    ];

    if (method !== "GET") {
        lines.push("    // TODO: add ignoreInputPayload/useConfiguredPayload and requestComposer after manual validation.");
    }

    lines.push("}");

    return {
        registryFile: `nodes/utils/unifi-${product}-device-registry.js`,
        targetType,
        capabilityObject: lines.join("\n")
    };
}

function buildRegistrySuggestions(product, docs) {
    return (docs || [])
        .filter((doc) => doc && doc.registryStatus === "candidate")
        .map((doc) => {
            const classification = classifySuggestion(doc);
            const targetType = inferTargetType(product, doc);
            const suggestion = {
                id: toCamelCase(doc.operationId || doc.label || doc.endpointPaths && doc.endpointPaths[0]),
                label: doc.label || "",
                method: doc.method || "",
                path: doc.endpointPaths && doc.endpointPaths[0] || "",
                operationId: doc.operationId || "",
                targetType,
                risk: classification.risk,
                reasons: classification.reasons,
                candidateActions: doc.candidateActions || [],
                docsUrl: doc.url || doc.docsPath || ""
            };

            if (suggestion.path && suggestion.method && targetType) {
                suggestion.registrySnippet = buildRegistrySnippet(product, doc, targetType, classification.risk);
            }

            return suggestion;
        })
        .sort((left, right) => {
            const riskOrder = { safe: 0, "requires-review": 1, dangerous: 2 };
            return (riskOrder[left.risk] || 9) - (riskOrder[right.risk] || 9)
                || String(left.targetType).localeCompare(String(right.targetType))
                || String(left.label).localeCompare(String(right.label));
        });
}

async function fetchDeveloperPortalReport({ product, defaultVersion, registry, includePages = "api" }) {
    const versionAnswer = await ask(`${product.toUpperCase()} docs version`, defaultVersion || "latest");
    const initialVersion = versionAnswer === "latest" ? (defaultVersion || "latest") : versionAnswer;
    const baseDocsUrl = "https://developer.ui.com";
    const startPath = `/${product}/${initialVersion}/gettingstarted`;
    const start = await safeRequest({
        baseUrl: baseDocsUrl,
        path: startPath
    });

    if (!start.ok || typeof start.payload !== "string") {
        throw new Error(`Unable to load ${baseDocsUrl}${startPath} (${start.statusCode || "error"}).`);
    }

    const startState = extractDeveloperPortalState(start.payload);
    const latestVersion = startState.versions && startState.versions[0] && startState.versions[0].version
        ? startState.versions[0].version
        : initialVersion;
    const version = versionAnswer === "latest" ? latestVersion : initialVersion;
    const docsPath = `/${product}/${version}/gettingstarted`;
    const docsPage = version === initialVersion ? start : await safeRequest({
        baseUrl: baseDocsUrl,
        path: docsPath
    });

    if (!docsPage.ok || typeof docsPage.payload !== "string") {
        throw new Error(`Unable to load ${baseDocsUrl}${docsPath} (${docsPage.statusCode || "error"}).`);
    }

    const state = extractDeveloperPortalState(docsPage.payload);
    const docs = collectSidebarDocs(state.sidebarData)
        .filter((doc) => {
            if (includePages === "all") {
                return true;
            }
            return doc.method || doc.categoryPath.includes("API Endpoints");
        });

    const endpointDocs = [];
    for (const doc of docs) {
        const page = await safeRequest({
            baseUrl: baseDocsUrl,
            path: doc.docsPath
        });
        const pageText = typeof page.payload === "string" ? page.payload : "";
        const endpoint = page.ok ? extractDeveloperEndpoint(pageText) : null;
        endpointDocs.push({
            ...doc,
            label: endpoint && endpoint.summary ? endpoint.summary : doc.label,
            method: endpoint && endpoint.method ? endpoint.method : doc.method,
            url: `${baseDocsUrl}${doc.docsPath}`,
            statusCode: page.statusCode,
            ok: page.ok,
            endpointPaths: endpoint && endpoint.path ? [endpoint.path] : page.ok ? extractEndpointPaths(pageText) : [],
            operationId: endpoint && endpoint.operationId ? endpoint.operationId : "",
            tags: endpoint && Array.isArray(endpoint.tags) ? endpoint.tags : [],
            candidateActions: endpoint ? extractCandidateActionsFromEndpoint(endpoint) : page.ok ? extractCandidateActions(pageText) : [],
            error: page.error
        });
    }

    const summarizedDocs = summarizeDocsAgainstRegistry(endpointDocs, registry);

    return {
        product,
        generatedAt: new Date().toISOString(),
        source: `${baseDocsUrl}/${product}/${version}/gettingstarted`,
        currentServiceId: state.currentServiceId,
        currentVersion: state.currentVersion || version,
        availableVersions: state.versions,
        registry: getCapabilitiesSnapshot(registry),
        docs: summarizedDocs,
        registrySuggestions: buildRegistrySuggestions(product, summarizedDocs),
        notes: [
            "Documentation was read from the online UniFi Developer Portal, not from a local controller.",
            "Registry files are not modified automatically. Review candidate entries before adding static registry actions."
        ]
    };
}

function commandExists(command) {
    try {
        execFileSync("sh", ["-lc", `command -v ${command}`], {
            stdio: "ignore"
        });
        return true;
    } catch (error) {
        return false;
    }
}

async function fetchBinary(url) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const transport = target.protocol === "http:" ? http : https;
        const request = transport.get(target, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                fetchBinary(new URL(response.headers.location, target).toString()).then(resolve, reject);
                return;
            }

            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                resolve({
                    statusCode: response.statusCode || 0,
                    headers: response.headers,
                    buffer: Buffer.concat(chunks)
                });
            });
        });
        request.on("error", reject);
    });
}

async function fetchAccessPdfReport({ registry }) {
    const source = await ask("ACCESS API documentation PDF URL", "https://assets.identity.ui.com/unifi-access/api_reference.pdf");
    const response = await fetchBinary(source);
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Unable to download Access API PDF (${response.statusCode}).`);
    }

    const report = {
        product: "access",
        generatedAt: new Date().toISOString(),
        source,
        sourceStatusCode: response.statusCode,
        contentType: response.headers["content-type"] || "",
        contentLength: response.buffer.length,
        registry: getCapabilitiesSnapshot(registry),
        docs: [],
        notes: [
            "Documentation was read from the online UniFi Access API PDF, not from a local controller.",
            "If pdftotext is unavailable, install poppler-utils or inspect the saved PDF manually.",
            "Registry files are not modified automatically. Review candidate entries before adding static registry actions."
        ]
    };

    if (!commandExists("pdftotext")) {
        return report;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unifi-access-api-"));
    const pdfPath = path.join(tempDir, "api_reference.pdf");
    const textPath = path.join(tempDir, "api_reference.txt");
    fs.writeFileSync(pdfPath, response.buffer);
    execFileSync("pdftotext", ["-layout", pdfPath, textPath], {
        stdio: "ignore"
    });
    const text = fs.readFileSync(textPath, "utf8");
    const endpointPaths = extractEndpointPaths(text);
    const docs = endpointPaths.map((endpointPath) => {
        const contextIndex = text.indexOf(endpointPath);
        const context = contextIndex >= 0
            ? text.slice(Math.max(0, contextIndex - 250), Math.min(text.length, contextIndex + 450))
            : "";
        const methodMatch = context.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/);
        return {
            label: endpointPath,
            method: methodMatch ? methodMatch[1] : "",
            docsPath: source,
            categoryPath: ["PDF"],
            url: source,
            statusCode: response.statusCode,
            ok: true,
            endpointPaths: [endpointPath],
            candidateActions: extractCandidateActions(context),
            context: context.replace(/\s+/g, " ").trim().slice(0, 500)
        };
    });

    report.docs = summarizeDocsAgainstRegistry(docs, registry);
    report.registrySuggestions = buildRegistrySuggestions("access", report.docs);
    return report;
}

module.exports = {
    ask,
    askSecret,
    askYesNo,
    collectSidebarDocs,
    buildRegistrySuggestions,
    extractCandidateActions,
    extractData,
    extractDeveloperPortalState,
    extractDeveloperEndpoint,
    extractEndpointPaths,
    extractUppercaseTokens,
    fetchAccessPdfReport,
    fetchDeveloperPortalReport,
    fetchPaged,
    flattenPrimitivePaths,
    getCapabilitiesSnapshot,
    normalizeCollection,
    renderPath,
    safeRequest,
    sanitizePayloadForReport,
    writeReport
};
