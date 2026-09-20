# Self-hosted interface fonts

Source: [Google Fonts](https://github.com/google/fonts), pinned to commit
[`f2bd09badbc763d8757951d52deec29da27e85fb`](https://github.com/google/fonts/commit/f2bd09badbc763d8757951d52deec29da27e85fb)
(committed 2026-09-18T21:40:37Z).

The font binaries are unmodified upstream TrueType files. Local filenames are
shortened for the asset routes; their embedded font names and license metadata
are unchanged. Browser requests remain on the anchor's own origin.

| Local file                  | Pinned upstream source                                                                                                                                                      | Size         | Axes                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------- |
| playfair-display.ttf        | [Playfair Display regular](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf)       | 300724 bytes | Weight 400-900               |
| playfair-display-italic.ttf | [Playfair Display italic](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf) | 278688 bytes | Weight 400-900               |
| ibm-plex-sans.ttf           | [IBM Plex Sans](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/ibmplexsans/IBMPlexSans%5Bwdth,wght%5D.ttf)                     | 537244 bytes | Weight 100-700, width 75-100 |
| ibm-plex-mono.ttf           | [IBM Plex Mono Regular](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/ibmplexmono/IBMPlexMono-Regular.ttf)                    | 135580 bytes | Regular 400                  |

SHA-256:

```text
c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6  playfair-display.ttf
a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b  playfair-display-italic.ttf
3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3  ibm-plex-sans.ttf
6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46  ibm-plex-mono.ttf
```

All three families are licensed under the SIL Open Font License 1.1. Complete
notices are included in `playfair-display-OFL.txt`, `ibm-plex-sans-OFL.html`, and
`ibm-plex-mono-OFL.html`. The IBM notices use ASCII HTML entity encoding for the
copyright symbol and HTML-special characters; their rendered preformatted text
matches the upstream notice, with HTML's standard newline normalization.
The font binaries and their embedded notices are unchanged.

Official notices are available at the pinned upstream paths:

- [Playfair Display OFL](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/playfairdisplay/OFL.txt)
- [IBM Plex Sans OFL](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/ibmplexsans/OFL.txt)
- [IBM Plex Mono OFL](https://raw.githubusercontent.com/google/fonts/f2bd09badbc763d8757951d52deec29da27e85fb/ofl/ibmplexmono/OFL.txt)

SHA-256 of the original upstream notice bytes (before IBM HTML encoding):

```text
566be814f8e96e93dfa16101331557eb6b5467e9e03f627c0910fe93ca12300e  playfairdisplay/OFL.txt
7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da  ibmplexsans/OFL.txt
7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da  ibmplexmono/OFL.txt
```

The build copies this directory into `public/anchor-gate-fonts`. Only the four
fixed font filenames are served under `/anchor-gate/fonts/`; unknown filenames
are not filesystem lookups.
