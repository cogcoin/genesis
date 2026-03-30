# Cogcoin Scoring Module Specification

This document defines the scoring protocol for the Cogcoin 256-scorer ensemble. It is intended for indexer operators integrating the canonical WASM binary. The WASM binary is the sole reference implementation — native reimplementations are non-conforming.

## Table of Contents

1. [Overview](#1-overview)
2. [Coglex Codec](#2-coglex-codec)
3. [Tier 1: Hard Gates](#3-tier-1-hard-gates)
4. [Scoring Tiers](#4-scoring-tiers)
5. [Blend Derivation](#5-blend-derivation)
6. [Ranking and Reward Distribution](#6-ranking-and-reward-distribution)
7. [Determinism Requirements](#7-determinism-requirements)
8. [Distribution Format](#8-distribution-format)
9. [WASM Host Integration](#9-wasm-host-integration)

---

## 1. Overview

The scoring module is a self-contained, immutable bundle that evaluates every Cogcoin mining submission. It contains 256 scorers organized into three tiers, a compiled WASM binary implementing the entire consensus-critical pipeline, and all model data. The bundle's SHA-256 checksum is committed in the genesis parameters on-chain.

The pipeline for a single submission: raw 60-byte sentence payload enters the WASM binary, which unpacks token IDs, runs 32 hard gates (Tier 1), evaluates 184 statistical scorers (Tier 2), runs 40 neural models (Tier 3), then computes a weighted blend using block-dependent activation weights. For a full block, the WASM binary additionally deduplicates per address, ranks by blend score with deterministic tie-breaking, and distributes rewards.

### Scorer Slot Assignments

| Slot Range | Tier    | Count | Category                                                 |
| ---------- | ------- | ----- | -------------------------------------------------------- |
| 0-31       | Tier 1  | 32    | Hard gates (binary: 65535=pass, 0=fail)                  |
| 32-79      | Tier 2A | 48    | N-gram models (16 corpora x 3 orders)                    |
| 80-103     | Tier 2A | 24    | PMI models (12 corpora x 2 variants)                     |
| 104-127    | Tier 2A | 24    | Syntax models (12 corpora x 2 patterns)                  |
| 128-215    | Tier 2B | 88    | Category B scorers (lexical, prosodic, structural, meta) |
| 216-255    | Tier 3  | 40    | Neural models (20 CNN + 12 GRU + 8 BoE)                  |

Every scorer outputs a uint16 value in [0, 65535]. Gate slots output 65535 (pass) or 0 (fail). All other scorers output continuous uint16 values where higher generally indicates better linguistic quality.

---

## 2. Coglex Codec

The Coglex maps a 4,096-token vocabulary onto 12-bit IDs. A sentence of up to 40 tokens packs into exactly 60 bytes (480 bits).

### 2.1 Token Table

| Category    | Count | ID Range                 | Description                                                                                |
| ----------- | ----: | ------------------------ | ------------------------------------------------------------------------------------------ |
| BIP-39      | 2,048 | 0-2047                   | Complete English BIP-39 mnemonic wordlist                                                  |
| Suffixes    |    41 | 2048-2088                | Morphological endings: -s, -ed, -ing, -ful, -ly, -ness, etc.                               |
| Control     |     5 | 2089-2093                | CAP, ALLCAP, NO_SPACE, QUOTE_START, QUOTE_END                                              |
| Punctuation |    33 | 2094-2126                | Period, question mark, exclamation, comma, colon, semicolon, parentheses, digits 0-9, etc. |
| Prefixes    |    12 | 2127-2138                | un-, re-, dis-, pre-, over-, mis-, out-, non-, im-, in-, de-, anti-                        |
| Irregular   |   229 | 2139-2354 + 13 scattered | Pre-inflected forms bypassing morphological rules                                          |
| Function    |    60 | 2355-2414                | Closed-class connectors and adverbs not in BIP-39                                          |
| Base        | 1,668 | 2415-4095                | Open-class content words and high-frequency words                                          |

IDs 0-2138 are strictly partitioned into contiguous category blocks. Above ID 2138, three categories (irregular, function, base) share the ID space. Implementations must use per-ID category lookup from the token table, not range arithmetic, to classify tokens above 2138.

### 2.2 Canonicality

A token ID sequence is canonical if and only if `encode(decode(ids)) == ids`. The WASM binary verifies this property for every submission. Non-canonical encodings are rejected. This ensures there is exactly one valid encoding for each natural language sentence, preventing miners from submitting the same sentence under different encodings.

---

## 3. Tier 1: Hard Gates

All 32 gates must pass for a submission to proceed to scoring. If any gate fails, the submission receives a blend score of 0 and is excluded from ranking. Gate outputs are stored in scorer slots 0-31 as uint16: 65535 (pass) or 0 (fail).

### Gate Definitions

| Gate | Name                       | Condition                                                                             |
| ---- | -------------------------- | ------------------------------------------------------------------------------------- |
| 0    | token_count_min            | n_tokens >= 8                                                                         |
| 1    | token_count_max            | n_tokens <= 40                                                                        |
| 2    | terminal_punctuation       | Last token is in {2094 (.), 2096 (?), 2097 (!)}                                       |
| 3    | starts_uppercase           | First non-QUOTE_START token is CAP (2089) or ALLCAP (2090)                            |
| 4    | valid_encoding             | All token IDs in [0, 4095]                                                            |
| 5    | single_sentence            | At most 1 terminal punctuation token                                                  |
| 6    | no_consecutive_controls    | No run of 3+ consecutive control tokens (IDs 2089-2093)                               |
| 7    | has_content_words          | At least 2 tokens with cat_lookup[id] >= 2                                            |
| 8    | bip_presence               | At least 1 of the 5 assigned BIP-39 words appears in the sentence                     |
| 9    | bip_uniqueness             | All 5 BIP-39 indices are distinct AND all 5 appear in the sentence                    |
| 10   | bip_no_cluster             | Maximum consecutive run of assigned BIP-39 words <= 3                                 |
| 11   | bip_pos_validity           | pos_tags[bip39[i]] in {1,2,3,4} for all 5 assigned words                              |
| 12   | bip_not_majority           | Count of BIP-39 tokens <= 50% of n_tokens (bip_count \* 2 <= n)                       |
| 13   | no_triple_repeat           | No 3 consecutive identical tokens                                                     |
| 14   | word_repetition_limit      | No single token appears more than 25% of the time (count \* 4 <= n)                   |
| 15   | bigram_diversity           | unique_bigrams / total_bigrams >= 0.5 (unique \* 2 >= total)                          |
| 16   | no_cyclic_pattern          | No repeating pattern of period 1-4 that repeats more than 3 times                     |
| 17   | trigram_diversity          | unique_trigrams / total_trigrams >= 0.4 (unique _ 5 >= total _ 2)                     |
| 18   | no_single_word_sentence    | At least 3 distinct content words (cat_lookup[id] >= 2)                               |
| 19   | reasonable_word_length     | Average character length of word tokens in [2.0, 15.0]                                |
| 20   | not_monotonic_ids          | Token IDs are neither strictly increasing nor strictly decreasing                     |
| 21   | has_verb                   | At least one token where pos_tags[id] == 2                                            |
| 22   | not_semantic_null          | Content word ratio >= 0.3 (content_count _ 10 >= n _ 3)                               |
| 23   | frequency_band_spread      | At least 2 distinct non-zero frequency bands                                          |
| 24   | syllable_variety           | At least one token with syllable_counts[id] > 1                                       |
| 25   | control_token_limit        | Control token count < max(n/4, 2)                                                     |
| 26   | min_unique_ratio           | Unique tokens / n_tokens >= 0.3 (unique _ 10 >= n _ 3)                                |
| 27   | no_excessive_punctuation   | Punctuation ratio < 0.3 (cat_lookup[id] == 1)                                         |
| 28   | reasonable_sentence_length | 8 <= n_tokens <= 40 (redundant with gates 0+1; retained for bitmask stability)        |
| 29   | not_random_tokens          | Average absolute token ID difference < 2000                                           |
| 30   | has_multiple_pos           | At least 3 distinct POS tag values                                                    |
| 31   | no_control_waste           | Every CAP/ALLCAP is followed by a word token (cat in {2,3,10}); NO_SPACE is not final |

---

## 4. Scoring Tiers

The WASM binary implements all scorer logic internally. Indexers do not need to understand scorer internals — the binary accepts sentence payloads and model data, and produces uint16 scores and uint64 blend values. This section provides a brief overview of what each tier measures.

**Tier 2A (slots 32-127, 96 scorers)** evaluates statistical language quality using n-gram frequency models, pointwise mutual information models, and syntax transition models trained on diverse English corpora. Each model produces a uint16 score reflecting how well the submission matches the statistical patterns of natural English text.

**Tier 2B (slots 128-215, 88 scorers)** computes lexical diversity metrics, information-theoretic measures, prosodic/rhythmic analysis, structural measures, BIP-39 integration quality, and character-level features. These operate directly on token sequences and lookup tables embedded in the model blob.

**Tier 3 (slots 216-255, 40 scorers)** runs neural models — 20 CNN, 12 GRU, and 8 bag-of-embeddings — each trained on different corpus mixtures. All neural inference uses integer-only arithmetic (int8 weights, int32/int64 accumulators, LUT-based activations). Each model may include a post-quantization remap LUT for output calibration.

---

## 5. Blend Derivation

### 5.1 Seed Expansion

The blend seed is derived from the next block's hash:

```
blend_seed = SHA256(blockhash_{H+1})
```

The 32-byte seed is expanded to 256 bytes by concatenating 8 SHA-256 hashes:

```
for i in 0..7:
    expanded[i*32 .. i*32+32] = SHA256(blend_seed || byte(i))
```

Each of the 256 expanded bytes maps to one scorer slot.

### 5.2 Activation and Weighting

Not all scorers are active in every block. Activation is determined by comparing the expanded byte against a tier-specific threshold:

| Tier           | Slots   | Threshold | Active when                         | Activation rate |
| -------------- | ------- | --------- | ----------------------------------- | --------------- |
| Tier 1 (gates) | 0-31    | N/A       | Gates are not weighted in the blend | N/A             |
| Tier 2         | 32-215  | 210       | expanded_byte > 210                 | ~17.6%          |
| Tier 3         | 216-255 | 96        | expanded_byte > 96                  | ~62.4%          |

For each active scorer at slot `i`:

```
weight_i = expanded_byte_i + 1    (uint16, range [threshold+2, 256])
```

### 5.3 Blend Computation

The canonical blend is an integer weighted sum computed in a uint64 accumulator:

```
canonical_blend = 0
for each active Tier 2 scorer i:
    canonical_blend += uint64(scorer_output_i) * uint64(weight_i)
for each active Tier 3 scorer j:
    canonical_blend += uint64(scorer_output_j) * uint64(weight_j)
```

If any gate fails, the blend is 0. Gates are not included in the weighted sum — they serve only as a pass/fail filter.

The blend is a uint64 value. No division, normalization, or floating-point conversion is performed. This value is the consensus-critical ranking score.

---

## 6. Ranking and Reward Distribution

### 6.1 Per-Address Deduplication

If an address submits multiple valid sentences in the same block, only the one with the highest blend score is kept. This is performed inside the WASM binary.

### 6.2 Ranking

Submissions are sorted by descending blend value. Ties are broken by computing `SHA256(blend_seed || sender_address)` where sender_address is the full Cogcoin address tuple `(format_byte || raw_bytes)`. The tie-break hash is compared lexicographically (ascending — lower hash wins).

### 6.3 Reward Distribution

The top min(10, n_qualifying) submissions receive rewards. Fixed rank-weights:

| Rank | Weight | Share |
| ---- | ------ | ----- |
| 1st  | 20     | 20%   |
| 2nd  | 16     | 16%   |
| 3rd  | 13     | 13%   |
| 4th  | 11     | 11%   |
| 5th  | 9      | 9%    |
| 6th  | 8      | 8%    |
| 7th  | 7      | 7%    |
| 8th  | 6      | 6%    |
| 9th  | 5      | 5%    |
| 10th | 5      | 5%    |

The distribution uses cascading integer division to prevent uint64 overflow:

```
remaining_weight = sum of active weights
remaining_reward = total_block_reward

for each winner except last:
    q = remaining_reward / remaining_weight
    r = remaining_reward % remaining_weight
    reward_i = q * weight_i + (r * weight_i) / remaining_weight
    remaining_weight -= weight_i
    remaining_reward -= reward_i

last winner absorbs all remaining reward
```

This guarantees exact distribution (no dust) and avoids overflow when `remaining_reward` is large.

---

## 7. Determinism Requirements

The Integer-Canonical Scoring Protocol (ICSP) ensures bit-identical results across all conforming deployments:

- Every scorer produces a uint16 output in [0, 65535]. The blend is a uint64 weighted sum — no division, no float normalization.
- Rankings compare uint64 blend values directly. Ties broken by SHA-256 hash. Reward distribution uses integer arithmetic with floor division.
- No floating-point value is ever compared, sorted, or used in any consensus decision.
- Neural inference uses int8 weights, int32/int64 accumulators, and LUT-based activations — no floating point at inference time.
- Tier 2B scorers use floating-point for intermediate calculations only. Results are quantized to uint16 with explicit NaN guards before entering consensus.
- The WASM binary is compiled with `-ffp-contract=off` (no fused-multiply-add) and uses IEEE 754 round-to-nearest-ties-to-even.

---

## 8. Distribution Format

The scoring bundle is distributed as a flat directory with six files:

```
bundle/
├── cogcoin_scoring.wasm      # Canonical WASM binary (zero host imports)
├── cgsm_blob.bin             # Pre-packed model blob (all tiers + LUTs + lookup tables)
├── coglex_token_table.json   # Vocabulary reference (4096 tokens, categories, ID ranges)
├── test_vectors.json         # 100 conformance test vectors (settle_block round-trips)
├── scoring_module.md         # This document
└── manifest.sha256           # SHA-256 hashes for every file
```

The `cgsm_blob.bin` file packs all model data — n-gram LUTs, PMI LUTs, syntax matrices, neural model weights, activation LUTs, remap LUTs, per-token lookup tables, and character data — into a single binary. The WASM binary reads this blob into linear memory at startup and indexes into it for all model access.

`coglex_token_table.json` provides the 4096-token Coglex vocabulary with per-token category annotations (`b` = BIP-39, `w` = base, `s` = suffix, `c` = control, `p` = punctuation, `x` = prefix, `i` = irregular, `f` = function), ID ranges, and control token IDs. This is the same vocabulary compiled into the WASM binary at build time.

`test_vectors.json` contains 100 conformance vectors. Each vector specifies a complete `settle_block_wasm` input (submissions, blend seed, block reward) and the expected output (reward entries). Integrators should verify that their host produces byte-identical results for every vector.

`manifest.sha256` records the SHA-256 hash of every file in the bundle. The bundle's own manifest hash is committed in the genesis parameters on-chain, forming a trust chain: genesis transaction → genesis parameters hash → bundle manifest hash → individual file hashes.

---

## 9. WASM Host Integration

### 9.1 Standalone Binary — Zero Imports

The canonical WASM binary (`cogcoin_scoring.wasm`) is a fully standalone module with **zero host imports**. It uses the WebAssembly `memory.grow` instruction internally and does not require the host to provide any functions. Any MVP-compliant WebAssembly runtime can instantiate it directly.

Instantiation is straightforward:

```python
# Python / wasmtime example
import wasmtime

engine = wasmtime.Engine()
store  = wasmtime.Store(engine)
module = wasmtime.Module.from_file(engine, "cogcoin_scoring.wasm")
instance = wasmtime.Instance(store, module, [])
memory   = instance.exports(store)["memory"]
```

Equivalent patterns apply for Wasmer, wasm3, browser `WebAssembly.instantiate()`, Go `wazero`, Rust `wasmtime`/`wasmer` crates, and any other runtime supporting the WebAssembly MVP.

**Browser / Node.js note:** After any WASM call that triggers memory growth, the host's `memory.buffer` ArrayBuffer is detached. You must re-read `instance.exports.memory.buffer` between calls to get a fresh view.

### 9.2 Memory Management

All pointers in the exported function signatures refer to offsets in WASM linear memory. Callers allocate via `sb_alloc` and free via `sb_free`. The typical initialization sequence is:

1. Instantiate the WASM module (no imports needed).
2. Call `_initialize` or `__wasm_call_ctors` (if exported) to initialize globals. Depending on the Emscripten version used to build the binary, one or both may be present.
3. Allocate space for the CGSM blob via `sb_alloc(blob_size)`.
4. Write the blob into linear memory at the returned pointer.
5. For each call, allocate input and output buffers, write input, call the export, read output, then free buffers.

### 9.3 Byte Order

All integer fields in the binary protocols below are **little-endian** (LE). This applies to uint16, uint32, and uint64 values across all exported functions.

The one exception is the 60-byte sentence payload: 40 token IDs are packed as 12-bit values in **big-endian** bit order (ID[0] occupies the most significant bits). See `encode_sentence_wasm` / `decode_sentence_wasm`.

### 9.4 Exported Functions

The canonical WASM binary exports 13 symbols. The five primary API functions are documented in sections 9.5–9.9 below. The remaining exports are:

| Export                         | Kind     | Purpose                                                    |
| ------------------------------ | -------- | ---------------------------------------------------------- |
| `memory`                       | Memory   | Linear memory (initial 128 MB / 2048 pages)                |
| `sb_get_memory`                | Function | Returns current memory size (bytes)                        |
| `sb_alloc(size)`               | Function | Allocate `size` bytes in linear memory; returns pointer    |
| `sb_free(ptr)`                 | Function | Free a previous allocation                                 |
| `_initialize`                  | Function | One-time global initializer — call before any other export |
| `__indirect_function_table`    | Table    | Internal function table (do not call)                      |
| `_emscripten_stack_restore`    | Function | Toolchain residual (do not call)                           |
| `emscripten_stack_get_current` | Function | Toolchain residual (do not call)                           |

The two `emscripten_*` exports and `__indirect_function_table` are inert build artifacts from the Emscripten toolchain. They have no host-side dependencies (the binary has zero imports) and can be safely ignored.

### 9.5 settle_block_wasm

Primary entry point for indexers. Runs the full settlement pipeline on a block's submissions and returns reward entries.

```c
int32_t settle_block_wasm(
    const uint8_t *input_ptr,   // Input data (see format below)
    int32_t input_len,          // Length of input data in bytes
    const uint8_t *model_ptr,   // Pointer to CGSM model blob
    int32_t model_len,          // Length of model blob in bytes
    uint8_t *output_ptr         // Output buffer (>= 4 + 10 × 42 bytes)
);
// Returns: number of reward entries on success, negative on error
//   -1 = invalid arguments or input too short
//   -3 = n_submissions exceeds SUBMISSIONS_HARD_CAP (65536)
```

**Input format** (at `input_ptr`):

| Offset | Size    | Field                               |
| ------ | ------- | ----------------------------------- |
| 0      | 4       | `n_submissions` (uint32 LE)         |
| 4      | 32      | `blend_seed` (32 bytes)             |
| 36     | 8       | `block_reward_cogtoshi` (uint64 LE) |
| 44     | 104 × n | submissions (see below)             |

Each submission (104 bytes):

| Offset | Size | Field                                         |
| ------ | ---- | --------------------------------------------- |
| 0      | 1    | `addr_format_byte`                            |
| 1      | 32   | `addr_raw` (zero-padded to 32 bytes)          |
| 33     | 1    | `addr_len` (actual address length in bytes)   |
| 34     | 60   | `raw_sentence_bytes` (60-byte Coglex payload) |
| 94     | 10   | `bip39_word_indices` (5 × uint16 LE)          |

**Output format** (at `output_ptr`):

| Offset | Size   | Field                      |
| ------ | ------ | -------------------------- |
| 0      | 4      | `n_rewards` (uint32 LE)    |
| 4      | 42 × n | reward entries (see below) |

Each reward entry (42 bytes):

| Offset | Size | Field                         |
| ------ | ---- | ----------------------------- |
| 0      | 1    | `addr_format_byte`            |
| 1      | 32   | `addr_raw`                    |
| 33     | 1    | `addr_len`                    |
| 34     | 8    | `reward_cogtoshi` (uint64 LE) |

The pipeline for each submission: decode payload → run gates (Tier 1) → score Tier 2 → score Tier 3 → expand blend seed → compute weighted blend → rank by blend (tiebreak via SHA-256 of blend_seed ‖ sender_address) → distribute rewards to top 10 (weights: 20, 16, 13, 11, 9, 8, 7, 6, 5, 5).

### 9.6 score_sentences_wasm

Scores one or more sentences through the full pipeline (decode → gates → tier 2 → tier 3 → blend) and returns the composite blend value. This is the same pipeline used by `settle_block_wasm`, so the blend score a miner computes locally will exactly match what the network produces.

```c
int32_t score_sentences_wasm(
    const uint8_t *input_ptr,   // Input data (see format below)
    int32_t input_len,          // Length of input data in bytes
    const uint8_t *model_ptr,   // Pointer to CGSM model blob
    int32_t model_len,          // Length of model blob in bytes
    uint8_t *output_ptr         // Output buffer
);
// Returns: number of results on success, negative on error
//   -1 = invalid arguments or input too short
//   -3 = n_sentences is 0 or exceeds SUBMISSIONS_HARD_CAP (65536)
```

**Input format** (at `input_ptr`):

| Offset | Size   | Field                                                                                  |
| ------ | ------ | -------------------------------------------------------------------------------------- |
| 0      | 4      | `n_sentences` (uint32 LE)                                                              |
| 4      | 1      | `flags` (uint8: bit 0 = verbose)                                                       |
| 5      | 32     | `blend_seed` (32 bytes — expanded for scorer activation and weights)                   |
| 37     | 70 × n | `sentences[n]`, each 70 bytes: 60 bytes raw payload + 5 × uint16 LE BIP39 word indices |

**Output format** (at `output_ptr`):

| Offset | Size   | Field                                 |
| ------ | ------ | ------------------------------------- |
| 0      | 4      | `n_results` (uint32 LE)               |
| 4      | varies | `results[n]`, format depends on flags |

Each result in **compact mode** (flags bit 0 = 0): 9 bytes per sentence.

| Offset | Size | Field                                    |
| ------ | ---- | ---------------------------------------- |
| 0      | 1    | `gates_pass` (uint8: 1 = pass, 0 = fail) |
| 1      | 8    | `blend` (uint64 LE)                      |

Each result in **verbose mode** (flags bit 0 = 1): 521 bytes per sentence.

| Offset | Size | Field                                                               |
| ------ | ---- | ------------------------------------------------------------------- |
| 0      | 1    | `gates_pass` (uint8)                                                |
| 1      | 8    | `blend` (uint64 LE)                                                 |
| 9      | 512  | `scores[256]` (256 × uint16 LE — all 256 individual scorer outputs) |

### 9.7 encode_sentence_wasm

Encodes UTF-8 text into a 60-byte Coglex binary payload.

```c
int32_t encode_sentence_wasm(
    const uint8_t *text_ptr,    // UTF-8 text input
    int32_t text_len,           // Length of text in bytes
    uint8_t *output_ptr         // 60-byte output buffer
);
// Returns: number of tokens on success, negative on error
//   -1 = invalid arguments
//   -2 = word not in vocabulary
//   -3 = exceeds 40 token limit
```

### 9.8 decode_sentence_wasm

Decodes a 60-byte Coglex payload back to UTF-8 text.

```c
int32_t decode_sentence_wasm(
    const uint8_t *payload_ptr, // 60-byte Coglex payload
    uint8_t *text_out,          // Output text buffer
    int32_t max_out_len         // Size of output buffer
);
// Returns: length of decoded text on success, negative on error
//   -1 = invalid arguments
//   -2 = token ID out of range
//   -3 = output buffer too small
```

### 9.9 validate_canonical_wasm

Checks whether a 60-byte payload is canonically encoded.

```c
int32_t validate_canonical_wasm(
    const uint8_t *payload_ptr  // 60-byte Coglex payload
);
// Returns: 1 if canonical, 0 if not, negative on error
```

A payload is canonical if and only if `encode(decode(payload)) == payload`.

---

## Appendix A: Performance Characteristics

| Operation                 | Time     |
| ------------------------- | -------- |
| Single submission scoring | ~8 ms    |
| Gates (Tier 1)            | ~1 ms    |
| Tier 2 scoring            | ~5 ms    |
| Tier 3 neural inference   | ~1 ms    |
| 256 submissions           | ~2048 ms |
| 1000 submissions          | ~8000 ms |
