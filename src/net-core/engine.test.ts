import { describe, expect, it } from 'vitest';
import { M24, simulate } from './engine';
import type { Device, SimEvent, Topology } from './types';

const host = (o: Partial<Device> & { id: string; name: string }): Device => ({
  type: 'laptop', role: 'client', mask: M24, vlan: 1, power: true, arpStatic: {}, ...o,
});

/** Two PCs on one switch. */
function oneSwitch(): Topology {
  return {
    vlans: false, hsrp: false, tls: false,
    devices: {
      pcA: host({ id: 'pcA', name: 'PC-A', ip: '192.168.1.10', gw: '192.168.1.1', mac: 'aa:00:00:00:00:0a', uplink: 'sw1' }),
      pcB: host({ id: 'pcB', name: 'PC-B', ip: '192.168.1.20', gw: '192.168.1.1', mac: 'aa:00:00:00:00:0b', uplink: 'sw1' }),
      sw1: { id: 'sw1', type: 'switch', name: 'SW1', power: true, macStatic: {} },
    },
  };
}

/** Two subnets joined by one router. Set `nat` to make Gi0/1 the public side. */
function oneRouter(nat = false): Topology {
  return {
    vlans: false, hsrp: false, tls: false,
    devices: {
      pc: host({ id: 'pc', name: 'PC', ip: '192.168.1.10', gw: '192.168.1.1', mac: 'aa:00:00:00:00:10', uplink: 'sw1' }),
      sw1: { id: 'sw1', type: 'switch', name: 'SW1', power: true, macStatic: {} },
      r1: {
        id: 'r1', type: 'router', name: 'R1', power: true, priority: 100, arpStatic: {},
        ifaces: [
          { name: 'Gi0/0', mac: 'bb:00:00:00:00:01', peer: 'sw1', vlan: 1, addrs: [{ ip: '192.168.1.1', mask: M24 }], hsrp: [] },
          { name: 'Gi0/1', mac: 'bb:00:00:00:00:02', peer: 'srv', vlan: 1, addrs: [{ ip: '203.0.113.1', mask: M24 }], hsrp: [] },
        ],
        routes: [
          { net: '192.168.1.0', mask: M24, iface: 'Gi0/0', via: '', type: 'C' },
          { net: '203.0.113.0', mask: M24, iface: 'Gi0/1', via: '', type: 'C' },
        ],
        ...(nat ? { nat: { inside: 'Gi0/0', outside: 'Gi0/1', publicIp: '203.0.113.1' } } : {}),
      },
      srv: host({ id: 'srv', type: 'server', role: 'web', name: 'SRV', ip: '203.0.113.50', gw: '203.0.113.1', mac: 'cc:00:00:00:00:50', uplink: 'r1' }),
    },
  };
}

const field = (e: SimEvent, key: string) => e.flat[key];
const echoes = (events: SimEvent[], type: string) => events.filter((e) => e.proto === 'ICMP' && field(e, 'icmp.type') === type);

describe('ping across one switch', () => {
  const sim = simulate(oneSwitch(), { type: 'ping', src: 'pcA', dst: '192.168.1.20' });

  it('succeeds', () => {
    expect(sim.ok).toBe(true);
    expect(sim.failure).toBeNull();
  });

  it('floods the ARP request, then forwards the reply out one port', () => {
    const arp = sim.events.filter((e) => e.proto === 'ARP');
    expect(arp[0].dst).toBe('Broadcast');
    expect(arp.some((e) => e.note.includes('records aa:00:00:00:00:0a'))).toBe(true);
    const lastEcho = echoes(sim.events, '0 · Echo reply').at(-1)!;
    expect(lastEcho.at).toBe('pcA');
    expect(lastEcho.note).toContain('forwards out that one port');
  });

  it('keeps TTL at 64 because no router is on the path', () => {
    for (const e of echoes(sim.events, '8 · Echo request')) expect(field(e, 'l3.ttl')).toBe('64');
  });

  it('learns both MACs in the switch table', () => {
    expect(Object.keys(sim.final.mac.sw1).sort()).toEqual(['1|aa:00:00:00:00:0a', '1|aa:00:00:00:00:0b']);
  });
});

