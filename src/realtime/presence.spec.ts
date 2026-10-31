import { PresenceRegistry } from './presence.js';

describe('PresenceRegistry', () => {
  it('is online from the first socket to the last', () => {
    const p = new PresenceRegistry();
    expect(p.add('m1', 't1', 'a')).toBe(true);
    expect(p.add('m1', 't1', 'b')).toBe(false);
    expect(p.remove('m1', 'a')).toBe(false);
    expect(p.isOnline('m1')).toBe(true);
    expect(p.remove('m1', 'b')).toBe(true);
    expect(p.isOnline('m1')).toBe(false);
  });

  it('ignores sockets it never saw', () => {
    const p = new PresenceRegistry();
    p.add('m1', 't1', 'a');
    expect(p.remove('m1', 'zzz')).toBe(false);
    expect(p.remove('m2', 'a')).toBe(false);
    expect(p.isOnline('m1')).toBe(true);
  });

  it('answers only for members of the asking center', () => {
    const p = new PresenceRegistry();
    p.add('m1', 't1', 'a');
    p.add('m2', 't2', 'b');
    expect(p.online(['m1', 'm2', 'm3'], 't1')).toEqual(['m1']);
  });
});
