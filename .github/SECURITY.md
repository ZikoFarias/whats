# Security Policy — WA-AKG

## Supported Versions

| Version | Status          |
|---------|-----------------|
| 1.6.x   | ✅ Supported    |
| < 1.6   | ❌ Unsupported  |

## Reporting a Vulnerability

**DO NOT open a public issue for vulnerabilities.**

Report via:

1. **GitHub Security Advisory** — Go to **Security** > **Report a vulnerability** in this repo (recommended)
2. **Email** — Send details to the email listed on the maintainer's GitHub profile

## Response Timeline

| Stage            | Target       |
|------------------|--------------|
| Acknowledgment   | < 48 hours   |
| Investigation    | < 3 days     |
| Patch released   | < 7 days     |
| Disclosure       | After patch is released & users have updated |

## Scope

- Vulnerabilities in WA-AKG code (Next.js, Baileys integration, API)
- Dependencies with critical CVEs
- Credential leaks or exposure

## Out of Scope

- Vulnerabilities in upstream dependencies (can still be reported, low priority)
- Social engineering / phishing
- DOS caused by user configuration
