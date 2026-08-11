# Vindex — Hackathon Execution PRD v2

**Product:** Vindex  
**Version:** 2.0  
**Date:** 2026-08-11  
**Status:** Approved scope for implementation  
**Hackathon:** KeeperHub — The Last Mile  
**Canonical demo network:** Base Sepolia (`chainId 84532`)  
**Canonical protocol:** Aave V3 Base Sepolia  
**Canonical protected asset:** Aave Base Sepolia USDC test asset  
**Execution layer:** KeeperHub  
**Product loop:** `WATCH → CONFIRM → EXIT → VERIFY`

---

## 1. Executive Summary

Vindex is an autonomous DeFi protection agent that watches a supported DeFi position, evaluates live risk signals, confirms whether a configured protection policy has been satisfied, validates the exit, executes the evacuation through KeeperHub, verifies the configured safe-wallet destination, and generates a Rescue Receipt containing the evidence.

The hackathon build must prove one narrow vertical slice end-to-end with **real testnet state and real onchain transactions**. It must not rely on mocked balances, fabricated transaction hashes, fabricated threat values, or fake execution states.

The canonical V1 demo is:

```text
REAL BASE SEPOLIA STATE
        ↓
AAVE V3 USDC POSITION OWNED BY KEEPERHUB EXECUTION WALLET
        ↓
REAL SIGNAL OBSERVATIONS
        ↓
VINDEX POLICY + CONSENSUS
        ↓
PRE-EXECUTION SIMULATION
        ↓
KEEPERHUB CONTRACT EXECUTION
        ↓
AAVE V3 withdraw(USDC, amount, SAFE_WALLET)
        ↓
REAL BASE SEPOLIA TRANSACTION
        ↓
SAFE-WALLET BALANCE VERIFICATION
        ↓
VINDEX RESCUE RECEIPT
```

The build is intentionally narrow. Vindex will prove that an autonomous protection decision can reach a verifiable onchain outcome through KeeperHub. Multi-chain support, DEX swaps, full mempool intelligence, five independent security vendors, DAO permissions, and production-grade private routing are not part of this hackathon implementation unless the core slice is already complete and verified.

---

## 2. Hackathon Requirement and Network Decision

### 2.1 What the hackathon actually requires

The KeeperHub brief requires every submission to use KeeperHub as its onchain execution layer and to ship a working agent that executes onchain. Every submission must link a transaction executed by the agent through KeeperHub.

The brief does **not** require mainnet.

### 2.2 Why Base Sepolia is the canonical V1 network

Base Sepolia is suitable for the complete Vindex hackathon loop because:

- KeeperHub lists Base Sepolia as a stable, recommended hackathon testnet.
- KeeperHub direct execution supports Base Sepolia.
- KeeperHub can perform arbitrary verified smart-contract calls through its Web3/direct execution surface.
- Aave V3 has an official Base Sepolia deployment.
- The final rescue still produces a real transaction hash, block inclusion, gas usage, destination balance change, and BaseScan proof.
- Testnet removes the unnecessary financial risk of deliberately triggering emergency logic with real mainnet capital.

**Decision:** Build and judge the canonical Vindex hackathon slice on Base Sepolia. Mainnet becomes a post-hackathon deployment target, not a hackathon acceptance requirement.

---

## 3. Critical Asset Compatibility Note

There are two different USDC-style test assets relevant to Base Sepolia and they must not be confused.

### KeeperHub quickstart Base Sepolia USDC