describe('ping across one router with an ARP miss', () => {
  const sim = simulate(oneRouter(), { type: 'ping', src: 'pc', dst: '203.0.113.50' });

  it('succeeds', () => {
    expect(sim.ok).toBe(true);
  });

  it('starts with an ARP for the gateway because the cache is empty', () => {
    const first = sim.events.find((e) => e.proto !== 'DROP')!;
    expect(first.proto).toBe('ARP');
    expect(field(first, 'arp.tip')).toBe('192.168.1.1');
  });

  it('makes the router ARP for the server before it can forward', () => {
    const routerArp = sim.events.find((e) => e.proto === 'ARP' && field(e, 'arp.sip') === '203.0.113.1' && field(e, 'arp.op') === '1 · request');
    expect(routerArp).toBeDefined();
    expect(field(routerArp!, 'arp.tip')).toBe('203.0.113.50');
  });

  it('decrements TTL at the router and rewrites the frame, keeping the IP addresses', () => {
    const req = echoes(sim.events, '8 · Echo request');
    const atServer = req.find((e) => e.at === 'srv')!;
    expect(field(atServer, 'l3.ttl')).toBe('63');
    expect(field(atServer, 'l3.src')).toBe('192.168.1.10');
    expect(field(atServer, 'l2.src')).toBe('bb:00:00:00:00:02');
    expect(atServer.changed.map((c) => c.key)).toEqual(expect.arrayContaining(['l2.src', 'l2.dst', 'l3.ttl']));
  });

  it('caches the gateway MAC on the PC', () => {
    expect(sim.final.arp.pc['192.168.1.1'].mac).toBe('bb:00:00:00:00:01');
  });
});

describe('PC to a public IP through NAT', () => {
  const sim = simulate(oneRouter(true), { type: 'ping', src: 'pc', dst: '203.0.113.50' });
  const req = echoes(sim.events, '8 · Echo request');
  const rep = echoes(sim.events, '0 · Echo reply');

  it('succeeds and the reply comes back to the PC', () => {
    expect(sim.ok).toBe(true);
    expect(rep.at(-1)!.at).toBe('pc');
  });

  it('rewrites the private source to the router public address on the way out', () => {
    expect(field(req[0], 'l3.src')).toBe('192.168.1.10');
    const outside = req.find((e) => e.at === 'srv')!;
    expect(field(outside, 'l3.src')).toBe('203.0.113.1');
    expect(outside.changed.find((c) => c.key === 'l3.src')).toEqual({ key: 'l3.src', from: '192.168.1.10', to: '203.0.113.1' });
    expect(req.some((e) => e.nat?.direction === 'out')).toBe(true);
  });

  it('the server replies to the public address, and NAT translates it back', () => {
    expect(field(rep[0], 'l3.dst')).toBe('203.0.113.1');
    const inside = rep.at(-1)!;
    expect(field(inside, 'l3.dst')).toBe('192.168.1.10');
    expect(rep.some((e) => e.nat?.direction === 'in' && e.nat.to === '192.168.1.10')).toBe(true);
  });

  it('never shows the private address to the server', () => {
    const seenBySrv = sim.events.filter((e) => e.at === 'srv' && e.flat['l3.src']);
    for (const e of seenBySrv) expect(field(e, 'l3.src')).not.toBe('192.168.1.10');
  });

  it('explains the translation in the hop narrative', () => {
    expect(sim.events.some((e) => e.note.includes('NAT rewrites the private source 192.168.1.10'))).toBe(true);
  });
});

describe('router to router link (home router to ISP)', () => {
  it('follows a default route to the next router, which answers for its own address', () => {
    const t = oneRouter(true);
    const r1 = t.devices.r1;
    r1.ifaces![1] = { name: 'Gi0/1', mac: 'bb:00:00:00:00:02', peer: 'isp', vlan: 1, addrs: [{ ip: '100.64.0.2', mask: M24 }], hsrp: [] };
    r1.routes = [
      { net: '192.168.1.0', mask: M24, iface: 'Gi0/0', via: '', type: 'C' },
      { net: '100.64.0.0', mask: M24, iface: 'Gi0/1', via: '', type: 'C' },
      { net: '0.0.0.0', mask: '0.0.0.0', iface: 'Gi0/1', via: '100.64.0.1', type: 'S' },
    ];
    r1.nat = { inside: 'Gi0/0', outside: 'Gi0/1', publicIp: '100.64.0.2' };
    delete t.devices.srv;
    t.devices.isp = {
      id: 'isp', type: 'router', name: 'ISP', power: true, priority: 100, arpStatic: {},
      ifaces: [{ name: 'Edge', mac: 'dd:00:00:00:00:01', peer: 'r1', vlan: 1, addrs: [{ ip: '100.64.0.1', mask: M24 }, { ip: '8.8.8.8', mask: '255.255.255.255' }], hsrp: [] }],
      routes: [{ net: '100.64.0.0', mask: M24, iface: 'Edge', via: '', type: 'C' }],
    };
    const sim = simulate(t, { type: 'ping', src: 'pc', dst: '8.8.8.8' });
    expect(sim.ok).toBe(true);
    const routerArp = sim.events.find((e) => e.proto === 'ARP' && e.flat['arp.sip'] === '100.64.0.2');
    expect(routerArp?.flat['arp.tip']).toBe('100.64.0.1');
    expect(echoes(sim.events, '0 · Echo reply').at(-1)!.at).toBe('pc');
  });
});
