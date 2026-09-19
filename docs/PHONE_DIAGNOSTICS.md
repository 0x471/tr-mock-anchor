# ZKPassport phone diagnostics: primary-source facts

Checked 20 September 2026. This is a documentation/source review, not a diagnosis
or a successful phone test. No live request URL, nonce, proof, identity data,
report upload, or external support message is included.

The reviewed request profile is SDK 0.17.1, domain `localhost`, `devMode: true`,
`compressed-evm`, age at least 18, a 64-character hexadecimal `custom_data`
binding, non-salted identifier type 0, and validity 3600 seconds. This note does
not establish compatibility with every app build. Record the actual app version
and precise phone stage when investigating a failure.

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

The SDK normalizes a supplied domain and requires an explicit domain in Node.
The inspected constructor does not reject `localhost`. In the public mobile
snapshot, `AccessRequestView` skips domain verification when the request has
`devMode` enabled, and its confirmation gate accepts a verified domain **or**
developer mode. Consequently, these sources do not establish a prohibition on
`localhost` for this development request. They are not an end-to-end guarantee
for the user's installed app, and do not establish the cause of its error.
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
confirm documented API shapes, not that this specific request completed.
[API reference](https://docs.zkpassport.id/api),
[onchain request example](https://docs.zkpassport.id/getting-started/onchain).

The public mobile source explicitly includes `compressed-evm`. Its outer-proof
service sends a compression request to `/prove` on the configured cloud prover,
including the packaged circuit's Barretenberg version, verification key and
circuit information. The default endpoint is `https://cloud-prover.zkpassport.id`.
Thus this mode includes a cloud-compression stage; it is not wholly offline
phone computation. No cloud-prover request was made for this review.
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

## Evidence still needed

- Installed app version/build and release channel, device model, and OS version.
- Confirmation that a ZKR synthetic ID is selected and its age criterion passes.
- Whether failure is before approval, during base proofs, during outer
  compression, or while returning results; visible stage and elapsed time.
- Sanitized SDK error text/code, if any, and whether generation/proof callbacks
  occurred after request receipt.

These observations can distinguish stages. None of the facts above identifies
the cause of this particular failure or establishes a fix.