```text
0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

This is the Base Sepolia USDC address KeeperHub lists for general testnet usage.

### Aave V3 Base Sepolia USDC market asset

```text
0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f
```

Aave's official address book identifies this as the USDC underlying asset used by the Aave V3 Base Sepolia market.

**Vindex must use the Aave-market asset (`0xba50…4D5f`) for the protected Aave position.** The generic KeeperHub/Circle-style test USDC (`0x036C…CF7e`) must not be substituted into the Aave supply/withdraw flow unless the Aave deployment later adds that exact token.

The UI should label the protected asset clearly as:

> **USDC — Aave Base Sepolia test asset**

Do not market this test token as mainnet USDC or imply that testnet assets have monetary value.

---

## 4. Canonical Contract Registry

The following registry is the starting source of truth for V1. Implementation must validate bytecode/ABI availability before first use and fail closed if chain or contract identity differs.

| Component | Base Sepolia address |
|---|---|
| Aave V3 Pool Addresses Provider | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` |
| Aave V3 Pool | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` |
| Aave Oracle | `0x943b0dE18d4abf4eF02A85912F8fc07684C141dF` |
| Aave Protocol Data Provider | `0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b` |
| Aave Base Sepolia USDC underlying | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` |
| Aave Base Sepolia aUSDC | `0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC` |
| Aave Base Sepolia USDC oracle | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` |

Canonical network:

```text
name: Base Sepolia
chainId: 84532
explorer: BaseScan Sepolia
```

All chain IDs and target contract addresses must be server-side allowlisted.

---

## 5. Product Goal

### 5.1 Primary goal

Prove that Vindex can take a supported DeFi position from **live monitoring** to a **real, verified KeeperHub evacuation** without fabricating the state that judges see.

### 5.2 The single strongest demo claim

> Vindex monitored a real Aave V3 Base Sepolia position, evaluated live onchain measurements, triggered a transparent high-sensitivity protection drill, simulated the exit, executed the Aave withdrawal through KeeperHub, verified the safe wallet received the asset, and produced a complete Rescue Receipt linked to the onchain transaction.

### 5.3 What success is not

Success is not:

- a threat dashboard with a fake RED button;
- a local JSON fixture saying an exploit happened;
- a transaction submitted directly through viem while the UI claims KeeperHub executed it;
- a fake transaction hash;
- a receipt generated before the safe-wallet balance is checked;
- a Base mainnet logo wrapped around a testnet execution;
- a simulation presented as an evacuation.

---

## 6. Scope

### 6.1 P0 — Must ship

1. Base Sepolia network lock.
2. KeeperHub execution-wallet identification and health check.
3. Separate user-configured safe wallet.
4. Real Aave V3 Base Sepolia USDC position owned by the KeeperHub execution wallet.
5. Real onchain position discovery.
6. Real signal observations derived from Base Sepolia/Aave state.
7. Signal normalization and persistence.
8. Transparent high-sensitivity **DRILL** policy for hackathon demonstration.
9. Multi-signal decision/consensus gate.
10. Pre-execution state validation and transaction simulation.
11. Real Aave `withdraw` executed through KeeperHub.
12. KeeperHub execution ID/status tracking.
13. Real transaction hash and BaseScan link.
14. Safe-wallet before/after USDC balance verification.
15. Rescue Receipt generated from persisted evidence.
16. Existing UI shell wired to server-authoritative states.
17. Failure states and diagnostic messages.
18. End-to-end demo run repeatable from a fresh protected position.

### 6.2 P1 — Add only after P0 is green

- scheduled/background monitoring cadence;
- third live signal family;
- user notifications;
- richer KeeperHub audit data;
- configurable policy templates;
- performance timing dashboard;
- one additional execution failure/recovery demo.

### 6.3 Explicitly out of scope for hackathon V1

- multi-chain protection;
- multiple DeFi protocols;
- mainnet capital;
- autonomous DEX swapping;
- 1inch/Paraswap routing;
- Flashbots bundle integration implemented by Vindex;
- custom private-mempool routing implemented by Vindex;
- five production threat-feed integrations;
- ML threat classification;
- generalized mempool exploit detection;
- DAO role-based controls;
- insurance claims;
- subscription billing;
- x402 billing unless the core rescue is already finished;
- claims of universal DeFi protection.

---

## 7. Wallet and Ownership Model

This is a critical V1 architectural constraint.

### 7.1 Execution wallet

The protected Aave position must be owned by the wallet KeeperHub can actually sign from for the rescue transaction.

For V1:

```text
KeeperHub execution wallet
        owns
