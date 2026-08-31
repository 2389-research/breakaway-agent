// ABOUTME: Tests for secret redaction — proves common key/token formats become [REDACTED].
// ABOUTME: Redaction is the P0 guard that stops tool output leaking secrets to the model and transcript.

import { describe, test, expect } from 'bun:test';
import { redactSecrets } from '../src/redact.ts';

describe('redactSecrets — key formats', () => {
  test('redacts a LunaRoute lr_ key', () => {
    const out = redactSecrets('key is lr_abcdef0123456789ABCDEF here');
    expect(out).not.toContain('lr_abcdef0123456789ABCDEF');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts an sk- style key', () => {
    const out = redactSecrets('OPENAI_API_KEY sk-proj-abcdEFGH1234567890 zzz');
    expect(out).not.toContain('sk-proj-abcdEFGH1234567890');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts an AWS access key id', () => {
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED]');
  });

  test('redacts a Bearer token in a header string, keeping the scheme word', () => {
    // No sensitive key name precedes it here, so the standalone Bearer rule applies.
    const out = redactSecrets("curl -H 'Bearer abcdef0123456789ghijkl'");
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abcdef0123456789ghijkl');
  });

  test('fully redacts an Authorization header value', () => {
    const out = redactSecrets('Authorization: Bearer abcdef0123456789ghijkl');
    expect(out).not.toContain('abcdef0123456789ghijkl');
    expect(out).toContain('[REDACTED]');
  });
});

describe('redactSecrets — PEM private keys', () => {
  test('redacts a private key block', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAlaljfljlkj\nMORELINES==\n-----END OPENSSH PRIVATE KEY-----';
    const out = redactSecrets(`before\n${pem}\nafter`);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('b3BlbnNzaC1rZXk');
  });
});

describe('redactSecrets — env assignments', () => {
  test('redacts the value of a sensitive KEY=VALUE, keeping the key name', () => {
    const out = redactSecrets('OPENAI_COMPATIBLE_API_KEY=lr_livekey0123456789abcdef');
    expect(out).toContain('OPENAI_COMPATIBLE_API_KEY=');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('lr_livekey0123456789abcdef');
  });

  test('redacts a quoted SECRET value', () => {
    const out = redactSecrets('DB_SECRET="s3cr3t-value-goes-here"');
    expect(out).not.toContain('s3cr3t-value-goes-here');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts a PASSWORD assignment with colon syntax', () => {
    const out = redactSecrets('password: hunter2hunter2hunter2');
    expect(out).not.toContain('hunter2hunter2hunter2');
    expect(out).toContain('[REDACTED]');
  });
});

describe('redactSecrets — leaves ordinary text alone', () => {
  test('does not touch prose without secrets', () => {
    const text = 'The quick brown fox jumps over the lazy dog. Exit code 0.';
    expect(redactSecrets(text)).toBe(text);
  });

  test('does not redact a short non-secret assignment', () => {
    // COUNT is not a sensitive key name; value stays.
    const text = 'COUNT=42';
    expect(redactSecrets(text)).toBe(text);
  });
});
