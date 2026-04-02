<p align="center">
  <img src="nodes/icons/unifi-ultimate-logo.svg" alt="Unifi Ultimate" width="720">
</p>

# node-red-contrib-unifi-ultimate

Node-RED nodes for Ubiquiti UniFi integrations, currently covering UniFi Protect and a first UniFi Access beta.

Current release status: `0.1.0-beta.5`

[View Changelog](CHANGELOG.md)

## Included in this first version

- `Unifi Protect Device`: generic Protect object node with discovery of device types, instances, and device-specific capabilities
- `Unifi Protect Config`: shared configuration node for controller IP, API key header, API key, and TLS behavior
- `Unifi Access Device`: first generic Access node focused on doors, Access devices, notification events, and safe doorbell control
- `Unifi Access Config`: shared configuration node for host, bearer token, and TLS behavior

## Example flows

- [examples/unifi-protect-info.json](examples/unifi-protect-info.json): basic Protect camera observe example
- [examples/unifi-protect-sensor-observe.json](examples/unifi-protect-sensor-observe.json): Protect sensor boolean observe example
- [examples/unifi-protect-camera-actions.json](examples/unifi-protect-camera-actions.json): Protect snapshot, PTZ preset, and doorbell message examples
- [examples/unifi-access-door-control.json](examples/unifi-access-door-control.json): Access door observe, unlock, and temporary lock rule examples
- [examples/unifi-access-intercom-doorbell.json](examples/unifi-access-intercom-doorbell.json): Access intercom observe, trigger doorbell, and safe cancel example

## Supported Access device types

- `Door`
- `Access Device`

## Supported Access capabilities

Common capabilities:

- `Receive Events`
- `Read State`

Door-specific capabilities:

- `Unlock Door`
- `Read Lock Rule`
- `Set Temporary Lock Rule`
- `Read Emergency Mode`
- `Set Emergency Mode`

Access device-specific capabilities:

- `Read Access Methods`
- `Update Access Methods`
- `Trigger Doorbell`
- `Cancel Doorbell`

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

- `Receive Events` on `Sensor` lets you choose which boolean observable to monitor
- `Receive Events` on `Camera` lets you choose boolean event-driven observables like ring, motion, and smart detections
- `Receive Events` on `Light` lets you choose boolean observables like motion or light on/off
- `Recall PTZ Preset` can offer PTZ preset choices for the selected camera
- `Start PTZ Patrol` offers patrol slot selection
- `Show Doorbell Message` guides predefined/custom/image doorbell messages and can load image assets from Protect
- `Switch Live View` can offer available live views for the selected viewer
- `Update One Property` discovers patchable properties from the selected device payload and adapts the value field to booleans, numbers, strings, or related object selections

In these cases, the node can be triggered by any input message and will build the correct request from the selected capability options.

For `Sensor + Receive Events`:

- `msg.payload` is normalized to `true` or `false`
- the full original device/event context is exposed in `msg.RAW`

The same boolean-output pattern also applies to supported `Camera + Receive Events` and `Light + Receive Events` observables.

Output fields:

- Output 1: state or main capability response
- Output 2: Protect events for the selected device when capability is `Receive Events`
- `msg.unifiProtect`: standardized device metadata
- `msg.device`: last known object payload, when available

For the first UniFi Access beta:

- `Receive Events` performs an initial state fetch and then listens to the official Access notifications WebSocket
- Output 1 carries the current door/device state or the main response
- Output 2 carries matching Access notification events
- `msg.unifiAccess` contains standardized metadata for Access nodes
- `Cancel Doorbell` returns `msg.payload.skipped = true` when the shared Access config node is not currently tracking any active ring