Aave aUSDC position
```

Vindex itself must never store or handle a plaintext private key.

### 7.2 Safe wallet

The safe wallet is a separate Base Sepolia address configured by the user/operator.

```text
Aave position owner: KeeperHub execution wallet
Emergency destination: configured safe wallet
```

The safe wallet must not be silently changed after a protection policy is armed. Changing it requires an explicit reconfiguration flow and re-validation.

### 7.3 Connected UI wallet

If the existing UI shell already has wallet connection, it may remain for operator identity and user experience, but the UI must never imply that KeeperHub can automatically withdraw an arbitrary connected wallet's Aave position unless a real delegation mechanism has been implemented and verified.

For the hackathon vertical slice, the source-of-truth protected position belongs to the KeeperHub execution wallet.

---

## 8. Creating the Real Protected Position

Vindex must be able to prove that the position being protected exists onchain before monitoring begins.

### 8.1 Funding

The KeeperHub execution wallet requires:

- Base Sepolia ETH for gas where required; and
- the **Aave Base Sepolia USDC test asset** used by the Aave market.

The exact faucet/acquisition path for the Aave-specific test asset must be validated during Foundation. Do not substitute a different USDC token simply because its symbol is also `USDC`.

### 8.2 Position creation

The preferred setup flow uses KeeperHub for the writes as well, increasing the strength of the integration proof:

1. Read USDC balance of KeeperHub execution wallet.
2. KeeperHub executes `USDC.approve(AAVE_POOL, amount)`.
3. Track and verify approval transaction.
4. KeeperHub executes `AAVE_POOL.supply(asset, amount, keeperhubWallet, 0)`.
5. Track and verify supply transaction.
6. Read resulting aUSDC balance / reserve data.
7. Persist the protected position only after the position is proven onchain.

If the position is created manually during initial setup, the rescue transaction still must execute through KeeperHub; however, KeeperHub-created setup transactions are preferred.

---

## 9. Core User Journey

### 9.1 Configure

The user/operator sees the KeeperHub execution wallet and configures:

- supported position: Aave V3 Base Sepolia / USDC;
- safe-wallet address;
- evacuation amount mode: `FULL_POSITION` for V1;
- policy mode: `STANDARD` or `DRILL_HIGH_SENSITIVITY`;
- monitoring enabled/disabled.

Before arming, Vindex verifies:

- chain = Base Sepolia;
- Aave Pool contract matches registry;
- execution wallet has a non-zero aUSDC position;
- safe wallet is a valid non-zero EVM address;
- safe wallet is not the Aave Pool or protected-token contract;
- KeeperHub is reachable.

### 9.2 Watch

Vindex repeatedly collects real measurements and displays the latest persisted snapshot.

UI state:

> **WATCHING** — No confirmed protection condition.

### 9.3 Elevate

A policy condition becomes interesting but the execution threshold has not been met.

UI state:

> **SIGNALS ELEVATED** — Unusual or drill-sensitive conditions detected. No funds moved.

### 9.4 Confirm

At least the required number of signal families satisfy the configured policy within the correlation window.

Vindex:

- locks a decision window;
- re-reads the critical state;
- confirms the position still exists;
- checks for duplicate evacuation;
- records the contributing signals;
- runs simulation.

UI state:

> **CONFIRMING** — Vindex is validating the evidence and exit. No funds moved.

### 9.5 Evacuate

When confirmation and simulation pass, Vindex calls KeeperHub to execute the Aave withdrawal.

UI state:

> **EVACUATING** — KeeperHub execution submitted. Safe-wallet verification pending.

### 9.6 Verify

Vindex waits for KeeperHub/onchain finality, reads the destination USDC balance, compares it to the pre-execution baseline, and verifies the expected movement.

Only then:

> **PROTECTED** — Safe-wallet result verified.

### 9.7 Receipt

The Rescue Receipt is created from immutable execution/audit records and shown to the user.

---

## 10. Real Signal Engine

### 10.1 Rule: no fabricated signal values

Signal values displayed by Vindex must come from actual RPC/contract reads or actual observed events. Hardcoded values such as `oracleDeviation: 7.2` are prohibited outside unit tests.

Each persisted observation must contain enough provenance to explain where the number came from.

Minimum `SignalObservation` fields:

```text
id
positionId
chainId
protocol
sourceFamily
metric
rawValue
normalizedValue
contractAddress
blockNumber
blockTimestamp
observedAt
rpcSource / provider label
metadata
```

### 10.2 V1 signal families

The V1 engine should implement at least two live measurement families and preferably three:

**A. Oracle / price-state observation**  
Read the relevant Aave oracle value or source contract for the protected market. Track the current value, previous persisted value, block number and observation age.

**B. Aave reserve-state observation**  
Read Aave Pool/Data Provider state for the protected USDC reserve: liquidity/supply-related state available from the deployed contracts. Persist the live values and changes between observation windows.

**C. Position / event observation**  
Read the protected wallet's aUSDC position and/or watch real Aave Pool events affecting the reserve or protected position.

V1 does not claim these are equivalent to five independent professional security vendors. They are independent measurement families over live testnet state. Production-grade source diversity is post-hackathon scope.

---

## 11. Standard Policy vs. Drill Policy

The hackathon needs a repeatable trigger without pretending Aave is currently under attack.

### 11.1 `STANDARD` policy

Represents realistic protection semantics and conservative thresholds. It may stay in WATCHING throughout the demo because a real exploit is not expected.

### 11.2 `DRILL_HIGH_SENSITIVITY` policy

A transparent hackathon/demo mode that evaluates the same **real measurements** with intentionally sensitive thresholds so the complete autonomous pipeline can be exercised.

Rules:

- The UI must visibly display `PROTECTION DRILL` or `HIGH-SENSITIVITY DEMO POLICY`.
- The system must never label the drill as a real Aave exploit.
- No raw signal value may be invented.
- The policy may lower thresholds; it may not inject fake observations.
- The receipt must record `policyMode = DRILL_HIGH_SENSITIVITY`.

This gives judges a repeatable real execution while preserving honesty about what caused it.

### 11.3 Consensus gate

Canonical V1 rule:

```text
2 of 3 eligible live signal conditions
within the configured correlation window
+ confirmation re-read
+ successful simulation
= evacuation authorized
```

If only one condition is satisfied, Vindex may move to ELEVATED but must not evacuate.

---

## 12. Threat/Protection State Machine

Backend states are authoritative.

```text
DRAFT
  ↓
ARMED
  ↓
