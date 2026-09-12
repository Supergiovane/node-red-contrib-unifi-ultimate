# Project preferences

- Run tests only immediately before a commit. Do not run test suites, test commands or test-like verification during editing or intermediate reviews unless the user explicitly requests it. Do not create a commit merely to run tests.
- Keep node editors concise. Allow a few short inline tips only where they help fill in a field; put detailed requirements and examples in the HTML help. Do not add explanatory panels or `form-tips unifi-ultimate-info-tip` blocks.
- Under Protect's Action selector, actions requiring a local account should show only: `Requires a Protect API key with permission for this action.` Explain the local account in the HTML help.
- Every LPR reading, including corrected text or higher-confidence readings of the same plate, must emit the plate string in `msg.payload`. Do not use `msg.details.lpr.revision`; confidence and update flags are supporting metadata only.
