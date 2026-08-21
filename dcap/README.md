# `dcap/` — Automata on-chain Intel DCAP attestation on OKX X Layer

First deployment of Automata's on-chain PCCS + DCAP quote verifier to X Layer.
A **real Intel TDX v4 quote** from a Phala confidential-inference node is verified
**fully on-chain** — no ZK coprocessor, no oracle, no trusted relayer.

Status: **working end-to-end on a fork of X Layer testnet and on a local anvil fork
of it (real broadcast txs). 16/16 real TDX quotes verify. Mainnet/testnet deploy is
one command away, pending a funded wallet.**

---

## 1. The interface your contract calls

```solidity
import {IDcapAttestation} from "dcap/src/IDcapAttestation.sol";
import {DcapOutput, TdxAttestationOutput} from "dcap/src/DcapOutput.sol";

IDcapAttestation constant DCAP = IDcapAttestation(<AutomataDcapAttestationFee>);
uint32 constant TCB_EVAL = 20;   // Intel TCB Evaluation Data Number our collateral is pinned to
```

```solidity
// input: the raw Intel DCAP quote bytes, exactly as produced by the TEE
//        (Phala/dstack TDX v4 = 5006 bytes; RedPill returns it hex- or base64-encoded)
(bool ok, bytes memory out) = DCAP.verifyAndAttestOnChain(rawQuote, TCB_EVAL);
require(ok, string(out));   // on failure, `out` IS the UTF-8 reason string
```

Two overloads:

| signature | selector | notes |
|---|---|---|
| `verifyAndAttestOnChain(bytes)` | `0x38d8480a` | resolves the TCB eval number from `TcbEvalDao` (~180k extra gas) |
| `verifyAndAttestOnChain(bytes,uint32)` | `0x1beaf6d8` | **preferred** — pin `tcbEvaluationDataNumber = 20` |

Both are `payable` and non-`view` (they emit `AttestationSubmitted`), but the work is
pure computation over on-chain PCCS state, so `eth_call` works for a read-only check.
Fee bp is **0** on our deployment, so `msg.value` can be 0.

### Output encoding

`out` is `abi.encodePacked` — **not** `abi.decode`-able as a whole. For a TDX v4 quote
it is exactly **595 bytes** (11 header + 584 TD1.0 report body), plus an
`abi.encode(string[] advisoryIDs)` tail **only when the matching TCB level carries
advisories** (our current collateral: none, so 595 bytes flat).

```
[0  : 2 ]  uint16  quoteVersion        = 4
[2  : 4 ]  uint16  quoteBodyType       = 2 (TD1.0 report) | 3 (TD1.5) | 1 (SGX enclave report)
[4  : 5 ]  uint8   tcbStatus
[5  : 11]  bytes6  fmspc
[11 : 595] TD10ReportBody (584 bytes, verbatim from the quote)
[595:    ] abi.encode(string[] advisoryIDs)   -- absent when empty
```

Absolute offsets into `out` for the TD1.0 fields you asked about:

| field | offset | length |
|---|---|---|
| `teeTcbSvn` | 11 | 16 |
| `mrSeam` | 27 | 48 |
| `mrSignerSeam` | 75 | 48 |
| `seamAttributes` | 123 | 8 |
| `tdAttributes` | 131 | 8 |
| `xFAM` | 139 | 8 |
| **`mrTd`** | **147** | **48** |
| `mrConfigId` | 195 | 48 |
| `mrOwner` | 243 | 48 |
| `mrOwnerConfig` | 291 | 48 |
| **`rtMr0`** | **339** | 48 |
| **`rtMr1`** | **387** | 48 |
| **`rtMr2`** | **435** | 48 |
| **`rtMr3`** | **483** | 48 |
| **`reportData`** | **531** | **64** |

`src/DcapOutput.sol` implements all of this. Cheapest useful read:

```solidity
using DcapOutput for bytes;
address signer = out.signingAddress();   // == address(bytes20(out[531:551]))
uint8   status = out.tcbStatus();        // out[4]
bytes6  fmspc  = out.fmspc();            // out[5:11]
bytes memory mrTd = out.mrTd();          // out[147:195]
TdxAttestationOutput memory o = out.parseTdx();   // full decode
```

`DcapOutput` is a **calldata** library — call it from an `external`/`public` function
whose `bytes calldata` parameter is the output, or wrap it (see `OutputProbe` in the test).

### `tcbStatus` values

`0 OK` · `1 SW_HARDENING_NEEDED` · `2 CONFIG_AND_SW_HARDENING_NEEDED` · `3 CONFIG_NEEDED`
· `4 OUT_OF_DATE` · `5 OUT_OF_DATE_CONFIG_NEEDED` · `6 REVOKED` · `7 UNRECOGNIZED`
· `8 TD_RELAUNCH_ADVISED` · `9 TD_RELAUNCH_ADVISED_CONFIG_NEEDED`