WATCHING
  ↓
ELEVATED
  ↓
CONFIRMING
  ↓
SIMULATING
  ├── failed → BLOCKED
  ↓ passed
EXECUTION_QUEUED
  ↓
EXECUTING
  ├── failed → FAILED
  ├── unknown → EXECUTION_UNKNOWN
  ↓ confirmed
VERIFYING
  ├── mismatch/timeout → INTERVENTION_REQUIRED
  ↓ verified
PROTECTED
```

The public UI may collapse these into the brand states:

```text
WATCHING
CONFIRMING
EVACUATING
PROTECTED
BLOCKED
```

No UI component may independently advance the state machine.

---

## 13. Pre-Execution Validator

Before any KeeperHub write, Vindex must re-validate the rescue.

### 13.1 Required checks

1. Chain ID is exactly `84532`.
2. Target Pool equals the allowlisted Aave Pool.
3. Asset equals the allowlisted Aave Base Sepolia USDC asset.
4. Safe wallet equals the armed policy destination.
5. Protected position has non-zero withdrawable balance.
6. No active or completed evacuation already exists for the same protection event.
7. Amount is not greater than the current position balance.
8. Policy/consensus decision is still valid and not expired.
9. Simulation succeeds against current chain state.

### 13.2 Simulation

Simulate the intended Aave withdrawal against current state before KeeperHub submission.

Canonical rescue call:

```solidity
AAVE_POOL.withdraw(
  USDC_ASSET,
  amount,
  SAFE_WALLET
)
```

For a full-position evacuation, implementation may use the supported Aave max-withdraw convention if verified for the deployed contract, otherwise use the current detected balance with safe rounding.

The simulation result must be persisted with:

- block number;
- target;
- calldata/function and decoded parameters;
- expected success/revert;
- revert reason if available;
- timestamp.

If simulation fails, transition to `BLOCKED`; do not submit the transaction.

---

## 14. KeeperHub Execution

### 14.1 Canonical execution surface

Use KeeperHub as the actual onchain submitter.

Preferred hackathon integration:

```text
KeeperHub MCP / Direct On-Chain Execution
  execute_contract_call
  get_direct_execution_status
```

The dedicated KeeperHub Aave V3 protocol plugin currently documents mainnet support for Ethereum, Base, Arbitrum and Optimism, not Base Sepolia. Therefore **Vindex V1 must not depend on that plugin for the testnet rescue**.

Instead, use KeeperHub's generic smart-contract execution surface against the official Aave Base Sepolia Pool. This preserves the exact hackathon requirement: KeeperHub is still the execution layer that submits the state-changing transaction.

### 14.2 Execution request

The server creates a KeeperHub execution request with:

- `chainId = 84532` / Base Sepolia;
- target = allowlisted Aave Pool;
- function = `withdraw`;
- asset = allowlisted Aave Base Sepolia USDC;
- amount = validated evacuation amount;
- destination = armed safe wallet.

The request must be created server-side from persisted authoritative state. The client must not be allowed to submit arbitrary contract addresses or calldata.

### 14.3 Execution persistence

Persist immediately:

```text
executionId
positionId
decisionId
simulationId
keeperhubExecutionId
status
chainId
target
function
parametersHash
safeWallet
requestedAmount
submittedAt
txHash (when available)
blockNumber (when confirmed)
gas/cost metadata (when available)
error classification
```

### 14.4 Status discipline

Vindex must distinguish:

- request accepted;
- KeeperHub execution submitted;
- transaction hash received;
- transaction confirmed;
- destination verified.

A transaction hash alone is not `PROTECTED`.

---

## 15. Post-Execution Verification

### 15.1 Before execution

Capture:

- safe-wallet USDC balance;
- KeeperHub wallet aUSDC balance / position amount;
- block number.

### 15.2 After confirmation

Read:

- safe-wallet USDC balance;
- remaining position/aUSDC balance;
- transaction receipt;
- block number and timestamp.

### 15.3 Verification rule

The rescue is verified when the observed safe-wallet balance increase is consistent with the confirmed withdrawal result, allowing only explicitly documented token/accounting behavior.

For V1, because the exit has no DEX swap, verification is intentionally simple:

```text
Aave USDC position
        ↓ withdraw
same USDC asset
        ↓
safe wallet
```

No slippage calculation is required in the canonical path.

### 15.4 Failure

If the transaction is confirmed but the safe-wallet balance cannot be reconciled:

```text
status = INTERVENTION_REQUIRED
```

Do not show `PROTECTED`.

---

## 16. Rescue Receipt

The Rescue Receipt is Vindex's primary proof object.

Minimum content:

```text
VINDEX RESCUE / <receipt id>

