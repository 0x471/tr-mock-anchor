# ZKPassport phone diagnostics: origin diagnosis and successful control

Updated 20 September 2026. The pre-Verify failure was traced to the origin of
Node-created SDK sessions. A genuine browser-origin request then completed on
the phone and passed native Soroban verification through Testnet RPC simulation.
No live request URL, nonce, proof, identity data, report upload, or external
support message is included here.

The reviewed request profile is SDK 0.17.1, domain `localhost`, `devMode: true`,
`compressed-evm`, age at least 18, a 64-character hexadecimal `custom_data`
binding, non-salted identifier type 0, and validity 3600 seconds. This note does
not establish compatibility with every app build. Record the actual app version
and precise phone stage when investigating a failure.

## Reproduce the supported browser flow

```sh
npm run zkpassport:browser -- --dev-mode
```

1. Open the printed `http://localhost:8792` URL in the computer's browser.
   Use `localhost`, not `127.0.0.1`; do not open this loopback address on the phone.
2. Click **Create synthetic request**. Copy the generated request link to the
   phone, or use the browser's QR-sharing feature if available. There is no
   built-in QR renderer on this diagnostic page.
3. Select a synthetic document in the phone's developer mode and approve the
   request. Keep the computer's browser tab and local server running.
4. Read events and the final compatibility summary in the browser. The terminal
   prints server startup information, not the final proof summary.

The default lifetime is ten minutes from server startup, including time before
the button is clicked. Restart the helper for a new session. Default mode does
not save a proof export. An explicit `--out /absolute/scratch/proof-export.json`
saves sensitive proof/public inputs to a new owner-only file; never commit it.
Do not use direct Node-created SDK sessions for this phone flow.

## Observed failure and successful control

The phone repeatedly showed the generic error before Verify was tapped. The SDK
reported a secure channel but no acceptance or proof callbacks. An age-only
control failed at the same stage, so custom-data binding was not required to
reproduce the error.

