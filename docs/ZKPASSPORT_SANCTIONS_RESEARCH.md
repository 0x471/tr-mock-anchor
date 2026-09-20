# ZKPassport sanctions predicate

Reviewed 2026-09-20. This research does not activate a new deployment or claim
that a phone-generated sanctions proof has passed our Soroban verifier.

## Conclusion

ZKPassport already supports private document-holder sanctions exclusion. It
is different from the anchor's exact public wallet-address precheck. The SDK
request is `.sanctions("all", "all", { strict: true })`; the current API checks
the combined US, UK, EU and Swiss lists, not an independently selectable
OFAC-only list. `strict: false` is the SDK default. These are released features,
not only a roadmap claim: the changelog introduced sanctions in v0.8.3 and
expanded the jurisdictions in v0.11.0. Sources:
[API](https://docs.zkpassport.id/api#sanctions),
[changelog](https://docs.zkpassport.id/changelog).

Use a separate label, such as "Private sanctions snapshot check", for the
document predicate. Do not rename the wallet precheck or treat one as a
replacement for the other: the checked identifiers, source transformation and
trust boundary differ. This is an engineering recommendation, not legal advice.

## Versioned evidence

The repository installs `@zkpassport/sdk` 0.17.1 and `@zkpassport/utils` 0.38.0.
The installed declarations contain the sanctions query and committed-input
types. The following source snapshots were inspected independently:

- Packages: `75982c88e35c62e83e6e5405cac30ad24c1648f6`; its
  [SDK package](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-sdk/package.json)
  declares 0.17.1. No npm `gitHead` was returned, so this is a pinned source
  snapshot, not a claim of a reproducible npm-to-Git provenance attestation.
- Circuits: `9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2`.
- Mobile app: `c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e`.
- Docs: `665a7603031ee38a1b5280796fbb40fec12f481d`.

The docs changelog's latest-version heading lags the installed SDK. Use the
installed package and pinned source for the exact interface, rather than
inferring compatibility from that heading. The
[query builder](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-sdk/src/index.ts#L460)
still leaves custom-list selection disabled.

## What the proof checks

The phone derives normalized MRZ name combinations, name plus date of birth,
name plus year of birth, and document number plus nationality. Standard mode
checks the latter combinations. Strict mode additionally checks name-only
combinations. The tree uses exact Poseidon2 hashes of these formatted values;
this is not a generic fuzzy-matching API. Strict mode can reject unrelated
people sharing a name. It is not universally "better", but is a reasonable
explicit demo policy for synthetic documents. Source:
[sanctions builder](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-utils/src/circuits/sanctions/sanctions.ts).

The Noir circuit connects the hidden document inputs to the existing identity
commitment, checks document expiry, proves non-membership and returns a
commitment to the sanctions root and strictness setting. A verifier must require
the correct root and strictness, not just a callback claiming `passed: true`.
Sources:
[sanctions circuit](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/noir/bin/exclusion-check/sanctions/evm/src/main.nr),
[constraint library](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/noir/lib/exclusion-check/sanctions/src/lib.nr).

The existing age/country proof does not retroactively include this predicate.
Nor does ZK exclusion establish full AML/CTF checks or that an identity document
was not reported stolen. Source:
[ZKPassport's stated limitations](https://docs.zkpassport.id/examples/kyc).

## Dataset provenance and freshness

The public tree-generation script downloads OpenSanctions datasets
`us_ofac_sdn`, `gb_fcdo_sanctions`, `eu_fsf` and `ch_seco_sanctions`, transforms
person data into MRZ-compatible identifiers, and builds a combined depth-18
ordered Merkle tree. This differs from directly downloading today's official
OFAC SDN XML in the wallet precheck. Sources:
[tree generation](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/ts/sanctions/trees/generate.ts),
[OpenSanctions transformation](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/ts/sanctions/scripts/parse_opensanctions.py).

The installed builder downloads
[ZKPassport's combined tree](https://cdn.zkpassport.id/sanctions/all_sanctions_tree.json.gz).
Observed on 2026-09-20:

- Root: `0x2dfcc0ca426d9d8e751bb00fc9ab502bfb081ba8d2ce3f5f94a8f1712b3afca8`.
- HTTP Last-Modified: `2026-01-25T20:48:24Z`.
- HTTP ETag: `7529831371a67ebdcfb02674485e3544`.

The root was separately checked through read-only Ethereum RPC calls at block
26,015,652, observed at `2026-09-20T02:11:58.405Z`:

- RootRegistry: `0x1D0000020038d6E40E1d98e09fA1bb3A7DAA8B70`.
- Registry ID 3 resolves to sanctions registry
  `0x820cc0becfd3d8467b21fc8b88336abced0df824`.
- `latestRoot(3)` returned the same root; `isRootValid(3, root, now)` was true.
- Registry details: index 5, valid-from `2026-01-25T20:50:47Z`, valid-to 0,
  not revoked, 126,590 leaves.

Addresses and call signatures were resolved from the
[official registry client](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-sdk/src/client.ts)
and its
[constants](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-sdk/src/constants.ts).
These are point-in-time RPC observations, not a cross-chain state proof.

The root being registry-valid does not establish that it reflects today's
sanctions data. The registry accepts its latest non-revoked root without
requiring a recent update; older roots use its configured validity window.
Sources:
[registry validation](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-contracts/src/RegistryInstance.sol#L281),
[sanctions registry configuration](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-contracts/src/registries/SanctionsRegistry.sol).

For a demo, explicitly pin this snapshot with a bounded policy expiry and
show its age. Do not call it a fresh OFAC clearance. Copying the root to
Soroban creates a trusted updater/configuration boundary; it is not native
verification of Ethereum registry state. A current-list guarantee needs a
separate update/provenance policy, which has not been established here.

## Commitment and proof-profile requirements

The compressed-EVM sanctions committed-input record is 36 bytes:

| Bytes | Meaning                                 |
| ----- | --------------------------------------- |
| 0     | Proof type 9                            |
| 1-2   | Big-endian payload length 33 (`0x0021`) |
| 3-34  | Big-endian 32-byte sanctions root       |
| 35    | Strictness, 0 or 1                      |

The circuit hashes that record with SHA-256 and packs the first 31 digest
bytes as a field. It does not reduce the entire 32-byte digest modulo the
field. The standard, non-EVM variant instead uses
`Poseidon2([9, 2, root, strict])`. Sources:
[Noir commitment](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/noir/lib/exclusion-check/sanctions/src/param_commit.nr),
[field packing](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/zkpassport-utils/src/utils.ts#L175),
[proof types](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-contracts/src/lib/Types.sol#L17).

For the observed root, independently computed EVM commitments are:

```text
strict=false: 0x00ed19a8809304eda854b241e3841938f2011b9ce7a9c392fdbaa02382539b8d
strict=true:  0x006f97b7c86e5e666d8a256002ff4f9ca418115bb9a4d13a7161d73896025b3b
```

Adding sanctions adds one disclosure proof. The app selects the outer circuit
by disclosure count plus three base proofs: four disclosures use
`outer_evm_count_7`; five use `outer_evm_count_8`. Therefore the current
age/nationality/issuer/bind request plus sanctions needs a different outer
verification key/profile, not just a frontend checkbox. Source:
[mobile circuit selection and sanctions construction](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/lib/circuit-matcher.ts#L281).

Public-input positions are circuit-version-specific. Current documentation
includes certificate root, circuit root, timestamp, scopes, parameter
commitments and nullifier metadata; do not transplant its latest indices into
an older pinned Soroban profile without checking the actual vkey and parser.
Source: [onchain layout](https://docs.zkpassport.id/getting-started/onchain).

## EVM helper behavior to preserve on Soroban

The official Solidity helper extracts exactly one sanctions record, enforces
the requested strictness, and checks the trusted sanctions registry at the
proof timestamp. Its corresponding call is
`enforceSanctionsRoot(proofTimestamp, expectedStrict, committedInputs)` after
cryptographic verification and parameter-commitment validation. Sources:
[helper](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-contracts/src/VerifierHelper.sol#L383),
[record extraction](https://github.com/zkpassport/zkpassport-packages/blob/75982c88e35c62e83e6e5405cac30ad24c1648f6/packages/registry-contracts/src/lib/InputsExtractor.sol#L273).

Equivalent Soroban policy must require the exact sanctions commitment, pinned
root, strictness and expiration together with all existing predicates,
wallet/order binding, freshness, approved circuit roots and vkey. Reject a
proof missing the sanctions record, using another root or profile, or
weakening strictness. These are integration requirements inferred from the
upstream verification model, not evidence they are already deployed here.

## Synthetic test evidence and remaining gate

Developer mode supports ZKR mock passports. The mobile source includes a
synthetic John fixture and a fixture named Mister Sanctioned. Sources:
[developer mode](https://docs.zkpassport.id/getting-started/dev-mode),
[mock documents](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/assets/mock-data/passport.ts).

This review called installed `SanctionsBuilder.getSanctionsMerkleProofs` with
only those public synthetic MRZ fixtures, using the downloaded tree. Both
fixtures produced non-membership paths in both modes. In particular, the
fixture's name alone does not make Mister Sanctioned a reliable negative test
against the live CDN tree. No real document data was used or sent externally.
This exercised Merkle-input construction, not mobile proving or onchain ZK
verification.

Before advertising active onchain sanctions checks, generate a fresh synthetic
phone proof with the new query, confirm the exact returned profile/version,
simulate and verify it on Soroban, then test omitted sanctions, wrong root,
wrong strictness, altered commitment, stale policy, wrong wallet and wrong
order. Preserve previously reserved orders under their original policy. A
synthetic deny-list unit fixture is useful, but must not be presented as an
official sanctions listing or a successful live negative phone proof.
