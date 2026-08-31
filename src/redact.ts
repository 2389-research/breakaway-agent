// ABOUTME: Redacts secret-looking substrings from tool output before it reaches the model or transcript.
// ABOUTME: Single chokepoint applied in agent.ts; covers PEM keys, provider keys, bearer tokens, and sensitive env assignments.

const PLACEHOLDER = '[REDACTED]';

// PEM private key blocks (any BEGIN/END PRIVATE KEY variant), matched across newlines.
const PEM = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;

// Provider API keys: LunaRoute (lr_…), OpenAI/Stripe/etc. (sk-…, rk-…, pk-…).
const PROVIDER_KEY = /\b(?:lr_[A-Za-z0-9]{16,}|(?:sk|rk|pk)-[A-Za-z0-9_-]{16,})\b/g;

// Bearer tokens in Authorization headers — keep the scheme word, drop the token.
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

// AWS access key ids.
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

// Sensitive KEY=VALUE / KEY: VALUE assignments — keep the key name, redact the value.
// The key name must contain a secret-ish word; the value must be at least 6 chars.
const SENSITIVE_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|APIKEY)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?:"[^"]{6,}"|'[^']{6,}'|[^\s"']{6,})/gi;

export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(PEM, PLACEHOLDER)
    .replace(PROVIDER_KEY, PLACEHOLDER)
    .replace(BEARER, `Bearer ${PLACEHOLDER}`)
    .replace(AWS_KEY, PLACEHOLDER)
    .replace(SENSITIVE_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}${PLACEHOLDER}`);
}