With SDK 0.17.1 and bridge 0.12.2, the actual Node WebSocket Origin was `nodejs`.
This was first captured on loopback, then confirmed with two synthetic peers on
the real production relay. The joiner established a secure channel, received
`peer.origin = "nodejs"`, and the unmodified pinned mobile `isOriginTrusted`
function returned false for `localhost` using the live public project config.
The relay test sent no acceptance or proof messages and closed both peers.
Bridge's Node default and origin-on-connect handling explain why changing the
claimed request domain does not change the actual creator origin.
[Published bridge creator source](https://unpkg.com/@obsidion/bridge@0.12.2/src/bridge.ts),
[relay-origin handling](https://unpkg.com/@obsidion/bridge@0.12.2/src/bridge-connection.ts).

Crucially, developer mode bypasses the access screen's confirmation gate, not
`WebSocketContext`'s subsequent origin validation. That provider rejects the
origin, reports a local `DOMAIN_VERIFICATION_FAILED` error, and closes the
connection without sending the SDK an error message. This explains the observed
secure-channel-only diagnostic pattern; no origin checks were disabled or
forged to fix it.
[Mobile origin predicate](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/lib/trustedOrigin.ts),
[post-handshake origin check](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/context/WebSocketContext.tsx#L236-L270).

A genuine browser-created request then completed on the phone. Recorded events
on 19 September 2026 UTC (20 September in Istanbul):

| Event                        | UTC time     |
| ---------------------------- | ------------ |
| `request_ready`              | 22:25:48.588 |
| `secure_channel`             | 22:27:23.844 |
| `generating`                 | 22:27:27.320 |
| `proof_received`             | 22:28:28.553 |
| `native_inspection_complete` | 22:28:29.985 |

The captured proof matched the supported profile: 9888 proof bytes and 320
public-input bytes. Native Testnet simulation returned `math_valid` at ledger 4766664. All four local request diagnostics were true: `scopes_match`,
`commitments_match`, `recent_timestamp`, and `non_salted_test_profile`.
`eligibility_status` remained `not_evaluated`; `payout_authorized` remained false.

This was a fresh phone proof checked through read-only simulation, not a freshly
committed verification transaction. The previously committed ledger-4766089
transaction used the separate historical July fixture. The successful control
establishes this phone/request/profile combination worked; it is not an audit,
proof of real identity, a universal app-version guarantee, or a payout gate.

## Source baselines

- Public mobile source: revision
  `c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e`. Its package declares version
  `1.1.0`; its circuit constant is `0.20.0`. These identify a public source
  snapshot, not the installed app, latest store release, or artifact actually
  used by this request. [Package](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/package.json),
  [circuit constant](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/lib/constants.ts).
- SDK: installed published `@zkpassport/sdk@0.17.1` and its bundled source map
  were inspected. Maintained SDK source at revision
  `75982c88e35c62e83e6e5405cac30ad24c1648f6` was checked separately. This does not
  assert that npm was built from that exact repository revision.
  [Published package metadata](https://registry.npmjs.org/@zkpassport/sdk/0.17.1),
  [pinned SDK source](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-sdk/src/index.ts).

## Domain and development-document prerequisites

The SDK normalizes a supplied domain; its constructor does not reject
`localhost`. The mobile access screen's confirmation gate accepts a verified
domain **or** developer mode, but this must not be read as a bypass of the
separate provider origin check described above. `localhost` itself was not the
failure: the genuine browser-origin localhost request succeeded.
[SDK constructor and request handling](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-sdk/src/index.ts),
[mobile domain gate, lines 334-352 and 1375-1388](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/AccessRequestView.tsx#L334).

Official setup has two parts: enable developer mode on the phone and set
`devMode: true` in the request. From the welcome screen, long-press the area
above the scan button; with an ID already loaded, use Settings, then Developer
Options. Enabling it loads selectable synthetic IDs issued by Zero Knowledge
Republic (ZKR). Confirm that a synthetic ID is actually selected, rather than
assuming the toggle selects the desired document. The documents have different
configurations; the docs do not promise every document satisfies age 18. Their
trust roots are in the Sepolia registry and the documented mock identifier is
1, so this is not real identity or uniqueness evidence.
[Official developer-mode instructions](https://docs.zkpassport.id/getting-started/dev-mode).

The self-served integration does not require dashboard domain registration.
Dashboard policies are a separate integration option.
[Official introduction](https://docs.zkpassport.id/intro).

## Proof mode and version constraints

`compressed-evm` is an official proof mode. The API documents validity in
seconds and supports a non-salted identifier without requiring strict
FaceMatch; the FaceMatch requirement applies to salted identifiers. The
onchain example combines age predicates and custom-data binding. These facts
confirm documented API shapes. The successful run above separately confirms
completion for the captured request/profile.
[API reference](https://docs.zkpassport.id/api),
[onchain request example](https://docs.zkpassport.id/getting-started/onchain).

The public mobile source explicitly includes `compressed-evm`. Its outer-proof
service sends a compression request to `/prove` on the configured cloud prover,
including the packaged circuit's Barretenberg version, verification key and
circuit information. The default endpoint is `https://cloud-prover.zkpassport.id`.
Thus this mode includes a cloud-compression stage; it is not wholly offline
phone computation. No standalone cloud-prover probe was needed to diagnose the
pre-acceptance failure; the successful phone request used the normal proof flow.
[Mode definitions](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/types/ProofService.ts#L103),
[outer-proof service](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/services/ProofService/OuterProofService.ts#L190),
[default endpoint](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/lib/constants.ts).

The changelog records historical SDK/app compatibility breaks, including old
app versions that could fail with binding. Those historical minimum versions
are **not** a complete SDK 0.17.1 compatibility matrix. No authoritative table
establishing the user's installed build's compatibility was found in the
reviewed sources. Do not prescribe a downgrade or infer version mismatch from
the generic error alone. [Official changelog](https://docs.zkpassport.id/changelog).

## Safe evidence collection and reporting

In the inspected SDK, `onRequestReceived` fires when the secure channel is
established; it is not evidence of user acceptance. `onGeneratingProof`
follows acceptance and `onProofGenerated` reports a proof
artifact. `onError` supplies a string, if the error reaches that callback.
Receipt alone does not demonstrate proof generation or verification. Prefer
recording event names, relative elapsed times, and a sanitized error code/text.
Do not enable indiscriminate debug-log sharing: the SDK's debug calls include
decrypted message objects and request topics.
[SDK callbacks and message handling](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-sdk/src/index.ts),
[callback documentation](https://docs.zkpassport.id/api).

The public mobile error overlay offers a report action and a dismiss action.
The report action submits the stored error log; it is not a documented local
sanitized-export command. The privacy policy says optional reports can contain
device/app/OS versions, proof-step timings, error details, and limited document
metadata including issuer, document type, and expiry. Reporting is optional;
do not automatically enable or submit it.
[Error overlay](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/Modals/ErrorReporting/ErrorOverlay.tsx#L54),
[official reporting privacy notice](https://zkpassport.id/privacy-policy).

The official FAQ links to its issue-reporting site and asks for reproduction
steps, app version, device model, and document type/country without sensitive
information. For this test, identify the document only as a ZKR synthetic
fixture; no real document details are needed. A cropped generic-error screen
and typed stage/version information can be reviewed locally before any report.
Do not include request links/QRs, topics, nonces, proof exports, passport fields,
or diagnostic dumps without inspecting and sanitizing them.
[Official issue-report guidance](https://docs.zkpassport.id/faq#how-can-i-report-an-issue-im-facing-with-the-app).

## Remaining limits and future failures

Record the installed app build/release channel, device model, and OS version
for repeatability; the public source pin does not identify the installed binary.
For a new failure, capture the stage, elapsed time, and sanitized SDK error
category. Distinguish transport/origin errors from proof generation, unsupported
profiles, and native verification errors. Do not infer a version mismatch from
the generic overlay or extrapolate this successful synthetic run to real IDs.

The verifier still checks proof mathematics rather than an enforced eligibility
and settlement policy. Request diagnostics and a valid proof do not approve
KYC, authorize a payout, or change the default fail-closed anchor mode.
