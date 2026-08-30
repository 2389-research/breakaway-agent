// ABOUTME: Tests for defaultTranscriptDir — embedded vs source mode dir resolution.
// ABOUTME: Pure function test; no filesystem or compile step needed.

import { describe, test, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultTranscriptDir } from '../src/transcript.ts';

describe('defaultTranscriptDir', () => {
  test('env var wins in source mode', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    process.env.BREAK_AWAY_TRANSCRIPT_DIR = '/custom/path';
    try {
      expect(defaultTranscriptDir('/some/source/dir')).toBe('/custom/path');
    } finally {
      if (orig === undefined) delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
      else process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('env var wins in embedded mode', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    process.env.BREAK_AWAY_TRANSCRIPT_DIR = '/custom/path';
    try {
      expect(defaultTranscriptDir('/$bunfs/root')).toBe('/custom/path');
    } finally {
      if (orig === undefined) delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
      else process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('embedded mode without env var returns ~/.break-away/transcripts', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    try {
      const result = defaultTranscriptDir('/$bunfs/root');
      expect(result).toBe(join(homedir(), '.break-away', 'transcripts'));
    } finally {
      if (orig !== undefined) process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('embedded mode with different bunfs subpath still returns home dir', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    try {
      const result = defaultTranscriptDir('/$bunfs/other');
      expect(result).toBe(join(homedir(), '.break-away', 'transcripts'));
    } finally {
      if (orig !== undefined) process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });

  test('source mode without env var returns sibling .transcripts dir', () => {
    const orig = process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    delete process.env.BREAK_AWAY_TRANSCRIPT_DIR;
    try {
      const sourceDir = '/home/user/break-away/src';
      const result = defaultTranscriptDir(sourceDir);
      expect(result).toBe(resolve(sourceDir, '../.transcripts'));
    } finally {
      if (orig !== undefined) process.env.BREAK_AWAY_TRANSCRIPT_DIR = orig;
    }
  });
});