NETWORK        Base Sepolia
PROTOCOL       Aave V3
POSITION       USDC — Aave Base Sepolia test asset
POLICY         Standard | Protection Drill / High Sensitivity
TRIGGER        <actual contributing signal observations>
CONSENSUS      <rule and result>
SIMULATION     Passed / block / timestamp
ACTION         Aave withdraw → Safe Wallet
AMOUNT         <actual amount>
DESTINATION    <safe wallet>
KEEPERHUB      <execution id>
TRANSACTION    <tx hash>
BLOCK          <block number>
GAS            <actual value if available>
PRE-BALANCE    <safe wallet balance>
POST-BALANCE   <safe wallet balance>
VERIFICATION   Passed
STATUS         PROTECTED
AUDIT          <link/id>
```

Receipt rules:

- show real signal values;
- show policy mode;
- show destination explicitly;
- distinguish expected amount from verified received amount;
- include KeeperHub execution ID;
- include transaction proof;
- link to BaseScan Sepolia;
- never call a simulation a rescue;
- never show `PROTECTED` before destination verification.

---

## 17. Backend Data Model

Use the project's existing database choice if already established. The following logical entities are required regardless of ORM.

### `protected_positions`

```text
id
operatorId / owner reference
chainId
protocol
poolAddress
assetAddress
assetSymbol
executionWallet
safeWallet
positionAmount
positionTokenAddress
status
createdAt
updatedAt
```

### `protection_policies`

```text
id
positionId
mode                 STANDARD | DRILL_HIGH_SENSITIVITY
requiredSignals
correlationWindowSec
thresholdsJson
isArmed
armedAt
disarmedAt
version
```

### `signal_observations`

```text
id
positionId
sourceFamily
metric
rawValue
normalizedValue
severity
contractAddress
blockNumber
blockTimestamp
observedAt
metadataJson
```

### `threat_decisions`

```text
id
positionId
policyId
policyVersion
state
score / matchedCount
contributingSignalIds
reasonJson
windowStartedAt
confirmedAt
expiresAt
```

### `simulations`

```text
id
decisionId
chainId
target
function
parametersJson
blockNumber
success
revertReason
createdAt
```

### `executions`

```text
id
decisionId
simulationId
keeperhubExecutionId
chainId
status
txHash
blockNumber
requestedAmount
safeWallet
gasCost
submittedAt
confirmedAt
errorCode
errorDetailsJson
```

### `verification_checks`

```text
id
executionId
assetAddress
destination
preBalance
postBalance
delta
expectedAmount
verified
blockNumber
checkedAt
failureReason
```

### `rescue_receipts`

```text
id
executionId
positionId
policyMode
verifiedAmount
destination
txHash
keeperhubExecutionId
status
receiptJson
createdAt
```

### `audit_events`

Append-only chronological record:

```text
id
positionId
executionId nullable
eventType
detailsJson
blockNumber nullable
createdAt
```

---

## 18. API / Server Surface

Names may be adapted to the existing repository conventions, but responsibilities must remain separate.

### Configuration / positions

```text
GET  /api/vindex/config
PUT  /api/vindex/config
GET  /api/vindex/positions/current
POST /api/vindex/positions/refresh
POST /api/vindex/positions/arm
POST /api/vindex/positions/disarm
```

### Live observations

```text
POST /api/vindex/signals/collect
GET  /api/vindex/signals/latest
GET  /api/vindex/signals/history
```

### Policy / drill

```text
POST /api/vindex/policies/evaluate
POST /api/vindex/drills/start
GET  /api/vindex/decisions/current
```

`/drills/start` may enable or start evaluation under the high-sensitivity policy. It must **not** accept fabricated signal values.

### Execution

```text
POST /api/vindex/executions/prepare
POST /api/vindex/executions/execute
GET  /api/vindex/executions/:id
POST /api/vindex/executions/:id/verify
```

### Receipt / audit

```text
GET /api/vindex/receipts/:id
GET /api/vindex/audit/:positionId
```

### UI updates

Use the simplest reliable approach already compatible with the shell:

- short polling first; or
- SSE if already present and easy to support.

Do not add WebSockets merely for architecture prestige.

---

## 19. Frontend Requirements

The existing full UI shell should be preserved. The implementation task is to replace mock/demo state with server-authoritative data.

### 19.1 No mock-state rule

Production UI code must not contain hardcoded:

- balances;
- signal values;
- threat scores;
- execution IDs;
- transaction hashes;
- timestamps pretending to be live;
- fake receipts.

Empty/loading/error states are allowed.

### 19.2 Primary dashboard data

The dashboard must show:

- network;
- protocol;
- protected asset;
- KeeperHub execution wallet;
- position amount from chain;
- safe wallet;
- policy mode;
- current Vindex state;
- latest signal observations;
- last block observed;
- latest decision reason;
- execution status when active.

### 19.3 UI status language

**WATCHING**  
“Monitoring active. No confirmed protection condition.”

**ELEVATED**  
“Signals elevated. No evacuation has been triggered.”

**CONFIRMING**  
“Vindex is re-checking live state and simulating the supported exit. No funds have moved.”

**EVACUATING**  
“KeeperHub is executing the protected route. Destination verification is pending.”

**PROTECTED**  
“The configured safe wallet received the verified result. View Rescue Receipt.”

**BLOCKED**  
“The exit did not pass validation or simulation. No unsupported execution was submitted.”

For drill mode, add a persistent visible badge:

> `PROTECTION DRILL — HIGH-SENSITIVITY POLICY`

---

## 20. Security Boundaries

### 20.1 Never trust client execution parameters

The client may request an action by ID, but the server derives:

- network;
- Aave Pool;
- asset;
- amount;
- safe wallet;
- policy version;
- KeeperHub payload.

### 20.2 Contract allowlist

V1 writes are allowed only to the exact contracts required for the supported route.

### 20.3 Chain pinning

All execution requests fail if the resolved chain differs from Base Sepolia `84532`.

### 20.4 Destination pinning

Once armed, the safe wallet is part of the policy snapshot. The execution cannot substitute another destination.

### 20.5 Idempotency

Only one evacuation may execute for one confirmed decision window.

Use a DB uniqueness/lock strategy so retries at the HTTP/UI layer cannot create duplicate KeeperHub writes.

### 20.6 Execution uncertainty

If KeeperHub status is unknown or a request times out after submission, Vindex must query status before attempting another write. Never blindly resubmit a potentially live withdrawal.

### 20.7 Secrets

KeeperHub credentials are server-only. No API key, wallet secret, signing material or privileged request payload is exposed to the browser.

---

## 21. Failure Modes

| Failure | Required behavior |
|---|---|
| Base Sepolia RPC unavailable | Try configured fallback provider; remain WATCHING/DEGRADED; no execution from stale data |
| KeeperHub unavailable before submit | BLOCKED/EXECUTION_UNAVAILABLE; no direct-RPC fallback for hackathon rescue |
| KeeperHub response unknown after submit | Query direct execution status; do not blindly retry |
| No Aave position | Do not arm; show setup diagnostic |
| Wrong USDC token | Reject configuration; show exact expected Aave asset |
| Signal collection stale | Do not confirm threat; show stale-feed diagnostic |
| Only one signal qualifies | ELEVATED; continue monitoring |
| Confirmation re-read fails | BLOCKED; no transaction |
| Simulation reverts | BLOCKED; persist revert reason |
| Position already withdrawn | Mark resolved/no-op if verified; do not submit duplicate withdrawal |
| Tx reverts | FAILED; persist KeeperHub + chain error |
| Tx confirms but destination delta mismatches | INTERVENTION_REQUIRED; do not show PROTECTED |
| Receipt rendering fails | Execution remains recorded; receipt can be regenerated from persisted evidence |

**Important hackathon rule:** do not bypass KeeperHub with a direct viem transaction when KeeperHub fails. That would weaken the core judging proof. Failure should be visible and correctly handled.

---

## 22. Observability and Audit Requirements

Every transition must emit an audit event.

Minimum events:

```text
POSITION_DISCOVERED
POLICY_ARMED
SIGNAL_OBSERVED
STATE_ELEVATED
CONSENSUS_REACHED
CONFIRMATION_STARTED
CONFIRMATION_PASSED
SIMULATION_STARTED
SIMULATION_PASSED
SIMULATION_FAILED
KEEPERHUB_SUBMISSION_REQUESTED
KEEPERHUB_EXECUTION_ACCEPTED
TX_HASH_OBSERVED
TX_CONFIRMED
DESTINATION_VERIFICATION_STARTED
DESTINATION_VERIFIED
DESTINATION_MISMATCH
RESCUE_RECEIPT_CREATED
EXECUTION_FAILED
INTERVENTION_REQUIRED
```

Each event includes an application timestamp. Onchain-derived events also include block number/timestamp where applicable.

---

## 23. Non-Functional Requirements

### Reliability

- No duplicate rescue for one decision.
- No `PROTECTED` state without destination proof.
- No execution from stale/expired consensus.
- No execution when simulation fails.

### Performance

Measure and display internally:

```text
first qualifying signal → consensus
after consensus → simulation complete
simulation complete → KeeperHub submission
KeeperHub submission → tx hash
tx hash → confirmation
confirmation → safe-wallet verification
```

Do not create arbitrary latency promises until measured on the actual implementation.

### Type safety

- strict TypeScript;
- typed chain/contract registry;
- schema validation for external responses;
- no broad `any` on KeeperHub/onchain boundaries.

### Build quality

Required before milestone completion:

```text
lint: 0 errors
TypeScript: 0 errors
production build: successful
relevant automated tests: passing
```

---

## 24. Acceptance Tests

### A. Contract/network foundation

- [ ] App resolves Base Sepolia chain ID `84532`.
- [ ] Aave Pool code exists at configured address.
- [ ] Aave Data Provider read succeeds.
- [ ] Aave USDC/aUSDC addresses match registry.
- [ ] Wrong chain fails closed.

### B. Position proof

- [ ] KeeperHub execution wallet contains a real Aave Base Sepolia USDC position.
- [ ] Vindex reads non-zero aUSDC/current supplied balance from chain.
- [ ] UI displays the exact chain-derived value.

### C. Signals

- [ ] At least two live signal families are collected.
- [ ] Every displayed signal includes real block/timestamp provenance.
- [ ] No mock signal payload is used in the E2E demo.

### D. Consensus

- [ ] One qualifying signal does not evacuate.
- [ ] Required signal convergence creates a decision record.
- [ ] Drill mode is visibly labeled.
- [ ] Confirmation re-read occurs before simulation.

### E. Simulation

- [ ] Correct withdrawal simulates successfully.
- [ ] Invalid destination/asset/position scenario is rejected.
- [ ] Reverting simulation prevents KeeperHub execution.

### F. KeeperHub execution

- [ ] Rescue write is submitted through KeeperHub.
- [ ] KeeperHub execution ID is persisted.
- [ ] Transaction hash is obtained from KeeperHub execution status.
- [ ] Transaction is visible on BaseScan Sepolia.
- [ ] No direct-RPC sender was used for the rescue transaction.

### G. Verification

- [ ] Safe-wallet pre-balance captured.
- [ ] Safe-wallet post-balance captured.
- [ ] Expected balance delta verified.
- [ ] Position decreases/clears as expected.
- [ ] Only verified result transitions to PROTECTED.

### H. Receipt

- [ ] Receipt uses persisted real data only.
- [ ] Contains contributing signals.
- [ ] Contains policy mode.
- [ ] Contains KeeperHub execution ID.
- [ ] Contains BaseScan transaction proof.
- [ ] Contains verified destination balance/result.

### I. Idempotency

- [ ] Double-click/repeated API request cannot create two withdrawals for the same decision.
- [ ] Unknown KeeperHub status is resolved before any retry.

---

## 25. Build Milestones — Recommended Order

### M0 — Real-network foundation

Create chain registry, env validation, contract allowlist, Base Sepolia RPC clients, KeeperHub connectivity check, and remove/disable shell mock data paths.

**Exit:** app can prove network, contracts and KeeperHub are reachable.

### M1 — KeeperHub execution proof on Base Sepolia

Execute a harmless small contract/token action through KeeperHub and persist execution ID + tx hash.

**Exit:** a Base Sepolia transaction executed through KeeperHub is independently verifiable.

### M2 — Real Aave protected position

Acquire the correct Aave Base Sepolia test USDC, approve Aave Pool, supply a small amount, and verify the resulting position.

**Exit:** KeeperHub execution wallet has a real Aave USDC position Vindex can read.

### M3 — Position service + dashboard wiring

Read current position, safe wallet, balances, network and block data. Replace shell mocks for these fields.

**Exit:** dashboard reflects live position state.

### M4 — Signal ingestion

Implement at least two live measurement families, normalization, persistence and history.

**Exit:** dashboard shows live, provenance-backed signals.

### M5 — Policy and consensus engine

Implement STANDARD + DRILL_HIGH_SENSITIVITY policies, correlation window, state transitions and audit events.

**Exit:** real observations can move WATCHING → ELEVATED → CONFIRMING without fabricated values.

### M6 — Pre-execution validator

Implement chain/contract/destination/amount/idempotency checks and withdrawal simulation.

**Exit:** valid position simulates; invalid paths fail closed.

### M7 — Real KeeperHub evacuation

Execute `Aave Pool.withdraw` through KeeperHub to the configured safe wallet.

**Exit:** real KeeperHub execution ID + Base Sepolia transaction hash.

### M8 — Destination verification + Rescue Receipt

Capture before/after balances, verify result, persist full audit chain and render the receipt.

**Exit:** PROTECTED state is backed by destination proof.

### M9 — Failure/retry hardening

Handle KeeperHub unavailable, execution unknown, RPC failover, simulation revert and duplicate triggers.

**Exit:** failure modes are visible, safe and auditable.

### M10 — Full E2E and submission proof

Reset a small protected position, run the complete drill without manual database edits, record demo, and capture the final KeeperHub transaction link.

**Exit:** submission-ready project.

---

## 26. Canonical Demo Script

The final demo should be short and evidence-heavy.

### Scene 1 — Real protected position

Show:

- Base Sepolia;
- KeeperHub execution wallet;
- Aave V3 USDC supplied balance;
- configured safe wallet;
- `WATCHING` state.

### Scene 2 — Live signal evidence

Show current observations and their block numbers/timestamps.

Turn on or run the **Protection Drill / High-Sensitivity Policy**. Do not inject fake numbers.

### Scene 3 — Consensus

Show:

- which real conditions qualified;
- 2-of-3 / configured consensus;
- confirmation re-read;
- simulation result.

### Scene 4 — KeeperHub execution

Show:

- `EVACUATING`;
- KeeperHub execution ID;
- transaction hash when available;
- direct link to BaseScan Sepolia.

### Scene 5 — Verification

Show:

- safe-wallet pre-balance;
- safe-wallet post-balance;
- confirmed delta;
- remaining Aave position.

### Scene 6 — Rescue Receipt

End on the Rescue Receipt and briefly show the KeeperHub/BaseScan proof.

**Narrative:**

> “The threat policy is intentionally high-sensitivity for this protection drill, but the data is live and the execution is not simulated. Vindex evaluates real Base Sepolia/Aave state, confirms the policy, simulates the withdrawal, asks KeeperHub to execute it, and only marks the position protected after the safe wallet is verified.”

---

## 27. Judging Alignment

### Executes onchain via KeeperHub

The core rescue is a real Aave state-changing call submitted through KeeperHub, with a KeeperHub execution ID and transaction link.

### KeeperHub surface usage

Vindex uses KeeperHub as the actual execution/reliability layer rather than as a badge. MCP/direct execution status becomes part of the product state machine and audit evidence.

### Reliability and observability

The system includes simulation, idempotency, stale-signal protection, unknown-execution handling, destination verification and an append-only audit record.

### Originality and usefulness

Vindex closes the alert-to-action gap: detection is not the end state; verified movement is.

### Integration quality

Protocol reads, policy decisions, execution and verification have explicit boundaries and provenance. The UI does not pretend client state is chain state.

---

## 28. Product Language Guardrails

Use:

- “supported position”;
- “protection drill”;
- “live Base Sepolia data”;
- “real testnet transaction”;
- “KeeperHub execution”;
- “verified safe-wallet result”;
- “high-sensitivity demo policy.”

Do not say:

- “Aave is being hacked” during the drill;
- “mainnet rescue” when running on Base Sepolia;
- “real USDC value rescued” when using testnet tokens;
- “MEV-protected” unless the exact KeeperHub execution path used can prove that property;
- “private routing” unless verified for this chain/path;
- “guaranteed rescue”;
- “funds are safe” before destination verification.

---

## 29. Definition of Done

Vindex V1 is complete only when all of the following are true in one end-to-end run:

```text
[REAL] Aave Base Sepolia USDC position exists
[REAL] Vindex reads that position from chain
[REAL] Vindex collects live signal observations
[REAL] Policy/consensus produces a recorded decision
[REAL] Withdrawal simulation succeeds
[REAL] KeeperHub submits the Aave withdrawal
[REAL] KeeperHub execution ID is captured
[REAL] Base Sepolia transaction hash is captured
[REAL] Transaction confirms onchain
[REAL] Safe-wallet balance delta is verified
[REAL] Rescue Receipt is generated from persisted evidence
[REAL] UI reaches PROTECTED only after verification
```

If any one of those is mocked, the canonical V1 is not done.

---

## 30. Post-Hackathon Expansion Path

Once this vertical slice is stable, the original seven-layer architecture expands naturally:

```text
one Aave position
→ multiple Aave assets
→ additional protocols
→ richer independent security feeds
→ mempool intelligence
→ real production thresholds
→ swap / raw-token fallback routing
→ private execution where verifiably supported
→ multi-chain protection
→ DAO / treasury policies
```

The hackathon build should not implement these early. Its job is to prove the protected route.

---

## 31. Official Source References

### KeeperHub

- Hackathon brief supplied by organizer/user: **The Last Mile**.
- Hackathon Quickstart: `https://docs.keeperhub.com/quickstart`
- MCP Server: `https://docs.keeperhub.com/ai-tools/mcp-server`
- Chains API: `https://docs.keeperhub.com/api/chains`
- Web3 Plugin: `https://docs.keeperhub.com/plugins/web3`
- Aave V3 Plugin: `https://docs.keeperhub.com/plugins/aave-v3`
- Gas Management: `https://docs.keeperhub.com/wallet-management/gas`

### Aave

- Official deployment overview: `https://aave.com/help/aave-101/accessing-aave`
- Official Aave address book — Base Sepolia: `https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3BaseSepolia.sol`

### Base

- Base Sepolia faucet information: `https://docs.base.org/base-chain/network-information/network-faucets`

---

# Final Product Decision

**Canonical hackathon implementation:**

> **Base Sepolia + Aave V3 + Aave Base Sepolia USDC test asset + KeeperHub execution wallet + separate safe wallet + live signal observations + transparent high-sensitivity protection drill + real simulation + real KeeperHub withdrawal + real destination verification + Rescue Receipt.**

This is the Vindex V1 that should be implemented before any broader architecture work.
