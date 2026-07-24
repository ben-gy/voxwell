import { describe, expect, it } from 'vitest';
import { routesMonitoringToEarpiece } from '../src/platform';

// Real user-agent strings, trimmed to the identifying part.
const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const IPOD =
  'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

describe('routesMonitoringToEarpiece', () => {
  it('is true on iPhone — the reported case (iOS 18.7 Safari)', () => {
    expect(routesMonitoringToEarpiece(IPHONE_SAFARI)).toBe(true);
  });

  it('is true for any WebKit browser on iPhone, including Chrome (CriOS)', () => {
    expect(routesMonitoringToEarpiece(IPHONE_CHROME)).toBe(true);
  });

  it('is true on iPod touch', () => {
    expect(routesMonitoringToEarpiece(IPOD)).toBe(true);
  });

  it('is false on iPad — it routes live audio to the speaker', () => {
    expect(routesMonitoringToEarpiece(IPAD)).toBe(false);
  });

  it('is false on desktop Safari and Android', () => {
    expect(routesMonitoringToEarpiece(MAC)).toBe(false);
    expect(routesMonitoringToEarpiece(ANDROID)).toBe(false);
  });
});
