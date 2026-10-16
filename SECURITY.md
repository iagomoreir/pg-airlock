# Security policy

pg-airlock sits between an AI agent and a database, so security reports are taken seriously.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting
(Security tab → "Report a vulnerability") and include a minimal reproduction.

Particularly interesting:

- A statement that the classifier treats as a read (or blocks) but that changes data or ends the held transaction.
- Any way for the agent-facing MCP tools to commit, roll back, or otherwise resolve a change.
- Authentication, Host/Origin or token-handling flaws in the local approval API.

## Known limitations

The same-OS-user trust boundary, lock-holding behaviour and other documented limits are listed in the
README under "Known limitations". They are design constraints, not vulnerabilities, but improvements are welcome.
