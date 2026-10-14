# Private CloudBase persistence verification

This function is a temporary isolated test harness, not a customer endpoint. Do not add an HTTP route.

- Set `QA_PREFIX` to a unique `qa_lottery_` plus 12 lowercase hex digits. Never reuse it for a new run.
- Set `QA_AUTH_TOKEN` to a fresh 64-character lowercase hex secret. Store it only in private deployment inputs.
- Invoke with the authorized Tencent CLI and `{ "action": "run", "authorization": "<private secret>" }`.
- Invoke `readback` in a separate call using the same secret. The persisted digest must match the run result.
- The function rejects HTTP events and Mini Program user contexts. The run initialization marker forbids reruns/resetting.

Create these collections with server-only permissions before invoking, all prefixed with `QA_PREFIX` followed by `_`:

`control`, `entries`, `codes`, `pools`, `scarf_campaigns`, `scarf_inventory`, `scarf_entries`, `scarf_invites`, `scarf_codes`, `entitlements`, `auth_tickets`, `auth_codes`.

All access passes through a strict namespace allowlist, including native authentication helpers. No production collection name can pass that wrapper. There is no cleanup/delete operation in the function. Remove the temporary function and its named QA collections separately after retaining evidence; never run a broad prefix deletion.

Coverage: canonical original lottery pool transactions, duplicate concurrent draws, inventory bounds, scarf win/miss durability, concurrent invitation/last-stock use, server-side one-use login tickets and login-code claims, signed pagination and independent-invocation readback.

The scarf entitlement adapter uses isolated CloudBase documents. It is explicitly a simulator of the external coupon-center protocol. This harness does not claim to test a real WeChat user login, live prize inventory, the production cashier or the production SQLite coupon center. Actual coupon-center storage and full cashier redemption are covered separately by the temporary SQLite integration tests.

## Reusable source and local checks

This directory retains the reviewed QA implementation and its required vendored business modules. It includes no production environment files, deployment inputs, database exports, invocation results, or authentication secrets. Refresh vendored modules deliberately when canonical services change; this snapshot is not automatically synchronized.

Run `node --test harness.test.cjs` from this directory. The three local tests use an in-memory fixture and make no cloud requests. A passing local run does not prove a live Tencent deployment.

Cloud invocation must remain private and authorized by the environment administrator. Never deploy a public HTTP route for this harness, never use production business collections, and never embed QA_AUTH_TOKEN in source. The external coupon-center adapter remains an isolated simulator; real coupon-center verification is separate.