`6 REVOKED` never reaches you — the verifier returns `success = false`. A sane registry
policy is `require(status == 0 || status == 1)`.

### Phala convention

`reportData[0:20]` is the workload's **signing address**; `reportData[20:32]` is zero
padding and `reportData[32:64]` is a second digest. Confirmed against all 16 quotes.

---

## 2. Does it work? Yes.

`./run.sh fork-test` — deploys the whole stack on a fork of X Layer testnet, uploads Intel
collateral, verifies real quotes:

```
[PASS] test_verify_real_phala_tdx_quote
[PASS] test_verify_committee_quotes        11/11 distinct TDX instances, 3 FMSPCs
[PASS] test_verify_redpill_model_quotes     5/5
[PASS] test_verify_with_standard_tcb_eval
[PASS] test_p256_precompile_gas
```

Deepseek quote (`data/quote_deepseek_deepseek-v4-flash-0731.hex`, 5006 bytes):

```
success   : true
tcbStatus : 0 (UpToDate), advisoryIDs: []
fmspc     : 20a06f000000
mrTd      : f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077
rtMr0     : d6118f0eeb30e9d9178d2b9106dddd002d979b6fa79bdec415051afae2021384c29a32d2f6454fa369617598378ffb5e
rtMr1     : 07e6f51aa763abfe75c3ddfbf4f425fe3f0ceff66d807a75e049303dce9addf68e7218729bd419638af63a370f65878c
rtMr2     : df67e467e60edc1737bcf8e682d48131bfb427f523226aa7f197a7608e9b3784783fa759ef5b28191fa12f9ddb36b858
rtMr3     : a8efdf31fb73736e2560aca938a6c67a4d564531ee5b87c7ce78b2f3111a40ee45d2720ff03ef415146cd20ec91e64bd
reportData: 79a5061efe5a46b0d1f33b11cf1c5adbedae6b79 0000000000000000000000 00 f515ba11...ce794458
            ^^^^ == signing_address from the RedPill attestation JSON. MATCH.
```

### Gas

| operation | gas |
|---|---|
| `verifyAndAttestOnChain(quote, 20)` — **real tx on anvil fork** | **4,603,856** |
| `verifyAndAttestOnChain(quote, 20)` — inner call | 4,519,281 |
| `verifyAndAttestOnChain(quote)` (1-arg, TcbEvalDao lookup) | 4,700,019 |
| P256VERIFY staticcall (local EIP-7951 pricing 6900) | 9,429 |
| full stack deployment | ~32.2M (est. 45.6M incl. tx overhead) |
| Intel collateral upload (3 FMSPCs + QEID + PCS + CRLs) | ~40.0M |

At X Layer's 0.02 gwei that's **~0.000092 OKB per verification** and ~0.0018 OKB for the
whole deployment. Block gas limit is 210M, so the 4.6M verify is ~2% of a block — fine.

On the **real** chain the verify will be marginally cheaper than the number above:
X Layer's RIP-7212 P256VERIFY costs 3450 gas vs the 6900 EIP-7951 price the local
`osaka` spec charges, over ~5 signature checks (QE report, attestation key, 3 cert-chain
links) ≈ **−17k gas**.

---

## 3. P256 precompile: yes, wired in

Automata's `P256Verifier` takes the verifier address as a **constructor arg**, so it is
fully pluggable. `V4QuoteVerifier` is deployed with
`p256 = 0x0000000000000000000000000000000000000100` (RIP-7212), which X Layer implements
natively at 3450 gas. No 300k-gas Solidity fallback, no daimo contract deployed.

Override with `P256_VERIFIER=0x...` if a chain ever lacks it.

> **Local-EVM gotcha.** Foundry/anvil only expose a P256 precompile at `0x100` under the
> **`osaka`** EVM spec (EIP-7951). `foundry.toml` therefore pins `evm_version = "osaka"`
> and `./run.sh anvil` passes `--hardfork osaka`. solc 0.8.27 clamps codegen to cancun, which
> X Layer (Prague) accepts, so the same artifacts deploy to the real chain unchanged.
> Without this the whole thing reverts inside `P256Verifier.ecdsaVerify` — a `staticcall`
> to an empty `0x100` "succeeds" with empty returndata and then `abi.decode` blows up.

---

## 4. Deploy

Use `./run.sh` (bash / Git Bash — **`make` is not on PATH on this Windows box**; the
`Makefile` is the same thing for Linux/CI).

