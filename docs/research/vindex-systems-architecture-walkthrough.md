# Vindex — Systems Architecture Deep Dive

> Companion document to the [Vindex systems architecture diagram](./vindex-systems-architecture.jpg)

![Vindex Systems Architecture](./vindex-systems-architecture.jpg)

---

## How to Read This

The system has **7 layers** stacked top-to-bottom. Data flows downward. Each layer has a single responsibility:

```
Signal Ingestion    →  "What's happening on chain right now?"
Signal Processing   →  "Is this noise or a real signal?"
Consensus Engine    →  "Are enough signals converging to confirm a threat?"
Pre-Exec Validator  →  "Can we safely execute the exit?"
Exec Orchestrator   →  "Execute the rescue as one atomic bundle."
KeeperHub Layer     →  "Handle gas, nonces, retries, signing."
Post-Execution      →  "Verify, log, notify."
```

Two sidebars run vertically:
- **Left: User Configuration** — what the user controls
- **Right: Failure Modes** — what happens when things break

---

## Layer 1: Signal Ingestion

> **Question this layer answers:** *"What's happening on chain right now?"*

### 5 Independent Data Sources

| # | Source | Transport | What It Feeds | Update Frequency |
|:--|:---|:---|:---|:---|
| 1 | **Onchain Event Stream** | WebSocket subscription | TVL changes, large transfers, contract events (Deposit, Withdraw, Liquidate) | Real-time (per block) |
| 2 | **Oracle Price Feeds** | Chainlink/Pyth direct reads | Price deviations from TWAP, staleness checks (oracle hasn't updated in X blocks) | Per block or per update |
| 3 | **Mempool Scanner** | Pending tx subscription | Suspicious pending transactions, flash loan detection, abnormal contract calls | Real-time (pre-block) |
| 4 | **External Threat Feeds** | Forta API / RSS polling | Published exploit reports, vulnerability disclosures, security firm alerts | 30s–5min intervals |
| 5 | **Governance Monitor** | Event subscription | Malicious governance proposals, admin key changes, timelock bypasses | Per block |

### Why 5 Sources Matter

No single source is reliable enough alone:
- Onchain events are **lagging** (they've already happened)
- Oracle feeds can be **manipulated** (that's literally the attack vector)
- Mempool data is **noisy** (thousands of txns per block)
- External feeds are **slow** (human-reported)
- Governance signals are **rare** but **catastrophic** when they fire

**The power is in the convergence.** When 3+ independent sources agree something is wrong, it's almost certainly real.

### Key Design Decision

Each source runs as an **independent process** with its own heartbeat monitor. If Source #3 (Mempool) dies, the other 4 keep running. The system degrades gracefully — it doesn't crash because one data feed went down.

---

## Layer 2: Signal Processing

> **Question this layer answers:** *"Is this noise or a real signal?"*

### Pipeline: Normalize → Filter → Score → Buffer

```
Raw Event → [Signal Normalizer] → [Noise Filter] → [Signal Scorer] → [Signal Buffer]
```

**Signal Normalizer** — Converts every raw event from every source into a unified `ThreatSignal` format:

```typescript
interface ThreatSignal {
  id: string;                    // unique signal ID
  source: SignalSource;          // which of the 5 sources
  protocol: string;              // e.g., "aave-v3"
  chain: Chain;                  // e.g., "ethereum"
  signalType: SignalType;        // e.g., "TVL_DROP", "ORACLE_DEVIATION"
  rawValue: number;              // e.g., -18.5 (TVL dropped 18.5%)
  timestamp: number;             // block timestamp
  blockNumber: number;           // block number
  confidence: number;            // 0.0 - 1.0
  metadata: Record<string, any>; // source-specific context
}
```

**Noise Filter & Deduplication** — Removes:
- Duplicate signals (same event from multiple RPC nodes)
- Known false positive patterns (e.g., rebalancing events that look like large withdrawals)
- Signals below minimum severity threshold

**Signal Scorer** — Assigns a severity weight (0.0–1.0) based on:
- Signal type severity (oracle deviation > TVL drop > governance change)
- Magnitude (15% TVL drop scores higher than 5%)
- Historical context (is this protocol known for volatile TVL?)

**Signal Buffer (Event Queue)** — Kafka-inspired queue that:
- Ensures no signal is lost during processing spikes
- Provides ordered delivery to the Consensus Engine
- Allows replay for post-incident analysis

---

## Layer 3: Consensus Engine — "The Brain"

> **Question this layer answers:** *"Are enough signals converging to confirm a threat?"*

This is the most critical layer. It determines whether to **evacuate or not**. Getting this wrong in either direction is catastrophic:
- **False positive** → unnecessary exit → gas costs, DEX slippage, user frustration
- **False negative** → missed exploit → user loses everything

### Threat Level State Machine

```
GREEN (Normal)  →  YELLOW (Elevated)  →  ORANGE (Warning)  →  RED (Evacuation)
     ↑                    ↑                     ↑                    ↓
     └────────────────────┴─────────────────────┘              EXECUTE EXIT
                    (signals decay over time)
```

### Multi-Signal Correlator

Takes scored signals from the buffer and checks for **convergence** — are multiple independent signals pointing at the same protocol at the same time?

**Scoring formula:**

$$\text{ThreatScore} = \sum_{i=1}^{n} (w_i \times s_i \times c_i)$$

Where:
- $w_i$ = weight of signal type $i$ (oracle deviation = 0.9, TVL drop = 0.8, governance = 0.7, etc.)
- $s_i$ = severity score of signal $i$ (0.0–1.0)
- $c_i$ = confidence of signal $i$ (0.0–1.0)
- $n$ = number of concurrent signals for the same protocol

### Decision Gate 1: Threshold Check

```
if ThreatScore >= user.evacuationThreshold:
    → proceed to Confirmation Gate
else:
    → LOG signal, update threat level, continue monitoring
```

### Confirmation Gate (Second Check)

Even when the score crosses the threshold, we don't immediately execute. We perform 3 rapid confirmations:

1. **Cross-validate with independent source** — If the trigger came from onchain events, check the oracle. If it came from the oracle, check onchain TVL.
2. **Simulate exit transaction (dry run)** — Use `eth_call` to simulate the withdrawal. If the simulation fails, the protocol may already be paused or drained.
3. **Check for known false positive patterns** — Compare against a database of known benign events (protocol migrations, scheduled rebalances, etc.)

### Decision Gate 2: Confirmed Threat

```
if all 3 confirmations pass:
    → TRIGGER EVACUATION PROTOCOL 🔴
else:
    → DOWNGRADE TO WARNING (alert user, continue monitoring)
```

### Why Two Decision Gates?

From our competitive research:
- **ShieldFi** uses a single threshold → too many false positives
- **Forta** uses multi-signal but doesn't execute → stops at the alert
- **Vindex** uses multi-signal + confirmation gate → minimizes false positives AND executes

---

## Layer 4: Pre-Execution Validator

> **Question this layer answers:** *"Can we safely execute the exit?"*

Even after confirming a threat, we don't blindly execute. This layer runs a safety checklist:

### Step-by-Step Validation

1. **Position Resolver**
   - Identifies exact tokens, amounts, and contract addresses for the user's position
   - Checks current state: Is the position still active? Has it already been partially withdrawn?

2. **Exit Path Calculator**
   - Determines the optimal withdrawal route
   - Example: Aave → withdraw USDC directly (no swap needed) vs. Curve → withdraw LP tokens → swap via 1inch

3. **Slippage Estimator**
   - Calculates expected output vs. worst-case output
   - Uses DEX aggregator quotes (1inch, Paraswap) to find best price

4. **Decision: Slippage > Max Tolerance?**
   - **YES →** FALLBACK: Skip the DEX swap. Withdraw raw tokens directly to safe wallet. The user gets the protocol tokens (not USDC) but at least they're out.
   - **NO →** Proceed with full swap path.

5. **Transaction Simulator**
   - Dry-runs the entire exit sequence using `eth_call` (no gas cost)
   - Verifies the simulation succeeds end-to-end

6. **Decision: Simulation Success?**
   - **YES →** Proceed to execution
   - **NO →** ABORT. Alert user with full diagnostic: *"Simulation failed. The protocol may be paused. Here's what we found: [details]."*

---

## Layer 5: Execution Orchestrator

> **Question this layer answers:** *"Execute the rescue, now."*

### Atomic Transaction Bundle

All steps are bundled into a **single atomic payload** — either all succeed or none execute:

| Step | Action | Details |
|:--:|:---|:---|
| 1 | **Approve Token Spending** | Only if the protocol requires approval for withdrawal |
| 2 | **Withdraw from Protocol** | Calls the protocol's withdraw/redeem function (Aave, Compound, Curve, etc.) |
| 3 | **Swap to Stablecoin (USDC)** | Routes through DEX aggregator (1inch) for best price |
| 4 | **Transfer to Safe Wallet** | Sends the USDC to the user's pre-configured safe address |

### Routing: Primary vs. Fallback

**PRIMARY PATH — Private Routing:**
```
Atomic Bundle → Flashbots Relay → Block Builder → Blockchain
```
- Invisible to MEV bots
- Bundle is either included atomically or not at all
- Uses `@flashbots/ethers-provider-bundle`

**FALLBACK PATH — Public Mempool:**
```
Atomic Bundle → Public Mempool (with onchain slippage guard) → Blockchain
```
- Used when Flashbots is unavailable (non-Ethereum chains, relay downtime)
- Includes an onchain slippage check (inspired by `GuardedEthTokenSwapper`)
- If slippage exceeds the guard, the transaction reverts (costs gas but protects funds)

### When Does Fallback Trigger?

- Flashbots relay is unreachable (timeout after 2 seconds)
- We're on a chain without Flashbots support (Arbitrum, Polygon, etc.)
- The bundle has been rejected by 3 consecutive block builders

---

## Layer 6: KeeperHub Execution Layer

> **Question this layer answers:** *"Handle the ugly parts of blockchain execution."*

This is where KeeperHub shines. We don't build any of this ourselves:

| Component | What It Does | Emergency Behavior |
|:---|:---|:---|
| **Smart Gas Estimator** | Estimates optimal gas price for block inclusion | Emergency Mode: 2x–5x priority fee boost |
| **Nonce Manager** | Tracks and manages transaction nonces | Prevents nonce collisions during rapid-fire txns |
| **Retry Engine** | Retries failed/dropped transactions | Exponential backoff, max 3 attempts, auto fee bump |
| **Secure Enclave Signing** | Signs transactions in a secure enclave | No private key ever exposed in memory or logs |
| **Transaction Status Monitor** | Watches for confirmation/failure | Feeds status back to Post-Execution layer |

### Why KeeperHub and Not DIY?

From our competitive research:
- **MakerDAO Keepers** spent years perfecting gas management → we get it for free
- **Gelato** built a decentralized executor network → KeeperHub provides the same reliability
- **ShieldFi** rolled their own execution → fragile, no retry logic, no gas adaptation

---

## Layer 7: Post-Execution

> **Question this layer answers:** *"Did it work? Can we prove it?"*

### Three Outputs

1. **Audit Trail Generator**
   Creates a timestamped, immutable log:
   ```
   [2026-08-11 03:14:22 UTC] TRIGGER: Oracle deviation 7.2% on Aave USDC/ETH
   [2026-08-11 03:14:22 UTC] TRIGGER: TVL drop 18.5% on Aave V3 ETH pool
   [2026-08-11 03:14:23 UTC] CONSENSUS: ThreatScore 8.7/10 — EVACUATION TRIGGERED
   [2026-08-11 03:14:23 UTC] SIMULATION: Exit path validated, expected output: 19,847 USDC
   [2026-08-11 03:14:24 UTC] EXECUTION: Bundle submitted via Flashbots
   [2026-08-11 03:14:36 UTC] CONFIRMED: Tx 0xabc...def included in block 19,847,231
   [2026-08-11 03:14:36 UTC] RESULT: 19,812 USDC received in safe wallet 0x123...789
   [2026-08-11 03:14:36 UTC] GAS COST: 0.008 ETH ($24.50)
   [2026-08-11 03:14:36 UTC] STATUS: EVACUATION COMPLETE ✅
   ```

2. **User Notification**
   Sends via configured channel (Telegram, Discord, email, webhook):
   > *"🚨 Vindex rescued your funds from Aave V3. 19,812 USDC is now safe in your backup wallet. Gas cost: $24.50. [View full audit trail →]"*

3. **Verification Check**
   Confirms the funds actually arrived in the safe wallet by reading the balance post-execution.

### Final Decision Gate

```
if funds verified in safe wallet:
    → EVACUATION COMPLETE ✅
else:
    → ESCALATE: Manual intervention required ⚠️
    → Send emergency alert with full diagnostic to user
```

---

## Failure Modes & Handlers

| Failure | Handler | Severity |
|:---|:---|:---|
| RPC Node Down | Fallback to backup RPC (Alchemy → Infura → public) | Medium |
| Gas Spike Beyond Budget | KeeperHub emergency gas override (up to 5x normal) | Medium |
| DEX Liquidity Too Low | Skip swap, withdraw raw tokens to safe wallet | Low |
| Protocol Paused/Frozen | Alert user, log attempt, set retry on unpause event | High |
| Flashbots Relay Down | Switch to public mempool with onchain slippage guard | Medium |
| All 3 Retries Exhausted | Emergency alert to user with full diagnostic | Critical |
| Simulation Fails | Abort execution, alert user, log for analysis | High |

---

## User Configuration (Left Sidebar)

These are the knobs the user controls at setup time:

| Parameter | Description | Default |
|:---|:---|:---|
| **Monitored Positions** | Protocol, token, amount to watch | User-defined |
| **Safe Wallet Address** | Where rescued funds are sent | User-defined (required) |
| **Threat Thresholds** | TVL drop %, oracle deviation %, etc. | TVL: 15%, Oracle: 5% |
| **Max Slippage Tolerance** | Maximum acceptable DEX slippage | 2% |
| **Gas Budget** | Normal vs. emergency gas limits | Normal: 2x base, Emergency: 5x base |
| **Notification Preferences** | Telegram, Discord, email, webhook | Telegram |

---

## Systems Thinking Questions

If you're studying this diagram, ask yourself:

1. **Single points of failure:** What happens if the Consensus Engine has a bug? *Answer: The Pre-Execution Validator catches impossible states. The Transaction Simulator catches bad transactions.*

2. **Cascading failures:** What if an exploit causes both the protocol AND the DEX to be attacked simultaneously? *Answer: Slippage Estimator detects abnormal pricing → Fallback: withdraw raw tokens, skip swap.*

3. **Race conditions:** What if two signals arrive at the exact same time for different protocols? *Answer: Each protocol has an independent monitoring context. Parallel evacuations can execute simultaneously.*

4. **Trust boundaries:** Where does Vindex have custody of funds? *Answer: Never. KeeperHub's secure enclave signs transactions. The user's safe wallet receives funds. Vindex only orchestrates — it never holds.*

5. **Adversarial thinking:** Could an attacker trick Vindex into a false evacuation? *Answer: The Confirmation Gate cross-validates with independent sources and checks for known false positive patterns. An attacker would need to compromise 3+ independent data sources simultaneously.*
