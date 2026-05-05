"use strict";

const http = require("http");
const https = require("https");
const { maybeParseBody } = require("./http-response-utils");

function normalizeHost(value) {
    // Protect editor fields may contain a host or a full URL; strip everything
    // down to the host:port portion used by the integration proxy URL.
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
    return `https://${host}/proxy/protect/integration`;
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
        // Keep request plumbing dependency-free for easier Node-RED packaging.
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
    // Serialize payloads in one place so the higher-level registry/runtime
    // logic only needs to provide semantic request data.
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

module.exports = {
    buildBaseUrlFromHost,
    buildQueryString,
    doRequest,
    buildRequestHeaders,
    buildRequestBody
};
