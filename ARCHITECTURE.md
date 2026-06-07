# 🏛️ Sweepstakes Casino - Enterprise Architecture Blueprint

## 📌 Project Overview
This document outlines the macro-architecture for a High-Frequency US Social Sweepstakes Casino. The system is explicitly designed around a **Zero-Trust, Microservices/Event-Driven paradigm**, separating financial state from business logic and user interfaces.

The architecture is divided into three completely decoupled zones:
1.  **The Core Ledger (True Engine - Golang)**: The absolute source of truth for all money.
2.  **The Gateway & Cashier (Node.js/Next.js Backend)**: The security perimeter and business logic orchestrator.
3.  **The Frontend (Next.js App Router)**: The "Dumb" UI presentation layer.

---

## 🏗️ Zone 1: The Core Ledger ("True Engine")
**Status: COMPLETED & SEALED.** *(AI INSTRUCTION: Do NOT attempt to modify, calculate balances, or write SQL queries bypassing this engine).*

* **Tech Stack:** Go (Golang), PostgreSQL, Redis.
* **Role:** An ACID-compliant, Double-Entry Bookkeeping Ledger. 
* **Mechanics:**
    * Maintains strict separation between `GC` (Gold Coins), `SC_Unplayed`, and `SC_Redeemable`.
    * Uses Pessimistic Locking (`SELECT ... FOR UPDATE`) to prevent race conditions during high-speed slots spinning.
    * Enforces mathematical precision by storing all values as integers (Cents/Micro-cents). No Floating Point Math allowed.
    * Implements a Redis-backed Idempotency layer to prevent double-spending from duplicated webhook retries.
* **Security:** Only accepts HTTP requests that include an `X-Signature` header containing a valid HMAC-SHA256 hash matching the `ENGINE_SECRET_KEY`.

---

## 🛡️ Zone 2: The Gateway & Cashier (Adapter Layer)
**Status: CURRENT FOCUS.** *(AI INSTRUCTION: This is the environment you are currently building).*

* **Tech Stack:** Node.js, Express/Next.js API Routes, Prisma/Drizzle (for non-financial data), MongoDB/PostgreSQL.
* **Rule #1 (Zero Financial State):** The database for this layer holds User Profiles, KYC status, VIP levels, and Auth Credentials. **It MUST NOT contain `gc_balance` or `sc_balance`.** * **Rule #2 (HMAC Broker):** Every financial action generated here (Bet, Win, Deposit) must be hashed via HMAC-SHA256 and forwarded to the True Engine.
* **Components to Build:**
    1.  **Auth Service:** Registers users and assigns a UUID (`user_id`). The Go Engine only cares about this ID.
    2.  **Cashier Service:** Interfaces with payment providers (e.g., Stripe). Upon a successful fiat purchase, it instructs the True Engine to execute a `/deposit` of GC and SC.
    3.  **B2B Game Adapter:** Acts as a webhook receiver for external Game Aggregators (e.g., Pragmatic Play). It translates their proprietary payload formats into the strict DTO format required by the True Engine, signs it, and forwards it.

---

## 💻 Zone 3: The Showroom (Frontend Layer)
**Status: PENDING / IN PROGRESS.**

* **Tech Stack:** Next.js 15 (App Router), React 19, Tailwind CSS, Zustand (Global State).
* **Role:** UI presentation, game iframe hosting, and real-time balance display.
* **Mechanics:**
    * It does NOT calculate winnings or losses locally.
    * **Real-Time Sync:** It connects to a Server-Sent Events (SSE) or WebSocket endpoint. When the True Engine confirms a bet/win, it pushes the updated integer balances to the frontend, which visually updates the top-nav balance counters seamlessly.

---

## 🚀 The AI Execution Contract (.cursorrules)
Whenever interacting with this codebase, the AI must strictly adhere to the following:

1.  **No Financial Mocks:** Do not create dummy `balance` fields in User schemas "just to make it work".
2.  **Idempotency First:** Every call to the True Engine must be accompanied by a newly generated UUIDv4 `transaction_id`.
3.  **Graceful Failures:** Anticipate Go Engine HTTP 400 (Insufficient Funds) or HTTP 401 (Unauthorized HMAC) errors and pipe them cleanly to the frontend without crashing the Node.js process.
4.  **Integers Only:** If mapping DTOs, ensure all monetary values are cast to integers before sending to the Core Ledger.