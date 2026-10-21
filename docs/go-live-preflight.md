# FactoryRunner #585 — offline_preflight (no go-live)

This is a reversible, build-ahead evidence inventory approved in owner decision
[#431 option A](https://github.com/pl0n3r/FactoryRunner/issues/431).
It DOES NOT install or start a service, connect to ControlBot real, obtain
credentials, invoke external providers, perform deployments or enable traffic.

The pure function `evaluateOfflinePreflight` accepts an explicit source SHA and
six caller-supplied proof statuses: `branch_protection`, `ci_exact_main`,
`codeql_exact_main`, `controlbot_mock`, `rollback_fake`, and
`observer_synthetic`. It rejects unknown fields, duplicate gate IDs, mismatched
SHA, accessors and non-enumerable evidence. Missing, failed and UNKNOWN items
make `prepared_offline=false`. A fully supplied and passing set yields ONLY
`prepared_offline=true`: **these are caller assertions, not independently
verified provenance or a security attestation**. The output always includes
`mode=offline_preflight`, `live_authorized=false`, and `readiness=UNKNOWN`.
The latest local observer is `synthetic_only` and cannot prove an actual runner.

## Prerequisites for an eventual separate live decision

- ControlBot real endpoint must have independently authenticated health and
  compatible protocol, not the existing mock; no connector is called here.
- Legal/ privacy approval (`privacy`) and separate human approval are required
  before processing any personal information, tokens or actual sessions.
- Actual Hostinger hosting constraints, permission boundaries, network exposure
  and credential provisioning must be documented and approved out of band.
- A versioned backup with independently verified **restore** procedure and
  tested **rollback** must exist for real runtime and data; in-memory fakes
  do not replace either verification.
- Authoritative kill switch, operational observability, exact version and SHA,
  readiness and smoke must be proven on a real deployment before traffic.

## Reproduce offline acceptance

`node --experimental-strip-types --test tests/go-live-preflight.test.ts`

`python3 -m unittest tests.test_go_live_preflight_contract`

`npm run typecheck` and `npm test` remain part of the repository CI.

This task modifies no deployment workflow, credentials, data, production host,
remote browser, ControlBot service or AutoFactory. To revert, revert this PR's
squash commit, then run the same tests and CI exact-main. Even a green preflight
**never** turns a human option A into a go-live authorization.
