# Testnet policy root snapshot

Checked 20 September 2026 using the published @zkpassport/registry 0.14.0 client
installed under the pinned SDK 0.17.1. These are public trust configuration,
not identity data. No root is accepted merely because it appears in a proof.

## Independently read registry state

RootRegistry address on the queried EVM networks:
`0x1D0000020038d6E40E1d98e09fA1bb3A7DAA8B70`.

Synthetic document certificate root, Ethereum Sepolia (chain 11155111):

`0x0230cf7904896615a2fab194d5d0e7115bce9749aaaf61805fea7aaf1c8200c0`

- Registry index 27, 586 leaves, valid from 2026-05-06T02:01:14Z.
- getLatestCertificateRoot returned this root.
- isCertificateRootValid returned true; details reported revoked=false and latest=true.
- Published certificate CID: QmUyw6L8meKuYcYY8eWTfVttXkf2MdNGvtwmEAPQdUdmyA.

Circuit root, Ethereum mainnet (chain 1, read-only lookup):

`0x1bcacb8abb52ef2834e4862b264e1209368ac8e006aa8512f6d62116e8657a46`

- Registry index 10, 790 leaves, valid from 2026-07-14T07:14:26Z.
- getLatestCircuitRoot returned this root.
- isCircuitRootValid returned true; details reported revoked=false and latest=true.
- Published circuit CID: Qma1e2Mc3YeWATjPN6RynBAJ1JZo1WqokYciJmohuXj1th.

The separate fresh synthetic phone proof happened to use these same roots and
mock non-salted nullifier type 2 with zero OPRF key hash. The registry reads,
not the submitted proof, establish the proposed trust snapshot.

## Trust model and deployment rule

Soroban does not read Ethereum registry state directly. A deployment that pins
these roots trusts its deployer to select an authentic registry snapshot. This
is not a cross-chain light client and must not be advertised as one.

Revalidate the roots and revocation status immediately before deployment.
Pin an explicit short deployment validity window on chain and fail closed
after it. Changing approved roots or policy requires a newly identified vault;
it must not silently change outstanding order terms. Future production use
needs a reviewed root-update and revocation mechanism, not just this demo snapshot.

## Sources

- [Published registry package](https://registry.npmjs.org/@zkpassport/registry/0.14.0).
- [Mobile dev-mode certificate chain selection](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/AccessRequestView.tsx#L567).
- [Mobile circuit registry chain selection](https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/lib/circuit-matcher.ts#L139).
- [Official dev-mode guidance](https://docs.zkpassport.id/getting-started/dev-mode).
