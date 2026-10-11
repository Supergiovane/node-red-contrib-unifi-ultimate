"use strict";

const {
    attachHeartbeat,
    stopHeartbeat,
    createReconnectBackoff
} = require("../nodes/utils/unifi-websocket-resilience");

function createSocket() {
    const listeners = {};
    return {
        on: jest.fn((event, handler) => {
            (listeners[event] = listeners[event] || []).push(handler);
        }),
        emitEvent: (event, ...args) => (listeners[event] || []).forEach((handler) => handler(...args)),
        ping: jest.fn(),
        terminate: jest.fn()
    };
}

describe("unifi websocket heartbeat", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test("terminates a socket that stops answering pings", () => {
        const socket = createSocket();
        attachHeartbeat(socket, { intervalMs: 1000 });

        jest.advanceTimersByTime(1000);
        expect(socket.ping).toHaveBeenCalledTimes(1);
        expect(socket.terminate).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1000);
        expect(socket.terminate).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(5000);
        expect(socket.terminate).toHaveBeenCalledTimes(1);
    });

    test("keeps a socket alive while pongs or messages arrive", () => {
        const socket = createSocket();
        attachHeartbeat(socket, { intervalMs: 1000 });

        jest.advanceTimersByTime(1000);
        socket.emitEvent("pong");
        jest.advanceTimersByTime(1000);
        socket.emitEvent("message", "{}");
        jest.advanceTimersByTime(1000);

        expect(socket.ping).toHaveBeenCalledTimes(3);
        expect(socket.terminate).not.toHaveBeenCalled();
        stopHeartbeat(socket);
    });

    test("stops pinging after close or an explicit stop", () => {
        const closed = createSocket();
        attachHeartbeat(closed, { intervalMs: 1000 });
        closed.emitEvent("close");

        const stopped = createSocket();
        attachHeartbeat(stopped, { intervalMs: 1000 });
        stopHeartbeat(stopped);

        jest.advanceTimersByTime(5000);
        expect(closed.ping).not.toHaveBeenCalled();
        expect(stopped.ping).not.toHaveBeenCalled();
    });
});

describe("unifi websocket reconnect backoff", () => {
    test("doubles the delay up to the maximum and resets", () => {
        const backoff = createReconnectBackoff({ baseMs: 5000, maxMs: 60000, random: () => 1 });

        expect([1, 2, 3, 4, 5, 6].map(() => backoff.nextDelay())).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
        expect(backoff.attempts).toBe(6);

        backoff.reset();
        expect(backoff.nextDelay()).toBe(5000);
    });

    test("applies at most 20% jitter below the nominal delay", () => {
        const backoff = createReconnectBackoff({ baseMs: 5000, maxMs: 60000, random: () => 0 });
        expect(backoff.nextDelay()).toBe(4000);
    });
});
