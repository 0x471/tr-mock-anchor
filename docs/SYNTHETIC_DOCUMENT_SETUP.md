# Synthetic document setup: current capability and blocker

Checked 20 September 2026. Primary sources only. This note does not change the
vault, generate certificates, use real identity data, or claim a completed proof.

## Conclusion

No supported stock-app workflow was found for creating or importing an adult
synthetic passport with both nationality `TUR` and issuing country `TUR` while
keeping this deployment's existing trust roots. The official workflow loads
fixed Zero Knowledge Republic (`ZKR`) mock IDs. The current public mobile source
contains seven such fixtures, all with `ZKR` nationality and `P<ZKR` MRZ issuer.
An adult fixture can pass age 18, but cannot truthfully pass the unchanged two
`TUR` predicates. This explains a policy mismatch, not a verifier defect.
[Official dev-mode documentation][dev-mode], [bundled fixture definitions][fixtures]

The checked public mobile `main` revision is
`c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e` (17 July 2026), independently rechecked
through the GitHub API. Source-defined UI is not a claim that the installed phone
binary is identical; no phone menu was operated during this research.
[Current public revision][mobile-head]

## Supported stock mock setup

1. In an app already containing IDs, open the settings gear from **Your IDs**,
   select **Developer Options**, then enable **Enable Developer Mode**.
2. On a fresh empty welcome screen, the official instructions instead use a
   long press in the blank area just above **Scan your ID**.
3. Return to **Your IDs** and swipe between the bundled mock cards. Both app
   developer mode and the request's `devMode: true` are required for mock use.
   [Official instructions][dev-mode], [toggle implementation][toggle]

The loader activates the first bundled ID, **John Smith**, whose synthetic DOB
is `951112` (12 November 1995). It is an adult fixture in September 2026, but its
nationality and issuer remain `ZKR`. Other bundled fixtures include minors, so
age eligibility must not be assumed for every card. The loader does not accept
custom country or DOB parameters.
[Loader and first selection][loader], [John and other fixed fixtures][fixtures]

The inspected Developer Options page has a mode toggle, not a document editor.
The scan flow's manual MRZ screen asks for document number, DOB and expiry as
inputs to the subsequent NFC read; it is not a synthetic passport generator and
does not offer nationality/issuer selection.
[Developer Options][toggle], [manual MRZ fields][manual], [subsequent NFC flow][scan]

## Why a generator is not an established workaround

The official `zkpassport-test-utils` repository contains certificate and SOD
generation helpers, but is archived. At its pinned revision
`c7d622bc948d41bac0d9c42dd74fda9d49cdd380`, `generateSigningCertificates` creates
a new CSC key and a new DSC certificate chain. That is a test-fixture tool, not
a documented stock-phone import workflow. A newly generated root is not thereby
a member of the vault's pinned certificate registry root. No supported path was
found that issues a customized TUR/TUR fixture under an already trusted mock
certificate and imports it into the released phone app.
[Archived official repository][test-utils], [certificate generator][generator]

Editing the mock card's displayed country or replacing its MRZ is not a valid
solution: the passport data groups are hashed into the SOD and signed. A custom
development build would still need a correctly signed synthetic fixture, trusted
certificate membership, and a successful fresh native proof. None of those steps
has been established for a customized Turkish fixture here.
[SOD hash construction][sod], [mobile fixture SOD and DG1 linkage][fixtures]

## Real Turkish documents are a different mode

Do not scan a real Turkish ID to work around this demo's mismatch. The deployed
gate intentionally requires synthetic nullifier type 2, zero OPRF hash and a
pinned dev-mode certificate-root snapshot. The mobile source selects Ethereum
Sepolia certificate registry in dev mode and Ethereum mainnet otherwise. A real
document is not converted into a mock by toggling developer mode. Whether a
particular real document is supported by ZKPassport is also not established by
this research. Production-document support would require a separately reviewed
policy/trust configuration and explicit user consent, not reuse of this mock
vault unchanged.
[Mobile registry selection][registry-selection],
[this vault's policy checks](../contracts/anchor-gate/src/lib.rs),
[authenticated root snapshot](TRUST_ROOT_SNAPSHOT.md)

## Concrete choices requiring user direction

- Keep the existing TUR/TUR vault unchanged. Treat the stock ZKR rejection as a
  negative control; a positive test remains blocked until ZKPassport provides or
  documents a compatible trusted synthetic fixture and stock-app loading route.
  No request to maintainers has been sent.
- With explicit approval, deploy a separately identified synthetic demonstration
  vault requiring age 18 and `ZKR` nationality/issuer. Use a bundled adult mock.
  This preserves native proof and country-policy enforcement but demonstrates
  the mock issuer policy, not Turkish eligibility. Do not silently relabel or
  mutate the existing TUR/TUR deployment. Count7 shape remains applicable, but a
  fresh positive proof and full settlement still need execution.

No verified instruction to select a Turkish mock exists in the inspected stock
UI. Absence from this bounded source review is not proof that no private or
future upstream tooling exists.

[dev-mode]: https://docs.zkpassport.id/getting-started/dev-mode
[mobile-head]: https://api.github.com/repos/zkpassport/mobile-app/commits/main
[fixtures]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/assets/mock-data/passport.ts#L15-L72
[toggle]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/settings/DeveloperOptionsPage.tsx#L16-L56
[loader]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/context/SettingsContext.tsx#L580-L609
[manual]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/ScanPassport/ManualMRZEditor.tsx#L194-L224
[scan]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/ScanPassportView.tsx#L330-L332
[test-utils]: https://github.com/zkpassport/zkpassport-test-utils
[generator]: https://github.com/zkpassport/zkpassport-test-utils/blob/c7d622bc948d41bac0d9c42dd74fda9d49cdd380/src/passport-generator.ts#L90-L172
[sod]: https://github.com/zkpassport/zkpassport-test-utils/blob/c7d622bc948d41bac0d9c42dd74fda9d49cdd380/src/sod-generator.ts#L121-L160
[registry-selection]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/components/AccessRequestView.tsx#L554-L576
