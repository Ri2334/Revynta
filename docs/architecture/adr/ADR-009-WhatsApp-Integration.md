# ADR-009: WhatsApp as the First Revynta Communication Channel

## Status
Proposed

## Context
Revynta requires a highly effective, direct shopper communication channel to deliver recovery campaigns (such as browse abandonment recovery). WhatsApp is selected as the initial communication channel because:
- It yields high read rates ($>90\%$) and click-through rates ($>20\%$) compared to traditional email marketing.
- It operates natively on mobile numbers which map naturally to the resolved customer identities in our shopper identity graph.
- Meta's official WhatsApp Business Cloud API provides a direct HTTP interface with webhooks for delivery status tracking (sent, delivered, read, failed).

We require a messaging infrastructure that abstracts channel-specific APIs so future communication systems (SMS, Email, Twilio, etc.) can be supported without rewriting the core campaign engine.

## Decisions
1. **WhatsApp Provider Abstraction**:
   - Introduce a provider-independent `WhatsAppProvider` interface.
   - Implement `MetaWhatsAppProvider` as the official channel, and `MockWhatsAppProvider` for tests and local development.
2. **Encrypted Secret Storage**:
   - Access tokens and App Secrets will be encrypted at rest in the `integrations.configuration` JSONB field using AES-256-GCM. Decryption keys are loaded securely from environment variables.
3. **Opt-out Management**:
   - Detect inbound keywords (`STOP`, `UNSUBSCRIBE`, `CANCEL`) via inbound webhooks.
   - Automatically revoke marketing consent by updating the `consent_records` table and creating an auditable audit log entry.
4. **Idempotency & Status Regression Guard**:
   - Webhook processing guards status transitions (e.g. read status cannot regress back to delivered) using status ranks: `pending = 0, sent = 1, delivered = 2, read = 3, failed = 4`.
   - Prevent duplicate sends by checking both the local PostgreSQL `message_logs` state and the `idempotency_key` constraint.

## Alternatives Considered
- **Twilio SMS**: Rejected as SMS has lower engagement rates and higher delivery fees in various multi-tenant geographies.
- **Direct Webhook in inactivity worker**: Rejected to preserve separation of concerns. Inactivity worker generates campaign eligible events; WhatsApp dispatcher consumer handles actual message delivery.

## Security & Scalability
- **Webhook Authenticity**: Meta webhook requests are validated using HMAC-SHA256 signature verification computed over the raw request payload.
- **Tenant Isolation**: Database operations enforce Row Level Security (RLS) contexts (`withStoreContext`). Webhook contexts are resolved dynamically bypassing RLS only for matching `phoneNumberId` lookup via admin context.