```bash
# 0. one-time: refresh quotes + Intel collateral (already checked in, offline-reproducible)
./run.sh refresh

# 1. THE PROOF, no funds required
./run.sh fork-test

# 2. local anvil fork of X Layer testnet, real broadcast txs
./run.sh anvil                        # terminal 1, leave running
./run.sh deploy-local                 # terminal 2 -> deploy + upload + verify

# 3. the real thing (one command each)
./run.sh deploy-testnet 0x<privkey>   # chainId 1952
./run.sh deploy-mainnet 0x<privkey>   # chainId 196
./run.sh sourcify 1952                # source verification, no API key
```

`deploy-*` runs three scripts in order — they are separately re-runnable:

| script | what |
|---|---|
| `script/Deploy.s.sol:Deploy` | deploys 15 contracts, writes `deployments/<chainid>.json` |
| `script/Deploy.s.sol:UploadCollateral` | pushes Intel collateral into on-chain PCCS |
| `script/Deploy.s.sol:VerifyQuote` | sends a real verify tx (`--sig 'simulate()'` for eth_call) |

Env knobs: `OWNER` (default: broadcaster), `P256_VERIFIER` (default `0x100`),
`WITH_V3=true` (also deploy the SGX v3 verifier), `QUOTE_PATH`.

### Addresses

**X Layer testnet (1952) / mainnet (196): NOT DEPLOYED YET** — wallet
`0xcf0A49F8e6CC7D0C50CB8AAe492E97216A13316f` is unfunded. Run `./run.sh deploy-testnet 0x<key>` and
`deployments/1952.json` fills in. Needs ~0.002 OKB.
(The anvil-fork run is parked at `deployments/anvil-fork-1952.json` so it can't be mistaken
for a real deployment.)

Local anvil fork of X Layer testnet (chainId 1952), for reference — deterministic from
anvil account 0, so you get these again if you rerun `./run.sh anvil` + `./run.sh deploy-local`:

| contract | address |
|---|---|
| **AutomataDcapAttestationFee** (call this) | `0x408F924BAEC71cC3968614Cb2c58E155A35e6890` |
| V4QuoteVerifier | `0x773330693cb7d5D233348E25809770A32483A940` |
| PCCSRouter | `0x0b27a79cb9C0B38eE06Ca3d94DAA68e0Ed17F953` |
| AutomataPcsDao | `0x75b0B516B47A27b1819D21B26203Abf314d42CCE` |
| AutomataPckDao | `0x906B067e392e2c5f9E4f101f36C0b8CdA4885EBf` |
| AutomataTcbEvalDao | `0x4f42528B7bF8Da96516bECb22c1c6f53a8Ac7312` |
| AutomataEnclaveIdentityDaoVersioned | `0x8f119cd256a0FfFeed643E830ADCD9767a1d517F` |
| AutomataFmspcTcbDaoVersioned | `0xe14058B1c3def306e2cb37535647A04De03Db092` |
| AutomataDaoStorage | `0xD1760AA0FCD9e64bA4ea43399Ad789CFd63C7809` |
| PccsDependencyConfig | `0xD94A92749C0bb33c4e4bA7980c6dAD0e3eFfb720` |
| PCKHelper | `0x6732128F9cc0c4344b2d4DC6285BCd516b7E59E6` |
| X509CRLHelper | `0x15Ff10fCc8A1a50bFbE07847A22664801eA79E0f` |
| EnclaveIdentityHelper | `0x09120eAED8e4cD86D85a616680151DAA653880F2` |
| FmspcTcbHelper | `0x3E661784267F128e5f706De17Fac1Fc1c9d56f30` |
| TcbEvalHelper | `0xAe9Ed85dE2670e3112590a2BB17b7283ddF44d9c` |

---

## 5. Data

| path | what |
|---|---|
| `data/att_*.json` | raw RedPill attestation reports (quote + `signing_address` + nvidia payload) |
| `data/quote_*.hex` | 16 real Intel TDX v4 quotes, bare hex, no `0x` |
| `data/quote_kimi_00..10.hex` | **11 distinct TDX instances** of the kimi-k2.6 committee — different `report_data` addresses, 3 different platforms |
| `data/collateral/` | Intel PCS artifacts (certs, CRLs, tcbInfo, QE identity) + response headers |
| `data/collateral/onchain.json` | everything the deploy needs, byte-exact, offline-reproducible |
| `data/fetch_all.py` | refetch all of the above from live sources |
| `data/build_onchain_collateral.py` | fold raw artifacts into `onchain.json` |
| `data/parse_quote.py`, `data/extract_pck.py` | standalone TDX quote / PCK-extension parsers |

Current collateral pins:

```
FMSPCs                     20a06f000000 (deepseek et al), 90c06f000000, b0c06f000000 (kimi committee)
PCEID                      0000
CPUSVN                     0505020205ff00020000000000000000
PCESVN                     13
PCK intermediate CA        Intel SGX PCK Platform CA
tcbInfo                    id=TDX version=3 tcbEvaluationDataNumber=20
QE identity                id=TD_QE version=2 tcbEvaluationDataNumber=20
```

