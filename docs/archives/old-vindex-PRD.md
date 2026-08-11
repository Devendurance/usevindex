# Vindex: 48-Hour Hackathon PRD

## 1. Overview
Vindex is an autonomous DeFi protection agent designed to monitor a user's DeFi position, detect converging threat signals, confirm whether an exit is justified, orchestrate an evacuation through KeeperHub, and verify the safe-wallet destination balance. 

**Hackathon Goal:** Prove the core loop of threat detection, confirmation, KeeperHub execution, and verified exit on a narrow, single-path implementation to optimize for the KeeperHub hackathon judging criteria.

---

## 2. Scope & Constraints (48-Hour Hackathon)
To ensure a verifiable, functional demo within 48 hours, the scope is strictly limited to a single vertical slice:

*   **Chain:** Sepolia (Testnet) or Base Sepolia.
*   **Protocol:** 1 Supported DeFi Protocol (Mock DeFi Pool with real contract calls, or Aave V3 Testnet).
*   **Trigger Mechanism:** Multi-signal simulator (deterministic fixture triggering Oracle Skew + TVL Drop + Exploit Event simultaneously).
*   **Execution Path:** 1 KeeperHub execution path (Private/Simulated exit to Safe Wallet).
*   **Verification:** 1 Rescue Receipt audit trail verifying the safe wallet balance.

---

## 3. User Personas & Core Flows

### 3.1 User Personas
*   **The DeFi Yield Farmer:** An individual with meaningful capital in the supported protocol who cannot monitor their position 24/7. They need peace of mind that their funds will automatically evacuate to a pre-configured safe wallet during a flash-loan attack or rug pull.

### 3.2 Core User Flow
1.  **Setup:**
    *   User connects wallet and selects the supported DeFi position (e.g., Aave V3 Sepolia ETH pool).
    *   User inputs a **Safe Wallet** address (destination for evacuated funds).
    *   User sets a threat threshold (simulated for demo).
    *   Vindex runs a Dry Run to verify permissions.
2.  **Monitor:**
    *   Vindex enters the `WATCH` state, waiting for signals.
3.  **Trigger & Simulate (Consensus):**
    *   The Multi-Signal Simulator triggers an event (e.g., 7.2% Oracle Skew + 18.5% TVL Drop).
    *   Vindex shifts to `CONFIRM` state.
    *   Vindex simulates the exit path.
4.  **KeeperHub Execution:**
    *   Vindex submits the atomic exit transaction (Withdraw + Transfer) to KeeperHub.
    *   Vindex tracks the execution status via KeeperHub.
5.  **Safe Wallet Proof & Receipt:**
    *   Vindex verifies the balance of the Safe Wallet.
    *   Vindex generates the **Rescue Receipt** audit trail proving the trigger, action, and verified result.

---

## 4. Functional Requirements

### 4.1 Frontend (UI/UX)
*   **Tech Stack:** Next.js 16, React 19, Tailwind CSS v4.
*   **Design System:** Strict adherence to `DESIGN.md`. (Cream background `#F7F3EC`, Inter Tight / Inter typography, red/cyan glitch CTA frame for primary actions, blurred mesh for signal states).
*   **Views:**
    *   **Landing / Setup:** "DETECT THE THREAT. EXECUTE THE ESCAPE." Hero section, safe wallet configuration, "RUN A DRY RUN" CTA.
    *   **Dashboard (Monitoring):** Displays the single supported position and its threat state (`WATCHING`, `CONFIRMING`, `EVACUATING`, `PROTECTED`, `BLOCKED`).
    *   **Rescue Receipt View:** A structured visual component displaying the audit trail (Trigger, Action, Hash, Safe Wallet Verification).

### 4.2 Engine (Signal Ingestion & Consensus)
*   **Mock Threat Emitter:** A deterministic script/API that emits 3 converging threat signals on command (Oracle skew, TVL drop, exploit alert).
*   **Consensus Logic:** A lightweight orchestrator that only triggers the evacuation if at least 2 out of 3 signals fire within a set time window.
*   **Simulation Gate:** A pre-execution dry-run step to validate the withdrawal transaction won't revert.

### 4.3 Execution Layer (KeeperHub Integration)
*   **KeeperHub MCP/API:** Vindex must use KeeperHub to submit the transaction.
*   **Capabilities used:** Gas estimation, nonce management, and transaction status monitoring provided by KeeperHub.
*   **Action Payload:** Contract calls to withdraw from the Mock Pool/Aave and transfer tokens to the user's Safe Wallet.

### 4.4 Audit Trail (Post-Execution)
*   **Verification Script:** Reads the destination Safe Wallet balance on-chain to confirm funds arrived.
*   **Receipt Generation:** Creates an immutable-style log (Rescue Receipt) containing timestamps, signals, TX hash, and verified balance.

---

## 5. Non-Functional Requirements
*   **Latency:** The pipeline from "Consensus Reached" to "KeeperHub Submission" must be under 3 seconds.
*   **Security (Non-Custodial Boundaries):** Vindex must never hold user funds or private keys. KeeperHub (or wallet integration) manages the signing/execution orchestration on behalf of the user. Funds flow directly from the DeFi protocol to the Safe Wallet.
*   **Reliability:** The app must gracefully handle simulation failures (e.g., transition to a `BLOCKED` state with a clear diagnostic).

---

## 6. Success Criteria & Judging Alignment

This PRD is optimized for the **KeeperHub Hackathon**.

*   **KeeperHub Utilization:** Demonstrates KeeperHub handling the "difficult last mile" (gas, nonces, execution status) for a high-stakes transaction.
*   **Originality:** Moves beyond a standard dashboard into an active, autonomous protection agent combining detection + execution + MEV protection.
*   **Demo Strength:** The demo video will show a live threat simulation, multi-signal convergence, KeeperHub execution, and the final Rescue Receipt in under 2 minutes.
*   **Reliability & Observability:** The Rescue Receipt provides an insurance-grade audit trail, proving execution and safe-wallet arrival. 
