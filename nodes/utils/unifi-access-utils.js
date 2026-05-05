"use strict";

const http = require("http");
const https = require("https");
const { maybeParseBody } = require("./http-response-utils");

function normalizeHost(value) {
    // Access controllers usually live on port 12445. Accept bare hosts, host:port
    // pairs and IPv6 literals, then normalize everything to one safe form.
    let host = String(value || "").trim();
    if (!host) {
        return "";
    }

    host = host.replace(/^https?:\/\//i, "");
    host = host.replace(/\/.*$/, "");
    host = host.trim().replace(/\/+$/, "");

    if (!host) {
        return "";
    }

    if (host.startsWith("[") && host.includes("]")) {
        return host.includes("]:") ? host : `${host}:12445`;
    }

    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 0) {
        return `${host}:12445`;
    }

    if (colonCount === 1 && /^\S+:\d+$/.test(host)) {
        return host;
    }

    return host;
}

function buildBaseUrlFromHost(value) {
    const host = normalizeHost(value);
    if (!host) {
        return "";
    }

    return `https://${host}`;
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

function doRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        // Use the native transports to avoid extra runtime dependencies inside
        // Node-RED deployments.
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

function buildRequestHeaders(apiToken, msgHeaders) {
    return Object.assign(
        {
            Accept: "application/json",
            Authorization: `Bearer ${apiToken}`
        },
        msgHeaders && typeof msgHeaders === "object" ? msgHeaders : {}
    );
}

function buildRequestBody(headers, method, payload) {
    // Centralize payload serialization so higher-level code can pass plain
    // objects without worrying about headers and content length.
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

function extractAccessData(payload) {
    // Access developer APIs often wrap the useful object under "data".
    if (payload && typeof payload === "object" && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, "data")) {
        return payload.data;
    }

    return payload;
}

function normalizeAccessCollection(payload) {
    // Normalize singular objects, arrays and nested arrays into one flat list.
    const data = extractAccessData(payload);

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
    extractAccessData,
    normalizeAccessCollection
};