---

## 6. Architecture actually deployed

```
your contract
   └─ AutomataDcapAttestationFee.verifyAndAttestOnChain(quote, 20)
        └─ V4QuoteVerifier  (p256 = 0x…0100 RIP-7212)
             ├─ parses header + TD10 body + auth data + PCK chain out of the quote
             ├─ QE report sig  <- PCK leaf pubkey            (P256 precompile)
             ├─ TD report sig  <- attestation key            (P256 precompile)
             ├─ PCK chain: leaf -> Platform CA -> Root CA    (P256 precompile, CRL-checked)
             │    root pinned by hardcoded pubkey hash 0x89f72d7c…703a8473
             └─ PCCSRouter
                  ├─ AutomataPcsDao                  root CA, PCK CA, TCB signing CA, CRLs
                  ├─ AutomataTcbEvalDao              standard/early TCB eval data numbers
                  ├─ AutomataEnclaveIdentityDaoVer.  TD_QE identity  (keyed by tcbEval=20)
                  └─ AutomataFmspcTcbDaoVersioned    TDX tcbInfo per FMSPC (keyed by tcbEval=20)
                       └─ AutomataDaoStorage
```

Every DAO re-verifies Intel's ECDSA signature over the collateral on upload, so nothing
here is "trust the deployer" — the deployer can only supply genuinely Intel-signed data.

---

## 7. Gotchas / notes for whoever builds on this

1. **Pin `tcbEvaluationDataNumber = 20`.** The versioned DAOs key collateral by it. Intel
   is currently at 22 (`standard` = 20, i.e. the newest ≥12 months old). If you upload
   collateral for a different eval number you must also
   `router.setFmspcTcbDaoVersionedAddr(n, ...)` / `setQeIdDaoVersionedAddr(n, ...)` with
   DAOs deployed for that `n`. Reuse `Deploy.s.sol` with a different `TCB_EVAL`.
2. **Collateral expires.** `tcbInfo` / QE identity / CRLs carry `nextUpdate` (~30 days).
   After that every verification reverts with `FmspcTcbExpiredOrNotFound` /
   `QEIdentityExpiredOrNotFound` / `CrlExpiredOrNotFound`. Re-run
   `./run.sh refresh` then the `UploadCollateral` script monthly. Upserts require the
   `ATTESTER_ROLE` on the versioned DAOs (granted to `OWNER` at deploy).
3. **Byte-exactness.** Intel signs the *exact* `tcbInfo` / `enclaveIdentity` substring of
   the HTTP body. `build_onchain_collateral.py` slices it out of the raw text and never
   re-serializes. Any `json.dumps` round-trip silently breaks the signature.
4. **One FMSPC ≠ one TEE.** Different Phala nodes sit on different platforms. Upload the
   tcbInfo for every FMSPC in your committee (we ship 3).
5. **Failure output is a string, not a revert.** `success == false` with `out` =
   e.g. `"Quote verification failed"`. Always check `ok` — a naive `abi.decode` of a
   failure blob will read garbage.
6. **Fresh chain, fresh root of trust.** The Intel SGX Root CA pubkey hash is hardcoded in
   both `PcsDao` and `X509ChainBase` (`0x89f72d7c…703a8473`), so a malicious deployer
   cannot swap the root.
7. **`--slow` matters** on X Layer deploy: 30+ sequential txs with dependencies.
8. **Not deployed via CREATE2.** Salts were dropped (the Arachnid deployer would give
   nice deterministic addresses but the DAOs are >24kB-adjacent and salt collisions with
   Automata's official deployments would be confusing). Addresses come from nonces.

---

## 8. Layout

```
dcap/
  foundry.toml            evm_version = osaka (see §3), via_ir, solc 0.8.27
  run.sh                  fork-test / anvil / deploy-local / deploy-{testnet,mainnet} / refresh / sourcify
  Makefile                same targets for Linux/CI (no `make` on the Windows box)
  src/
    IDcapAttestation.sol  <- import this
    DcapOutput.sol        <- and this
  script/
    DcapStack.sol         deployment logic, shared by script + test
    CollateralUploader.sol Intel collateral -> on-chain PCCS
    CollateralJson.sol    onchain.json / quote hex loaders
    Deploy.s.sol          Deploy | UploadCollateral | VerifyQuote
    verify.sh             sourcify
  test/
    XLayerForkE2E.t.sol   the proof
    P256Probe.t.sol       precompile sanity
  stubs/                  1-function local stubs for risc0/sp1 interfaces so we don't
                          vendor two multi-hundred-MB repos for the unused ZK path
  lib/                    automata-dcap-attestation, automata-on-chain-pccs, forge-std,
                          solady, openzeppelin-contracts
  data/                   quotes + Intel collateral + fetchers
  deployments/<chainid>.json
```
