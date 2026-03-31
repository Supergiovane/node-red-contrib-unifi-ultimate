# node-red-contrib-unifi-ultimate

Node-RED nodes for Ubiquiti UniFi integrations, starting with UniFi Protect.

Current release status: `0.1.0-beta.1`

## Included in this first version

- `Unifi Protect Device`: generic Protect object node with discovery of device types, instances, and supported capabilities
- `Unifi Protect Config`: shared configuration node for controller IP, API key header, API key, and TLS behavior

## Supported Protect device types

- `Camera`
- `Sensor`
- `Light`
- `Chime`
- `Viewer`
- `Live View`
- `NVR`

## Supported capabilities

Common capabilities:

- `Observe`
- `Get details`
- `Patch settings`

Camera-specific capabilities:

- `Get snapshot`
- `Get snapshot` with `High quality` option
- `Get RTSPS streams`
- `Create RTSPS streams`
- `Delete RTSPS streams`
- `Create talkback session`
- `Disable microphone permanently`
- `Start PTZ patrol`
- `Stop PTZ patrol`
- `Go to PTZ preset`
- `Set doorbell message`
- `Set property`

Patchable object capabilities:

- `Set property` for `Camera`, `Sensor`, `Light`, `Chime`, `Viewer`, and `Live View`

Viewer-specific capabilities:

- `Set live view`

## Configuration model

The config node asks only for the UniFi OS controller IP or `host[:port]`.

The package builds the Protect base URL automatically as:

- `https://<IP>/proxy/protect/integration`

The nodes append the operation path automatically, for example `/v1/meta/info`, `/v1/cameras`, or `/v1/sensors/:id`.

The API key header is configurable. The default is `X-API-Key`.

## Runtime behavior

The `Device` node supports runtime overrides via `msg`:

- `msg.deviceType`
- `msg.deviceId`
- `msg.capability`
- `msg.capabilityConfig`
- `msg.params`
- `msg.query`
- `msg.headers`
- `msg.payload`

Some capabilities expose options discovered from Protect and configured directly in the editor. For example:

- `Observe` on `Sensor` lets you choose which boolean observable to monitor
- `Observe` on `Camera` lets you choose boolean event-driven observables like ring, motion, and smart detections
- `Observe` on `Light` lets you choose boolean observables like motion or light on/off
- `Go to PTZ preset` can offer PTZ preset choices for the selected camera
- `Start PTZ patrol` offers patrol slot selection
- `Set doorbell message` guides predefined/custom/image doorbell messages and can load image assets from Protect
- `Set live view` can offer available live views for the selected viewer
- `Set property` discovers patchable properties from the selected device payload and adapts the value field to booleans, numbers, strings, or related object selections

In these cases, the node can be triggered by any input message and will build the correct request from the selected capability options.

For `Sensor + Observe`:

- `msg.payload` is normalized to `true` or `false`
- the full original device/event context is exposed in `msg.RAW`

The same boolean-output pattern now also applies to supported `Camera + Observe` and `Light + Observe` observables.

Output fields:

- Output 1: state or main capability response
- Output 2: Protect events for the selected device when capability is `Observe`
- `msg.unifiProtect`: standardized device metadata
- `msg.device`: last known object payload, when available
