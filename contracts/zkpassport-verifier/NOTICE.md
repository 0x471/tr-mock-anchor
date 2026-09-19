# Source provenance and modification notice

This is an experimental modified verifier, not an official Nethermind, Aztec, TACEO, Stellar, or ZKPassport release. Attribution does not imply endorsement or an audit of this port.

## Nethermind / original Soroban verifier

The initial Rust/Soroban implementation was copied from [NethermindEth/rs-soroban-ultrahonk](https://github.com/NethermindEth/rs-soroban-ultrahonk/tree/661db07200f890b1bd9a7349ed787c70a706dd12), revision `661db07200f890b1bd9a7349ed787c70a706dd12`.

Copyright (c) 2025 yugocabrio & indextree. Licensed under the MIT License; the original notice and permission terms are retained in [LICENSE-NETHERMIND](LICENSE-NETHERMIND).

Modified on 20 September 2026 for the pinned BB5 ZKPassport format: strict parsing, key/proof entity ordering, transcript derivation, relation system and batching, unpadded sumcheck/opening logic, recursive pairing completion, embedded-key wrapper, and tests. These changes are not the original BB0.87 implementation and do not inherit any claimed upstream audit coverage.

## Aztec / ZKPassport reference verifier

Protocol layout and equations were checked against ZKPassport's published [OuterCount5.sol](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount5.sol), revision `d3a75acb8529e82c61be136a402553daec259257`, and its matching 0.20.0 fixture/key.

That generated source identifies **Copyright 2022 Aztec**, SPDX **Apache-2.0**. The Apache License, Version 2.0 is retained in [LICENSE-APACHE](LICENSE-APACHE). Adapted logic has been rewritten for Soroban host operations and the narrow fixed-format verifier described in the README. The bundled historical synthetic fixture is for compatibility testing, not a current identity attestation.

## TACEO differential reference

[TACEO co-snarks](https://github.com/TaceoLabs/co-snarks/tree/cd3db67c775b7bf40beab9248c6437dd316eb667), revision `cd3db67c775b7bf40beab9248c6437dd316eb667`, was consulted for BB5 equations and used as a separately executed Rust differential reference. Its `ultrahonk` crate declares `MIT OR Apache-2.0`. The MIT attribution and permission text is retained below for any adapted portions. The co-snarks crate is not a runtime dependency of this Soroban contract.

> MIT License
>
> Copyright (c) 2024 TACEO
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The package metadata uses `MIT AND Apache-2.0` to reflect the retained source obligations. Dependencies retain their respective licenses. This notice supplements, and does not replace, the included license texts.
