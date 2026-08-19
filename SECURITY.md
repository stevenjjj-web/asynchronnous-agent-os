# Security Policy and Trust Model

## Trust boundary

One Agent OS Gateway is a single trusted-operator security domain. Possession of its bearer token grants operator-level control. Session keys route context and replies; they are not authentication credentials and must not be used as hostile multi-tenant boundaries.

Mutually untrusted users or tenants require separate operating-system users, Gateway processes, configuration and state directories, databases, workspaces, credentials, plugin sets, and execution sandboxes.

## Production deployment requirements

- Run `agent-os security audit` before startup and after every configuration or plugin change.
- Gateway startup always fails closed on critical audit findings and prints every high-severity finding before binding. With `NODE_ENV=production`, high findings also block startup. In development they remain explicit operator decisions because the runtime cannot infer an acceptable domain, account, or tool allowlist.
- Keep `security.allowLocalBypass` and `security.allowRemoteWithoutAuth` disabled.
- Use a randomly generated Gateway token with at least 32 bytes of entropy. Send it only in the `Authorization: Bearer` header. Query-string authentication is not supported.
- Bind directly to loopback. For network access, terminate TLS at a hardened reverse proxy and restrict source networks. The built-in HTTP server does not terminate TLS.
- Keep the state home and workspaces at mode `0700`; keep configuration, secrets, SQLite files, PID files, and logs at mode `0600`. `agent-os security audit --fix` repairs supported POSIX permission drift.
- Treat plugins as trusted native code. Plugins execute inside the Gateway process. Use exact paths, private operator-owned files, explicit plugin ID allowlists, and fail-closed loading.
- Do not enable browser or code tools without an adapter that provides real process, container, or microVM isolation. An in-process wrapper is not a sandbox.
- Require signed external events with a separate `env:` secret reference for each source. Rotate source secrets independently.
- Keep model-provider `allowPrivateNetwork` disabled unless the endpoint is an operator-reviewed private service. Model and public-fetch connections pin validated DNS results and never follow redirects.
- Give each root Goal the smallest practical tool, filesystem, domain, account, data, credential, deadline, and budget capability set. Child Goals can only attenuate this authority.
- Require adapters for outbound channels to honor the stable outbox idempotency key. Side-effect tools must declare their idempotency and uncertainty semantics.
- Require AES-256-GCM encryption and trusted Ed25519 signatures for remote memory bundles. Keep imported memories as candidates until reviewed; authenticated encryption protects confidentiality and integrity, while a valid signature authenticates the publisher rather than the truth of a belief.
- Inject memory-provider tokens, signing private keys, and memory encryption keys only through environment or private secret-file references. Keep private-network provider access disabled unless the endpoint is operator-reviewed. Retain old decryption keys during rotation and change only `activeKeyId` for new exports.

## Hard boundaries

The runtime enforces bearer authentication, independent bounded read/write and authentication rate limits, frozen Goal capabilities, credential-reference injection, replay-protected source-bound event signatures, reserved kernel event topics, symlink-resistant workspace access, bounded network requests with connection-time DNS pinning and no redirects, private atomic state writes, plugin path validation, authenticated-encrypted and signed content-addressed memory bundles, non-recalled import candidates, durable operation records, transactionally coupled approval decisions and wake events, approval gates, and strong-sandbox declarations for browser and code pools.

Prompts, model instructions, bootstrap text, and external-content warnings are defense in depth. They are not authorization boundaries. External channel and network content is tagged as untrusted data, but capability checks remain authoritative even when a model follows malicious instructions.

## Known limits

- The repository does not ship a container or microVM sandbox backend.
- SQLite and the resident Gateway are single-node components. High availability, remote fencing, and multi-node task migration are not implemented.
- Gateway bearer authentication represents one operator and does not provide per-user RBAC or delegated identity.
- Environment and private-file secret providers are supported; managed KMS/HSM providers are not included.
- The audit log is durable but not cryptographically tamper-evident.
- A memory CAS stores immutable bundles but does not itself define a trusted mutable "latest" pointer, cross-device deletion propagation, or semantic conflict resolution.
- Automated backup/restore, signed releases, SBOM publication, long-duration soak testing, and OpenTelemetry export remain deployment work.

These limits mean the project can be hardened for a personal single-operator deployment, but it must not be advertised as a hostile multi-tenant or high-availability control plane.

## Reporting vulnerabilities

Do not include live credentials, private model transcripts, or personal workspace data in a report. Provide a minimal reproduction, affected version, impact, and suggested mitigation through the repository's private security-reporting channel. Rotate any credential that may have appeared in logs or test artifacts.
