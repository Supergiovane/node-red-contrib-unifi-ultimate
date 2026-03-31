# UniFi API Expert

This plugin adds a Codex agent specialized in Ubiquiti UniFi APIs, with the deepest coverage aimed at the official UniFi Protect `v6.2.88` documentation.

Included files:
- `agents/openai.yaml` for the plugin-facing agent metadata
- `agents/unifi-protect-api-expert.md` for the agent prompt and operating rules
- `.codex-plugin/plugin.json` for the plugin manifest

What the agent is optimized for:
- Mapping Protect requirements to the right REST endpoint
- Translating between local `/integration/...` paths and cloud connector paths via `https://api.ui.com`
- Explaining request and response schemas for cameras, lights, chimes, sensors, viewers, live views, NVR details, and media features
- Debugging permissions, timeouts, rate limits, and connector forwarding issues

Official documentation used as grounding:
- `https://developer.ui.com/protect/v6.2.88/gettingstarted`
- `https://developer.ui.com/protect/v6.2.88/connectorget`
- `https://developer.ui.com/protect/v6.2.88/get-v1metainfo`
- `https://developer.ui.com/protect/v6.2.88/get-v1cameras`
