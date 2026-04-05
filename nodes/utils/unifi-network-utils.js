"use strict";

const http = require("http");
const https = require("https");

function normalizeHost(value) {
    // Accept either a bare host or a full URL from the editor and reduce it to
    // the host:port form expected by the integration proxy base URL.
    let host = String(value || "").trim();
    if (!host) {
        return "";
    }

    host = host.replace(/^https?:\/\//i, "");
    host = host.replace(/\/.*$/, "");
    return host.trim().replace(/\/+$/, "");
}

function buildBaseUrlFromHost(value) {
    const host = normalizeHost(value);
    if (!host) {
        return "";
    }

    return `https://${host}/proxy/network/integration`;
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
    // Some UniFi endpoints return JSON with a missing/odd content-type header,
    // so also inspect the raw payload before deciding to parse.
    const raw = buffer.toString("utf8");
    if (!raw) {
        return raw;
    }

    const trimmed = raw.trim();
    const isJsonType = typeof contentType === "string" && contentType.includes("application/json");
    const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");

    if (isJsonType || looksJson) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            return raw;
        }
    }

    return raw;
}

function doRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        // Stay on the built-in http/https clients to keep node dependencies
        // minimal and compatible with Node-RED environments.
        const transport = url.protocol === "http:" ? http : https;
        const requestOptions = {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: options.method,
            headers: options.headers,
            timeout: options.timeout,
            rejectUnauthorized: options.rejectUnauthorized
        };

        const req = transport.request(requestOptions, (res) => {
            const chunks = [];

            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const buffer = Buffer.concat(chunks);
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    payload: maybeParseBody(res.headers["content-type"], buffer)
                });
            });
        });

        req.on("timeout", () => {
            req.destroy(new Error("Request timed out"));
        });

        req.on("error", reject);

        if (body !== undefined && body !== null) {
            req.write(body);
        }

        req.end();
    });
}

function buildRequestHeaders(authHeader, apiKey, msgHeaders) {
    return Object.assign(
        {
            Accept: "application/json",
            [authHeader]: apiKey
        },
        msgHeaders && typeof msgHeaders === "object" ? msgHeaders : {}
    );
}

function buildRequestBody(headers, method, payload) {
    // Automatically serialize object payloads and keep Content-* headers in sync
    // so registry/runtime code can focus on request semantics only.
    if (method === "GET" || method === "HEAD" || payload === undefined) {
        return undefined;
    }

    let requestBody;
    if (Buffer.isBuffer(payload)) {
        requestBody = payload;
    } else if (typeof payload === "string") {
        requestBody = payload;
        if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "text/plain; charset=utf-8";
        }
    } else {
        requestBody = JSON.stringify(payload);
        if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "application/json";
        }
    }

    if (!headers["Content-Length"] && !headers["content-length"]) {
        headers["Content-Length"] = Buffer.byteLength(requestBody);
    }

    return requestBody;
}

function extractNetworkData(payload) {
    // Official UniFi Network responses often wrap the real data under "data".
    if (payload && typeof payload === "object" && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, "data")) {
        return payload.data;
    }

    return payload;
}

function normalizeNetworkCollection(payload) {
    // Collections are normalized to a flat array so discovery endpoints can
    // tolerate both singular and nested response shapes.
    const data = extractNetworkData(payload);

    if (!Array.isArray(data)) {
        return data && typeof data === "object" ? [data] : [];
    }

    return data.flat(Infinity).filter((entry) => entry && typeof entry === "object");
}

module.exports = {
    buildBaseUrlFromHost,
    buildQueryString,
    doRequest,
    buildRequestHeaders,
    buildRequestBody,
    extractNetworkData,
    normalizeNetworkCollection
};
