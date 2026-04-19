---
status: partial
phase: 02-crm-identity-data-integrity
source: [02-VERIFICATION.md]
started: 2026-04-19T17:24:52Z
updated: 2026-04-19T17:24:52Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. CRM list shows no raw JIDs
expected: All contacts in the CRM list display formatted phone numbers (e.g., +55 11 99999-9999) or "Aguardando número" for unresolved LID contacts — no @lid strings, @s.whatsapp.net suffixes, or raw JID digits visible in any rendered text node
result: [pending]

### 2. Send to LID contact delivers
expected: Sending a message from the CRM to a LID-affected contact (one whose phoneNumber is null) successfully delivers the message via the rawJid path — no silent failure, no error toast
result: [pending]

### 3. Tags filter end-to-end
expected: Assigning tags to a conversation and then filtering the CRM contact list by those tags returns only the matching contacts
result: [pending]

### 4. Cross-session message history
expected: A contact who has had multiple conversations across sessions shows all historical messages (up to 500) in the detail panel without gaps or missing earlier messages
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
