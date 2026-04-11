---
status: partial
phase: 01-security-hardening
source: [01-VERIFICATION.md]
started: 2026-04-10T00:00:00Z
updated: 2026-04-10T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Staging Startup Refusal
expected: Deploy without `ENABLE_AUTH=true` set and confirm the fatal error fires and server refuses to start.
result: [pending]

### 2. Database Ciphertext Confirmation
expected: After running the migration script, `SELECT "aiFallbackApiKey" FROM "ChatbotConfig"` on the production/staging DB returns AES-256-GCM ciphertext (base64 format), not a plaintext API key.
result: [pending]

### 3. CORS on Live Deployment
expected: `curl -H "Origin: https://evil.com" https://<your-api>` returns a CORS rejection (no `Access-Control-Allow-Origin` header for disallowed origin).
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
