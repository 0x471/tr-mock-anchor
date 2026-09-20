# OFAC listed-address precheck

Reviewed 2026-09-20. This is a Testnet demo feature, not a compliance decision.

## Scope

Check the authenticated Stellar wallet's public address against the digital
currency identifiers in OFAC's official SDN download. Do not collect passport
names, document numbers or birth dates. The existing ZKPassport predicates do
not establish a person's absence from sanctions lists.

OFAC's identifier search uses exact matching, not fuzzy name matching. Its
digital currency records identify the currency in a field beginning with
`Digital Currency Address -`, followed by the identifier. OFAC explicitly warns
that these address listings are not exhaustive. A negative result therefore
means only **no exact listed-address match**, never "cleared", "not sanctioned"
or "OFAC verified". Sources: [FAQ 594](https://ofac.treasury.gov/faqs/594),
[FAQ 563](https://ofac.treasury.gov/faqs/563),
[FAQ 562](https://ofac.treasury.gov/faqs/562).

## Official source and format

- Download: [SDN.XML](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML).
- Schema: [XML.xsd](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML.xsd).
- Smaller equivalent download: [SDN_XML.ZIP](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_XML.ZIP).
- Service and API documentation: [SLS](https://ofac.treasury.gov/sanctions-list-service)
  and [official API document](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/APIDocumentation.docx).

The official SLS application links these exports. Legacy XML is sufficient for
this small identifier-only check: the advanced XML contains the same core list
data with additional metadata. Sources:
[OFAC's XML format explanation](https://ofac.treasury.gov/sdn-list-data-formats-data-schemas/frequently-asked-questions-on-advanced-sanctions-list-standard),
[compressed XML notice](https://ofac.treasury.gov/recent-actions/20170222).

The schema uses `sdnList/publshInformation` (the missing "i" is intentional),
with `Publish_Date` and `Record_Count`. Each `sdnEntry` can contain
`idList/id/idType` and `idNumber`. Preserve identifier strings exactly, rather
than converting them to numbers. The current namespace is
`https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML`.
Sources: [official schema](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML.xsd),
[namespace change notice](https://ofac.treasury.gov/recent-actions/20240507_44).

Send an explicit server-side User-Agent: OFAC documents 403 failures when it is
absent. Downloads can redirect to short-lived signed Treasury S3 URLs; store
the stable official source URL, not a redirect token. Sources:
[OFAC technical notice](https://ofac.treasury.gov/sdn-list-data-formats-data-schemas/ofac-technical-actions-in-reverse-chronological-order/20240516_44),
[official export](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML)
(redirect observed during this review).

## Observed coverage, not a permanent guarantee

The full SDN XML obtained from the official ZIP during this review declared
publication date 2026-09-18 and 19,393 entries; the entry count matched. It was
approximately 29.1 MB. Twenty digital-currency labels were present, including
XBT, ETH, TRX, SOL and USDC, but no XLM label. This is snapshot-specific and must
not become a hard-coded assumption. Source:
[official SDN XML ZIP](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_XML.ZIP).

A subsequent live check through the implemented plain-XML downloader completed
at 2026-09-20T01:41:27.836Z: 1,043 unique digital identifiers, zero valid Stellar
public keys and zero XLM labels. Publication date remained 2026-09-18. The
received XML's SHA-256 was
`30c2a70887d694f7242254e96d505a9bc67b19ef4c246ae9fc7d21ad7e9101b9`.
This test used a synthetic wallet and sent only a list-download request, not
the wallet, to OFAC. Source:
[official SDN XML](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML).

The separately downloaded consolidated non-SDN XML declared 2026-09-14, with
481 entries and no digital-currency identifier fields in this snapshot. The
demo's check is explicitly SDN-only, not a claim to cover all sanctions lists
or restrictions. Sources:
[consolidated XML](https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/consolidated.xml),
[OFAC's separate-list description](https://ofac.treasury.gov/sanctions-list-service).

## Implementation policy

The following are engineering choices for this demo, not OFAC requirements:

- Fetch the list server-side without sending customer wallet addresses to an
  external search service. Keep only exact identifiers and source metadata in
  the in-memory cache. Do not persist the full feed or real names as fixtures.
- Match valid Stellar public keys exactly against all digital-currency ID
  fields. Do not restrict extraction to the currently absent XLM label.
- Refresh after 15 minutes. If a required refresh fails, return unavailable;
  do not use an old no-match result. Coalesce simultaneous refresh requests.
- Track successful fetch time separately from the list's publication date.
  An unchanged list over a weekend does not imply download failure. Do not
  invent an OFAC publication cadence or treat HTTP Last-Modified as a signature.
- Bound response size and duration; reject malformed XML, DTD/entity
  declarations, missing metadata, inconsistent entry counts and an empty
  digital-address inventory. Zero Stellar-format addresses is valid.
- Record source URL, publication date, fetch time and SHA-256 of received
  bytes. The digest provides reproducibility, not independent authenticity.
- Block new order reservation when matched or unavailable, before order or
  idempotency-key mutation. Preserve existing owned-order recovery. The
  endpoint must derive the wallet from the authenticated session.
- Display the check's narrow scope and distinguish matched, no exact match,
  and unavailable. Tests use only synthetic identities and addresses.

This is an anchor-backend precheck. It is not a new Soroban sanction proof and
does not alter the native onchain ZKPassport gate. Client-side display cannot
enforce it; backend reservation checks can enforce it only for that backend's
entry path. Non-bypassable contract enforcement would require an explicit
contract policy, freshness-bound trusted list commitment or attestation,
wallet/order binding and a defined updater trust model. Do not claim that
this backend feature enforces global onchain sanctions or proves a document
holder is not sanctioned.
