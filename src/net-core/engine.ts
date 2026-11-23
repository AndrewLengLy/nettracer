/**
 * NetTracer net-core: the network engine behind nettracer.andrewlengly.com and NetTracer XR.
 *
 * Pure functions with no React, DOM or Three.js imports.
 * topology + flow  ->  frame-by-frame event list.
 * Every frame is computed from live device config (IP, mask, gateway,
 * VLAN, ARP cache, MAC table, routing table, HSRP, NAT, power).
 */
import type {
  Analysis, ArpEntry, Device, Field, Fix, Flow, HsrpGroup, Issue, Lab, Layer, MacEntry, Route, SimEvent, SimResult, SimStep, Topology,
} from './types';

/** One attachment point on a broadcast domain: a host NIC or a router interface. */
export interface Nic {
  id: string;
  dev: string;
  iface?: string;
  kind: 'host' | 'rif';
  mac: string;
  vlan: number;
  sw: string | null;
  peer: string | null;
  addrs: { ip: string; mask: string; mac: string; virtual?: boolean; group?: number }[];
  vmacs: string[];
  hsrp: HsrpGroup[];
  prio?: number;
  roles: Record<string, string>;
  domain: string;
}

export const BCAST = 'ff:ff:ff:ff:ff:ff';
export const ZERO_MAC = '00:00:00:00:00:00';
export const M24 = '255.255.255.0';

export const PROTO_COLOR = {
  ARP: '#06B6D4',
  ICMP: '#14B8A6',
  DNS: '#F59E0B',
  TCP: '#3B82F6',
  HTTP: '#10B981',
  TLS: '#34D399',
  HSRP: '#6366F1',
  DROP: '#F43F5E',
};
export const LEGEND = ['ARP', 'DNS', 'TCP', 'HTTP', 'ICMP', 'TLS', 'HSRP', 'DROP'];
export const OSI_NAMES = ['Physical', 'Data Link', 'Network', 'Transport', 'Session', 'Presentation', 'Application'];

export const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

/* ---------- IPv4 helpers ---------- */
export const ipInt = (ip: unknown): number | null => {
  const p = String(ip ?? '').trim().split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
};
export const intIp = (n: number): string => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const isIp = (ip: unknown): boolean => ipInt(ip) !== null;
export const isMask = (m: unknown): boolean => {
  const n = ipInt(m);
  if (n === null) return false;
  const inv = ~n >>> 0;
  return ((inv + 1) & inv) === 0;
};
export const cidr = (m: unknown): number => {
  let n = ipInt(m) || 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
};
export const netOf = (ip: unknown, mask: unknown): string => intIp(((ipInt(ip) ?? 0) & (ipInt(mask) ?? 0)) >>> 0);
export const sameNet = (a: unknown, b: unknown, mask: unknown): boolean =>
  isIp(a) && isIp(b) && isMask(mask) && (((ipInt(a) as number) & (ipInt(mask) as number)) >>> 0) === (((ipInt(b) as number) & (ipInt(mask) as number)) >>> 0);
export const hostPart = (ip: unknown): number => Number(String(ip).split('.')[3] || 0);
export const withHost = (ip: unknown, h: number | string): string => String(ip).split('.').slice(0, 3).concat(String(h)).join('.');
export const hx16 = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return '0x' + (h & 0xffff).toString(16).padStart(4, '0');
};

/* ---------- device predicates ---------- */
export const isHost = (d: Device | null | undefined): boolean => !!d && (d.type === 'laptop' || d.type === 'server');
export const isSwitch = (d: Device | null | undefined): boolean => !!d && d.type === 'switch';
export const isRouter = (d: Device | null | undefined): boolean => !!d && d.type === 'router';
export const powered = (d: Device | null | undefined): boolean => !!d && d.power !== false;

/* ---------- base lab topology (positions are stage-local u,v) ---------- */
export function baseTopology(): Topology {
  const host = (o: Partial<Device> & { id: string; type: Device['type']; name: string }): Device => ({ mask: M24, vlan: 1, power: true, arpStatic: {}, ...o });
  return {
    vlans: false,
    hsrp: false,
    tls: false,
    devices: {
      pcA: host({ id: 'pcA', type: 'laptop', role: 'client', name: 'PC-A', label: 'Client', ip: '192.168.1.10', gw: '192.168.1.1', dns: '8.8.8.8', mac: '3c:22:fb:1a:00:10', uplink: 'sw1', pos: [-11.2, 5.0] }),
      pcB: host({ id: 'pcB', type: 'laptop', role: 'client', name: 'PC-B', label: 'Workstation', ip: '192.168.1.20', gw: '192.168.1.1', dns: '8.8.8.8', mac: '3c:22:fb:1a:00:20', uplink: 'sw1', pos: [-12.4, 0.3] }),
      pcC: host({ id: 'pcC', type: 'laptop', role: 'client', name: 'PC-C', label: 'Workstation', ip: '192.168.1.30', gw: '192.168.1.1', dns: '8.8.8.8', mac: '3c:22:fb:1a:00:30', uplink: 'sw1', pos: [-11.2, -4.6] }),
      sw1: { id: 'sw1', type: 'switch', name: 'SW1', label: 'L2 Switch', power: true, macStatic: {}, pos: [-6.1, 0] },
      r1: {
        id: 'r1', type: 'router', name: 'R1', label: 'Core Router', power: true, priority: 110, arpStatic: {}, pos: [-0.5, 0],
        ifaces: [
          { name: 'Gi0/0', mac: '00:1e:7a:c1:00:01', peer: 'sw1', vlan: 1, addrs: [{ ip: '192.168.1.1', mask: M24 }], hsrp: [] },
          { name: 'Gi0/1', mac: '00:1e:7a:c1:00:02', peer: 'sw2', vlan: 1, addrs: [{ ip: '203.0.113.1', mask: M24 }, { ip: '8.8.8.1', mask: M24 }], hsrp: [] },
        ],
        routes: [
          { net: '192.168.1.0', mask: M24, iface: 'Gi0/0', via: '', type: 'C' },
          { net: '203.0.113.0', mask: M24, iface: 'Gi0/1', via: '', type: 'C' },
          { net: '8.8.8.0', mask: M24, iface: 'Gi0/1', via: '', type: 'C' },
        ],
      },
      sw2: { id: 'sw2', type: 'switch', name: 'SW2', label: 'Edge Switch', power: true, macStatic: {}, pos: [4.7, 0] },
      dns: host({ id: 'dns', type: 'server', role: 'dns', name: 'DNS', label: 'DNS Resolver', ip: '8.8.8.8', gw: '8.8.8.1', mac: '52:54:00:08:08:08', uplink: 'sw2', records: { 'nettracer.lab': '203.0.113.10', 'andrewlengly.com': '203.0.113.10' }, pos: [10.2, -4.0] }),
      web: host({ id: 'web', type: 'server', role: 'web', name: 'WEB', label: 'Web Server', ip: '203.0.113.10', gw: '203.0.113.1', mac: '52:54:00:cb:00:0a', uplink: 'sw2', pos: [10.2, 4.0] }),
    },
  };
}

/* ---------- labs ---------- */
export const CATS = [
  { id: 'all', label: 'ALL' },
  { id: 'l2', label: 'L2 SWITCHING' },
  { id: 'l3', label: 'L3 ROUTING' },
  { id: 'web', label: 'WEB STACK' },
  { id: 'ts', label: 'TROUBLESHOOTING' },
];

export const LABS: Lab[] = [
  { id: 'arp', num: '01', cat: 'l2', title: 'ARP & Switch Flooding', focus: 'vlan',
    blurb: 'PC-A pings PC-B on the same subnet. SW1 floods the ARP broadcast, learns MAC addresses, then forwards unicast out one port.',
    flow: { type: 'ping', src: 'pcA', dst: '192.168.1.20' } },
  { id: 'route', num: '02', cat: 'l3', title: 'IP Routing & MAC Rewrite', focus: 'hsrp',
    blurb: 'PC-A pings the web server across R1. The Ethernet frame is rebuilt at the router. The IP header travels end to end.',
    flow: { type: 'ping', src: 'pcA', dst: '203.0.113.10' } },
  { id: 'web', num: '03', cat: 'web', title: 'HTTP + DNS + TCP Full Flow', focus: 'tls',
    blurb: 'Load http://nettracer.lab from PC-A. DNS lookup, TCP handshake, HTTP request and response, frame by frame.',
    flow: { type: 'web', src: 'pcA', name: 'nettracer.lab' } },
  { id: 'gw', num: '04', cat: 'ts', title: 'Broken Gateway Diagnosis', focus: 'gateway',
    blurb: 'PC-A cannot open any website. Its default gateway points at an address nobody on the LAN owns.',
    setup: (t) => { t.devices.pcA.gw = '192.168.1.99'; },
    flow: { type: 'web', src: 'pcA', name: 'nettracer.lab' } },
  { id: 'failover', num: '05', cat: 'ts', title: 'Router Failure & HSRP', focus: 'hsrp',
    blurb: 'R1 just lost power and the office is offline. Add a standby router behind a shared virtual gateway.',
    setup: (t) => { t.devices.r1.power = false; },
    flow: { type: 'ping', src: 'pcA', dst: '203.0.113.10' } },
  { id: 'noroute', num: '06', cat: 'l3', title: 'Missing Route to 8.8.8.0/24', focus: 'route',
    blurb: 'A change window removed a route on R1. DNS queries now die in the middle of the network.',
    setup: (t) => { t.devices.r1.routes = (t.devices.r1.routes || []).filter((r) => r.net !== '8.8.8.0'); },
    flow: { type: 'web', src: 'pcA', name: 'nettracer.lab' } },
  { id: 'intervlan', num: '07', cat: 'l3', title: 'Inter-VLAN Routing on a Stick', focus: 'hsrp',
    blurb: 'PC-A (VLAN 10) pings PC-C (VLAN 20) through one trunk to R1. Watch the 802.1Q tag change from 10 to 20 while the frame is rebuilt.',
    setup: (t) => { enableVlans(t); },
    flow: { type: 'ping', src: 'pcA', dst: '192.168.20.30' } },
];

export function labTopology(lab?: Lab | null): Topology {
  const t = baseTopology();
  if (lab && lab.setup) lab.setup(t);
  return t;
}

/* ---------- L2 attachment model ---------- */
export function buildNics(topo: Topology, ignorePower = false): Nic[] {
  const D = topo.devices;
  const alive = (d: Device) => ignorePower || powered(d);
  const nics: Nic[] = [];
  for (const d of Object.values(D)) {
    if (isHost(d) && d.uplink && D[d.uplink] && alive(d)) {
      const up = D[d.uplink];
      if (!isSwitch(up) && !isRouter(up)) continue;
      nics.push({
        id: d.id, dev: d.id, kind: 'host', mac: d.mac as string,
        vlan: isSwitch(up) ? Number(d.vlan) || 1 : 1,
        sw: isSwitch(up) ? up.id : null,
        peer: isRouter(up) ? up.id : null,
        addrs: [{ ip: d.ip as string, mask: d.mask as string, mac: d.mac as string }],
        vmacs: [], hsrp: [], roles: {}, domain: '',
      });
    }
    if (isRouter(d) && alive(d)) {
      for (const f of d.ifaces || []) {
        const up = D[f.peer];
        if (!up) continue;
        nics.push({
          id: `${d.id}:${f.name}`, dev: d.id, iface: f.name, kind: 'rif', mac: f.mac,
          vlan: isSwitch(up) ? Number(f.vlan) || 1 : 1,
          sw: isSwitch(up) ? up.id : null,
          // Point-to-point links reach a host or another router (for example an ISP edge router).
          peer: isHost(up) || isRouter(up) ? up.id : null,
          addrs: (f.addrs || []).map((a) => ({ ...a, mac: f.mac })),
          vmacs: [], hsrp: f.hsrp || [], prio: d.priority || 100, roles: {}, domain: '',
        });
      }
    }
  }
  // HSRP election: highest priority powered member owns each virtual IP
  const groups: Record<string, { n: Nic; g: HsrpGroup }[]> = {};
  for (const n of nics) for (const g of n.hsrp) (groups[g.vip] = groups[g.vip] || []).push({ n, g });
  for (const [vip, members] of Object.entries(groups)) {
    members.sort((a, b) => (b.n.prio ?? 100) - (a.n.prio ?? 100));
    const act = members[0];
    act.n.addrs.push({ ip: vip, mask: act.g.mask, mac: act.g.vmac, virtual: true, group: act.g.group });
    act.n.vmacs.push(act.g.vmac);
    members.forEach((m) => { m.n.roles[vip] = m === act ? 'Active' : 'Standby'; });
  }
  for (const n of nics) n.domain = n.sw ? `${n.sw}#${n.vlan}` : `p2p#${[n.dev, n.peer].sort().join('~')}`;
  return nics;
}

export const lpm = (routes: Route[] | undefined, ip: string): Route | null => {
  let best: Route | null = null;
  for (const r of routes || []) {
    if (!isIp(r.net) || !isMask(r.mask)) continue;
    if (sameNet(ip, r.net, r.mask) && (!best || cidr(r.mask) > cidr(best.mask))) best = r;
  }
  return best;
};

/* ---------- narrative copy ---------- */
export const WHY: Record<string, (...args: any[]) => string> = {
  arp: (who, ip) => `${who} knows the IP it needs (${ip}) but Ethernet delivers frames by MAC address. ARP asks every device in the broadcast domain who owns ${ip}. Only the owner answers, and both sides cache the result so the next packet skips this step.`,
  ping: (s, d) => `Ping sends an ICMP Echo Request from ${s} to ${d} and waits for an Echo Reply. It tests layer 3 reachability end to end. ICMP has no ports, so only the Ethernet and IP headers matter on this trip.`,
  pong: (s, d) => `${s} answers with an Echo Reply addressed back to ${d}. The reply makes its own trip through the same devices and reuses the ARP entries learned on the way in.`,
  dnsQ: (r, h) => `Connections open to IP addresses, so the browser first needs one for ${h}. The client sends a UDP query to its resolver ${r} on port 53 asking for the A record.`,
  dnsR: (h, a) => a ? `The resolver returns ${h} = ${a}. The client caches the answer for its TTL and can now open a TCP connection to that address.` : `The resolver has no record for ${h} and answers NXDOMAIN. The browser has no address to connect to.`,
  tcp: (p) => `TCP agrees on starting sequence numbers before any data moves. SYN, SYN-ACK and ACK cost one round trip to port ${p} and give both sides a reliable, ordered byte stream.`,
  tls: () => 'TLS 1.3 runs inside the TCP session. The client offers key shares, the server answers with its certificate, and both derive session keys. From this point, layer 7 is unreadable to every switch and router on the path.',
  https: () => 'The HTTP request and response still exist, wrapped in TLS Application Data records. Routers and switches see IP addresses and ports. The URL path, cookies and HTML stay encrypted.',
  httpReq: () => 'With the TCP session open, the browser sends a plain-text HTTP GET for /. Every device on the path can read the request line, headers and cookies.',
  httpRes: () => 'The server answers 200 OK with the HTML in the body. The browser can render the page. The whole exchange crossed the network in plain text.',
  hsrp: (vip, vmac) => `R1 and R2 share virtual IP ${vip} and virtual MAC ${vmac}. The Active router multicasts a Hello every 3 seconds. If the Hellos stop, the Standby takes over both virtual addresses and hosts keep the same gateway setting.`,
  rst: (p) => `Nothing on the destination listens on TCP port ${p}. The host answers the SYN with a reset and the browser reports connection refused.`,
};

/* ---------- simulation ---------- */
/** A frame in flight: the layered headers plus the addressing the engine needs. */
interface Frame {
  uid: number;
  proto: string;
  srcMac: string;
  dstMac: string;
  src: string;
  dst: string;
  ipDst?: string;
  info: string;
  size: number;
  layers: Layer[];
  top: number;
  tag: string;
  meta: Record<string, string>;
  note?: string;
}

interface L4 {
  type: 'TCP' | 'UDP' | 'ICMP';
  sub: string;
  fields: Field[];
}

/** An IP packet before it is wrapped in a frame. */
interface Pkt {
  uid: number;
  ip: { src: string; dst: string; ttl: number; id: number };
  proto: string;
  top: number;
  size: number;
  info: string;
  tag: string;
  l4: L4;
  l7?: { title: string; sub: string; fields: Field[] };
}

/** Result of sending an IP packet. `seenSrc` is the source address the receiver saw (it differs after NAT). */
interface SendResult {
  ok: boolean;
  at?: string;
  seenSrc?: string;
}

type EmitInput = Omit<SimEvent, 'no' | 't' | 'phase' | 'step' | 'changed' | 'snap' | 'flat' | 'layers' | 'size'> & {
  flat?: Record<string, string>;
  layers?: Layer[];
  size?: number;
};

export function simulate(topo: Topology, flow: Flow | null | undefined): SimResult {
  const D = topo.devices;
  const nics = buildNics(topo);
  const byDomain: Record<string, Nic[]> = {};
  nics.forEach((n) => (byDomain[n.domain] = byDomain[n.domain] || []).push(n));
  const name = (id: string) => (D[id] ? D[id].name : id);
  const list = (a: string[]) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

  // switch port names
  const port: Record<string, string> = {};
  for (const sw of Object.values(D).filter(isSwitch)) {
    let h = 0;
    const rmap: Record<string, string> = {};
    for (const n of nics.filter((x) => x.sw === sw.id)) {
      if (n.kind === 'host') port[n.id] = `Fa0/${++h}`;
      else {
        if (!rmap[n.dev]) rmap[n.dev] = `Gi0/${Object.keys(rmap).length + 1}`;
        port[n.id] = rmap[n.dev];
      }
    }
  }

  // mutable tables
  const arp: Record<string, Record<string, ArpEntry>> = {};
  const macT: Record<string, Record<string, MacEntry>> = {};
  /** NAT translations per router: remote address -> inside host address. */
  const natT: Record<string, Record<string, string>> = {};
  for (const d of Object.values(D)) {
    if (isHost(d) || isRouter(d)) arp[d.id] = clone(d.arpStatic || {});
    if (isSwitch(d)) macT[d.id] = clone(d.macStatic || {});
    if (isRouter(d) && d.nat) natT[d.id] = {};
  }

  const events: SimEvent[] = [];
  const phases: { id: number; kind: string; title: string; why: string }[] = [];
  let phase: { id: number; kind: string; title: string; why: string } | null = null;
  let t = 0;
  let uid = 0;
  let ipId = 0x1a20;
  let ok = true;
  let failure: { at: string; title: string } | null = null;
  const lastFlat: Record<number, Record<string, string>> = {};

  const setPhase = (kind: string, title: string, why: string) => {
    phase = { id: phases.length, kind, title, why };
    phases.push(phase);
    return phase;
  };
  const latency = (leg: { from: string; to: string }) => {
    const far = [leg.from, leg.to].some((id) => D[id] && (D[id].id === 'sw2' || (isHost(D[id]) && D[id].type === 'server')));
    return far ? 0.006 : 0.002;
  };

  function emit(ev: EmitInput): SimEvent {
    const flat = ev.flat || {};
    const changed: SimEvent['changed'] = [];
    if (ev.uid != null && lastFlat[ev.uid]) {
      const prev = lastFlat[ev.uid];
      for (const k of Object.keys({ ...prev, ...flat })) {
        if (prev[k] !== flat[k]) changed.push({ key: k, from: prev[k] ?? 'none', to: flat[k] ?? 'none' });
      }
    }
    if (ev.uid != null) lastFlat[ev.uid] = flat;
    const e = { ...ev, no: events.length + 1, t: Number(t.toFixed(4)), phase: phase ? phase.id : 0, changed, snap: { arp: clone(arp), mac: clone(macT) } } as SimEvent;
    events.push(e);
    if (ev.legs && ev.legs.length) t += latency(ev.legs[0]);
    return e;
  }

  function emitDrop(at: string, title: string, note: string, fr: Frame | null): SimEvent {
    ok = false;
    failure = failure || { at, title };
    return emit({
      drop: true, proto: 'DROP', legs: [], at, osi: fr ? Math.min(3, fr.top || 3) : 3,
      src: fr ? fr.src : name(at), dst: fr ? fr.dst : '', info: title, size: fr ? fr.size : 0,
      layers: fr ? fr.layers : [], flat: {}, tag: `DROP · ${title.toUpperCase()}`, note,
      hop: name(at), meta: fr ? fr.meta : {},
    });
  }

  const L2 = (dst: string, src: string, type: string): Layer => ({
    key: 'l2', n: 2, title: 'Ethernet II', sub: type.split(' · ')[1],
    fields: [['Destination', dst, 'l2.dst'], ['Source', src, 'l2.src'], ['EtherType', type, 'l2.type']],
  });

  function withVlan(fr: Frame, vlan: number | null) {
    const f: Record<string, string> = {};
    let layers = fr.layers;
    if (topo.vlans || vlan) {
      const v = vlan ? `VID ${vlan} · tagged` : 'untagged';
      layers = fr.layers.map((L) => (L.key === 'l2' ? { ...L, fields: [L.fields[0], L.fields[1], ['802.1Q', v, 'l2.vlan'], L.fields[2]] as Field[] } : L));
    }
    for (const L of layers) for (const [, v, k] of L.fields) if (k) f[k] = v;
    return { layers, flat: f, size: fr.size + (vlan ? 4 : 0) };
  }

  const osiAt = (n: Nic | undefined, fr: Frame) => {
    if (!n) return 2;
    if (n.kind === 'host') return fr.top;
    if (fr.ipDst && n.addrs.some((a) => a.ip === fr.ipDst)) return fr.top;
    return Math.min(3, fr.top);
  };

  function l2Send(from: Nic, fr: Frame): Nic[] {
    const dom = byDomain[from.domain] || [];
    const others = dom.filter((n) => n !== from);
    const accepts = (n: Nic) =>
      fr.dstMac === BCAST || n.mac === fr.dstMac || n.vmacs.includes(fr.dstMac) ||
      (fr.dstMac.startsWith('01:00:5e') && n.kind === 'rif');
    const base = { uid: fr.uid, proto: fr.proto, src: fr.src, dst: fr.dst, info: fr.info, tag: fr.tag, meta: fr.meta, top: fr.top };

    if (from.sw) {
      const sw = D[from.sw];
      const inTag = from.kind === 'rif' && from.vlan !== 1 ? from.vlan : null;
      const key = `${from.vlan}|${fr.srcMac}`;
      const prevEnt = macT[sw.id] && macT[sw.id][key];
      if (powered(sw) && !(prevEnt && prevEnt.static)) macT[sw.id][key] = { mac: fr.srcMac, vlan: from.vlan, port: from.id, portName: port[from.id] };
      const learned = !prevEnt || prevEnt.port !== from.id;
      const v1 = withVlan(fr, inTag);
      emit({
        ...base, ...v1, legs: [{ from: from.dev, to: sw.id }], at: sw.id, osi: powered(sw) ? 2 : 1,
        hop: `${name(from.dev)} → ${sw.name}`,
        note: `${fr.note ? fr.note + ' ' : ''}${powered(sw) ? `${sw.name} receives it on ${port[from.id]}${inTag ? ` (trunk, tag VID ${inTag})` : ''}${learned ? ` and records ${fr.srcMac} → ${port[from.id]} in its MAC table` : `. ${fr.srcMac} is already known on ${port[from.id]}`}. A switch reads only the L2 header.` : ''}`,
      });
      if (!powered(sw)) {
        emitDrop(sw.id, `${sw.name} is powered off`, `The frame reaches a dead port. ${sw.name} has no power, so nothing is forwarded and every device behind it is unreachable.`, fr);
        return [];
      }
      let targets: Nic[];
      let mode: string;
      if (fr.dstMac === BCAST) { targets = others; mode = 'broadcast'; }
      else {
        const ent = macT[sw.id][`${from.vlan}|${fr.dstMac}`];
        const tn = ent && others.find((n) => n.id === ent.port);
        if (tn) { targets = [tn]; mode = 'known'; }
        else { targets = others; mode = fr.dstMac.startsWith('01:00:5e') ? 'multicast' : 'unknown'; }
      }
      if (!targets.length) {
        emitDrop(sw.id, `No other ports in VLAN ${from.vlan}`, `${sw.name} has nowhere to send the frame. No other powered device sits in VLAN ${from.vlan}.`, fr);
        return [];
      }
      const outTag = targets.length === 1 && targets[0].kind === 'rif' && targets[0].vlan !== 1 ? targets[0].vlan : null;
      const v2 = withVlan(fr, outTag);
      const names = targets.map((n) => `${name(n.dev)} (${port[n.id]})`);
      const vtxt = topo.vlans ? `VLAN ${from.vlan}` : 'the VLAN';
      const note =
        mode === 'broadcast' ? `Destination ff:ff:ff:ff:ff:ff is a broadcast, so ${sw.name} floods a copy out every other port in ${vtxt}: ${list(names)}.`
        : mode === 'multicast' ? `${sw.name} has no IGMP snooping state for this multicast group, so it floods the frame to every port in ${vtxt}.`
        : mode === 'unknown' ? `${sw.name} has no MAC table entry for ${fr.dstMac} in ${vtxt}, so it floods the frame out every other port. This is unknown unicast flooding.`
        : `${sw.name} finds ${fr.dstMac} on ${port[targets[0].id]} and forwards out that one port. The frame leaves exactly as it arrived.${outTag ? ` It adds an 802.1Q tag (VID ${outTag}) because ${port[targets[0].id]} is a trunk to the router.` : ''}`;
      emit({
        ...base, ...v2, legs: targets.map((n) => ({ from: sw.id, to: n.dev })),
        at: targets.length === 1 ? targets[0].dev : sw.id, osi: targets.length === 1 ? osiAt(targets[0], fr) : 2,
        hop: targets.length === 1 ? `${sw.name} → ${name(targets[0].dev)}` : `${sw.name} → ${targets.length} ports`,
        note, flood: targets.length > 1,
      });
      return targets.filter(accepts);
    }

    const peer = others[0];
    const v = withVlan(fr, null);
    if (!peer) {
      emitDrop(from.dev, 'Link down', `${name(from.dev)} transmits, but nothing powered is on the other end of the cable.`, fr);
      return [];
    }
    emit({
      ...base, ...v, legs: [{ from: from.dev, to: peer.dev }], at: peer.dev, osi: osiAt(peer, fr),
      hop: `${name(from.dev)} → ${name(peer.dev)}`, note: fr.note || '',
    });
    return accepts(peer) ? [peer] : [];
  }

  function arpFrame(op: number, sMac: string, sIp: string, dMac: string, tMac: string, tIp: string): Frame {
    const layers: Layer[] = [
      L2(dMac, sMac, '0x0806 · ARP'),
      {
        key: 'arp', n: 3, title: 'ARP', sub: op === 1 ? 'Request' : 'Reply',
        fields: [['Opcode', op === 1 ? '1 · request' : '2 · reply', 'arp.op'], ['Sender MAC', sMac, 'arp.smac'], ['Sender IP', sIp, 'arp.sip'], ['Target MAC', tMac, 'arp.tmac'], ['Target IP', tIp, 'arp.tip']],
      },
    ];
    return {
      uid: ++uid, proto: 'ARP', srcMac: sMac, dstMac: dMac, src: sMac, dst: dMac === BCAST ? 'Broadcast' : dMac,
      info: op === 1 ? `Who has ${tIp}? Tell ${sIp}` : `${sIp} is at ${sMac}`, size: 60, layers, top: 3,
      tag: op === 1 ? `WHO HAS ${tIp}?` : `${sIp} IS AT ${sMac.slice(-5)}`,
      meta: { srcMac: sMac, dstMac: dMac, nextHop: tIp, ttl: 'n/a' },
    };
  }

  function resolve(nic: Nic, ip: string): string | null {
    const cache = arp[nic.dev];
    if (cache[ip]) return cache[ip].mac;
    const sAddr = nic.addrs.find((a) => !a.virtual && sameNet(a.ip, ip, a.mask)) || nic.addrs.find((a) => !a.virtual) || nic.addrs[0];
    const prev = phase;
    setPhase('arp', `ARP · ${name(nic.dev)} RESOLVES ${ip}`, WHY.arp(name(nic.dev), ip));
    for (let attempt = 0; attempt < 3; attempt++) {
      const fr = arpFrame(1, nic.mac, sAddr.ip, BCAST, ZERO_MAC, ip);
      fr.note = `${name(nic.dev)} needs the MAC address for ${ip}. It broadcasts an ARP request to ff:ff:ff:ff:ff:ff${attempt ? ` (retry ${attempt} of 2)` : ''}.`;
      const rx = l2Send(nic, fr);
      if (!ok) { phase = prev; return null; }
      const owner = rx.find((n) => n.addrs.some((a) => a.ip === ip));
      const ignore = rx.filter((n) => n !== owner).map((n) => name(n.dev));
      const flood = events[events.length - 1];
      if (ignore.length && flood) {
        flood.note += ` ${list(ignore)} ${ignore.length > 1 ? 'each read' : 'reads'} the request, ${ignore.length > 1 ? 'see' : 'sees'} that ${ip} belongs to someone else, and ${ignore.length > 1 ? 'discard' : 'discards'} it.`;
        flood.discards = rx.filter((n) => n !== owner).map((n) => n.dev);
      }
      if (owner) {
        const oa = owner.addrs.find((a) => a.ip === ip)!;
        if (!(arp[owner.dev][sAddr.ip] && arp[owner.dev][sAddr.ip].static)) arp[owner.dev][sAddr.ip] = { mac: nic.mac };
        const rep = arpFrame(2, oa.mac, ip, nic.mac, nic.mac, sAddr.ip);
        rep.note = `${name(owner.dev)} owns ${ip}${oa.virtual ? ` as the HSRP virtual IP because it is the Active router` : ''}. It caches ${name(nic.dev)}'s MAC from the request, then answers with a unicast ARP reply carrying ${oa.mac}.`;
        const back = l2Send(owner, rep);
        if (!back.includes(nic)) {
          if (ok) emitDrop(owner.dev, 'ARP reply lost', `The reply never reached ${name(nic.dev)}.`, rep);
          phase = prev;
          return null;
        }
        cache[ip] = { mac: oa.mac };
        const last = events[events.length - 1];
        last.note += ` ${name(nic.dev)} stores ${ip} → ${oa.mac} in its ARP cache.`;
        phase = prev;
        return oa.mac;
      }
      t += 1.0;
    }
    emitDrop(nic.dev, `ARP timeout for ${ip}`, `${name(nic.dev)} sent 3 ARP requests for ${ip} and nobody answered. No powered device in this broadcast domain owns that address, so the packet waiting behind the ARP is discarded.`, null);
    phase = prev;
    return null;
  }

  function ipFrame(pkt: Pkt, sMac: string, dMac: string, nextHop: string): Frame {
    const ip = pkt.ip;
    const pn = pkt.l4.type === 'TCP' ? '6 · TCP' : pkt.l4.type === 'UDP' ? '17 · UDP' : '1 · ICMP';
    const layers: Layer[] = [
      L2(dMac, sMac, '0x0800 · IPv4'),
      {
        key: 'l3', n: 3, title: 'IPv4', sub: `${ip.src} → ${ip.dst}`,
        fields: [['Source', ip.src, 'l3.src'], ['Destination', ip.dst, 'l3.dst'], ['TTL', String(ip.ttl), 'l3.ttl'], ['Protocol', pn, 'l3.proto'], ['Identification', '0x' + ip.id.toString(16), 'l3.id'], ['Header checksum', hx16(`${ip.src}${ip.dst}${ip.ttl}${ip.id}`), 'l3.csum']],
      },
      { key: pkt.l4.type === 'ICMP' ? 'icmp' : 'l4', n: pkt.l4.type === 'ICMP' ? 3 : 4, title: pkt.l4.type, sub: pkt.l4.sub, fields: pkt.l4.fields },
    ];
    if (pkt.l7) layers.push({ key: 'l7', n: 7, title: pkt.l7.title, sub: pkt.l7.sub, fields: pkt.l7.fields });
    return {
      uid: pkt.uid, proto: pkt.proto, srcMac: sMac, dstMac: dMac, src: ip.src, dst: ip.dst, ipDst: ip.dst,
      info: pkt.info, size: pkt.size, layers, top: pkt.top, tag: pkt.tag,
      meta: { srcMac: sMac, dstMac: dMac, nextHop, ttl: String(ip.ttl) },
    };
  }

  function routerOwns(rid: string, ip: string) {
    return nics.some((n) => n.dev === rid && n.addrs.some((a) => a.ip === ip));
  }

  function ipForward(out: Nic, pkt: Pkt, nh: string, note: string | ((mac: string) => string)): SendResult {
    const mac = resolve(out, nh);
    if (!mac) return { ok: false };
    const fr = ipFrame(pkt, out.mac, mac, nh);
    fr.note = typeof note === 'function' ? note(mac) : note;
    const rx = l2Send(out, fr);
    if (!ok) return { ok: false };
    const n = rx[0];
    if (!n) {
      emitDrop(out.dev, 'No device accepted the frame', `Destination MAC ${mac} is not present on this segment. A stale or wrong ARP entry sends frames to a MAC that no longer exists.`, fr);
      return { ok: false };
    }
    if (n.kind === 'host') {
      const h = D[n.dev];
      if (h.ip === pkt.ip.dst) return { ok: true, at: n.dev, seenSrc: pkt.ip.src };
      emitDrop(n.dev, `${h.name} does not route`, `${h.name} received a packet addressed to ${pkt.ip.dst}. End hosts do not forward traffic for others, so it is discarded.`, fr);
      return { ok: false };
    }
    const r = D[n.dev];
    // NAT, return direction: a reply to the router's public address goes back to the inside host that started the conversation.
    let natNote = '';
    let natIn: SimEvent['nat'] | undefined;
    if (r.nat && n.iface === r.nat.outside && pkt.ip.dst === r.nat.publicIp && natT[r.id] && natT[r.id][pkt.ip.src]) {
      const inside = natT[r.id][pkt.ip.src];
      natNote = ` NAT finds the mapping it saved on the way out and rewrites the destination ${pkt.ip.dst} → ${inside}.`;
      natIn = { router: r.id, from: pkt.ip.dst, to: inside, direction: 'in' };
      pkt = { ...pkt, ip: { ...pkt.ip, dst: inside } };
    }
    if (routerOwns(r.id, pkt.ip.dst)) return { ok: true, at: r.id, seenSrc: pkt.ip.src };
    const ttl = pkt.ip.ttl - 1;
    if (ttl <= 0) {
      emitDrop(r.id, 'TTL expired in transit', `${r.name} decremented TTL to 0 and discarded the packet. TTL exists to kill packets stuck in routing loops.`, fr);
      return { ok: false };
    }
    const rt = lpm(r.routes, pkt.ip.dst);
    if (!rt) {
      emitDrop(r.id, `No route to ${pkt.ip.dst}`, `${r.name} strips the Ethernet header and searches its routing table for ${pkt.ip.dst}. No entry matches and there is no default route, so the packet is dropped here. A real router would also send ICMP Destination Unreachable back to ${pkt.ip.src}.`, fr);
      return { ok: false };
    }
    const outN = nics.find((x) => x.dev === r.id && x.iface === rt.iface);
    if (!outN) {
      emitDrop(r.id, `${rt.iface} is down`, `The route points out ${rt.iface}, but that interface has no live link.`, fr);
      return { ok: false };
    }
    const hop = rt.via || pkt.ip.dst;
    let np: Pkt = { ...pkt, ip: { ...pkt.ip, ttl } };
    // NAT, outbound direction: inside -> outside traffic leaves with the router's public address as its source.
    let natOut: SimEvent['nat'] | undefined;
    if (r.nat && n.iface === r.nat.inside && outN.iface === r.nat.outside && np.ip.src !== r.nat.publicIp) {
      natT[r.id][np.ip.dst] = np.ip.src;
      natNote = ` NAT rewrites the private source ${np.ip.src} → ${r.nat.publicIp} (its public address) and saves the mapping so the reply can find its way back.`;
      natOut = { router: r.id, from: np.ip.src, to: r.nat.publicIp, direction: 'out' };
      np = { ...np, ip: { ...np.ip, src: r.nat.publicIp } };
    }
    const before = events.length;
    const res = ipForward(outN, np, hop, (m) =>
      `${r.name} strips the incoming Ethernet header, decrements TTL ${pkt.ip.ttl} → ${ttl}, and matches ${rt.net}/${cidr(rt.mask)} → ${rt.iface}.${natNote} It writes a brand new frame: source ${outN.mac} (its ${rt.iface}) and destination ${m} (${hop}).${natNote ? '' : ' Source and destination IP never change.'}${n.sw && outN.sw === n.sw && outN.vlan !== n.vlan ? ` The packet leaves on the same physical trunk it arrived on, retagged from VLAN ${n.vlan} to VLAN ${outN.vlan}. This design is called router on a stick.` : ''}`);
    const nat = natOut || natIn;
    if (nat) {
      // Tag the first frame the router transmitted for this packet (after any ARP it needed).
      const first = events.slice(before).find((e) => e.uid === np.uid);
      if (first) first.nat = nat;
    }
    return res;
  }

  function originate(id: string, pkt: Pkt): SendResult {
    const d = D[id];
    if (!d || !powered(d)) {
      emitDrop(id, `${name(id)} is powered off`, `${name(id)} cannot send anything without power.`, null);
      return { ok: false };
    }
    if (isRouter(d)) {
      const rt = lpm(d.routes, pkt.ip.dst);
      const outN = rt && nics.find((x) => x.dev === d.id && x.iface === rt.iface);
      if (!rt || !outN) {
        emitDrop(id, `No route to ${pkt.ip.dst}`, `${d.name} has no routing table entry for ${pkt.ip.dst}.`, null);
        return { ok: false };
      }
      return ipForward(outN, pkt, rt.via || pkt.ip.dst, (m) => `${d.name} sends from ${rt.iface} toward ${m}.`);
    }
    const nic = nics.find((n) => n.kind === 'host' && n.dev === id);
    if (!nic) {
      emitDrop(id, 'No network link', `${d.name} has no uplink cable, so the packet never leaves the host.`, null);
      return { ok: false };
    }
    if (!isIp(d.ip) || !isMask(d.mask)) {
      emitDrop(id, 'Invalid IP configuration', `${d.name} has an invalid IP address or subnet mask and cannot build an IP packet.`, null);
      return { ok: false };
    }
    const dIp = d.ip as string;
    const dMask = d.mask as string;
    const dst = pkt.ip.dst;
    const local = sameNet(dst, dIp, dMask);
    let nh = dst;
    if (!local) {
      if (!d.gw) {
        emitDrop(id, 'No default gateway', `${dst} is outside ${netOf(dIp, dMask)}/${cidr(dMask)}, so ${d.name} must hand it to a default gateway. None is configured, so the packet never leaves the host.`, null);
        return { ok: false };
      }
      if (!sameNet(d.gw, dIp, dMask)) {
        emitDrop(id, 'Gateway outside local subnet', `The gateway ${d.gw} is not inside ${netOf(dIp, dMask)}/${cidr(dMask)}. ARP only works inside the local subnet, so ${d.name} can never reach it.`, null);
        return { ok: false };
      }
      nh = d.gw;
    }
    return ipForward(nic, pkt, nh, (m) =>
      `${d.name} wraps the ${pkt.proto} data in an IP header (${pkt.ip.src} → ${dst}, TTL ${pkt.ip.ttl}) and an Ethernet frame. ${local ? `The destination is on its own subnet, so the frame goes straight to ${m}.` : `The destination is off-subnet, so the frame is addressed to the gateway ${nh} at ${m}.`}`);
  }

  /* ----- packet factories ----- */
  const mkIp = (src: string, dst: string) => ({ src, dst, ttl: 64, id: ipId++ });
  const icmp = (src: string, dst: string, type: number, seq: number): Pkt => ({
    uid: ++uid, ip: mkIp(src, dst), proto: 'ICMP', top: 3, size: 98,
    info: `Echo (ping) ${type === 8 ? "request" : "reply"}  id=0x0001, seq=${seq}`,
    tag: type === 8 ? 'ECHO REQUEST' : 'ECHO REPLY',
    l4: { type: 'ICMP', sub: type === 8 ? 'Echo request' : 'Echo reply', fields: [['Type', type === 8 ? '8 · Echo request' : '0 · Echo reply', 'icmp.type'], ['Code', '0', 'icmp.code'], ['Identifier', '0x0001', 'icmp.id'], ['Sequence', String(seq), 'icmp.seq'], ['Payload', '56 bytes', 'icmp.data']] },
  });
  const udp = (sp: number, dp: number, len: number): L4 => ({ type: 'UDP', sub: `${sp} → ${dp}`, fields: [['Source port', String(sp), 'l4.sp'], ['Destination port', String(dp), 'l4.dp'], ['Length', String(len), 'l4.len'], ['Checksum', hx16(`${sp}${dp}${len}`), 'l4.csum']] });
  const tcpL4 = (sp: number, dp: number, flags: string, seq: number, ack: number, len: number): L4 => ({ type: 'TCP', sub: `[${flags}]`, fields: [['Source port', String(sp), 'l4.sp'], ['Destination port', String(dp), 'l4.dp'], ['Flags', flags, 'l4.flags'], ['Sequence', String(seq), 'l4.seq'], ['Acknowledgment', String(ack), 'l4.ack'], ['Window', '64240', 'l4.win'], ['Payload', `${len} bytes`, 'l4.len']] });

  /* ----- flows ----- */
  function hsrpHello(srcId: string) {
    const src = nics.find((n) => n.dev === srcId);
    if (!src) return;
    const act = (byDomain[src.domain] || []).find((n) => n.kind === 'rif' && n.vmacs.length);
    if (!act) return;
    const vipAddr = act.addrs.find((a) => a.virtual)!;
    setPhase('hsrp', 'HSRP · ACTIVE ROUTER HELLO', WHY.hsrp(vipAddr.ip, vipAddr.mac));
    const real = act.addrs.find((a) => !a.virtual)!;
    const pkt: Pkt = {
      uid: ++uid, ip: { src: real.ip, dst: '224.0.0.2', ttl: 1, id: ipId++ }, proto: 'HSRP', top: 7, size: 62,
      info: `Hello (state Active) group ${vipAddr.group}, VIP ${vipAddr.ip}`, tag: `HELLO · ACTIVE ${name(act.dev)}`,
      l4: udp(1985, 1985, 28),
      l7: { title: 'HSRP', sub: 'Hello', fields: [['Version', '0', 'l7.v'], ['State', 'Active', 'l7.state'], ['Group', String(vipAddr.group), 'l7.grp'], ['Priority', String(act.prio), 'l7.prio'], ['Virtual IP', vipAddr.ip, 'l7.vip'], ['Hello / Hold', '3s / 10s', 'l7.timers']] },
    };
    const fr = ipFrame(pkt, vipAddr.mac, '01:00:5e:00:00:02', '224.0.0.2');
    fr.note = `${name(act.dev)} is the Active HSRP router. It sends a Hello to the all-routers multicast group from the virtual MAC ${vipAddr.mac}, so ${src.sw && D[src.sw] ? D[src.sw].name : 'the switch'} learns where the virtual gateway lives.`;
    const rx = l2Send(act, fr);
    const sb = rx.filter((n) => n.kind === 'rif' && n !== act).map((n) => name(n.dev));
    if (sb.length) events[events.length - 1].note += ` ${list(sb)} hears the Hello and stays Standby.`;
  }

  function ping(srcId: string, dstIp: string) {
    const s = D[srcId];
    const sIp = s.ip as string;
    setPhase('icmp', `ICMP ECHO · ${s.name} → ${dstIp}`, WHY.ping(s.name, dstIp));
    const r = originate(srcId, icmp(sIp, dstIp, 8, 1));
    if (!r.ok || !r.at) return;
    t += 0.001;
    setPhase('icmp', `ICMP REPLY · ${name(r.at)} → ${s.name}`, WHY.pong(name(r.at), s.name));
    originate(r.at, icmp(dstIp, r.seenSrc || sIp, 0, 1));
  }

  function dnsLookup(srcId: string, host: string): string | null {
    const s = D[srcId];
    const sIp = s.ip as string;
    const res = s.dns || '8.8.8.8';
    setPhase('dns', `DNS QUERY · A ${host}`, WHY.dnsQ(res, host));
    const q: Pkt = {
      uid: ++uid, ip: mkIp(sIp, res), proto: 'DNS', top: 7, size: 74, info: `Standard query 0x4f2a A ${host}`, tag: `QUERY A ${host}`,
      l4: udp(53211, 53, 40),
      l7: { title: 'DNS', sub: 'Query', fields: [['Transaction ID', '0x4f2a', 'l7.id'], ['Flags', '0x0100 · standard query', 'l7.flags'], ['Question', `${host} · A · IN`, 'l7.q'], ['Answer RRs', '0', 'l7.an']] },
    };
    const r = originate(srcId, q);
    if (!r.ok || !r.at) return null;
    const srv = D[r.at];
    if (!(isHost(srv) && srv.role === 'dns')) {
      emitDrop(r.at, 'UDP port 53 unreachable', `${srv.name} received the query, but it does not run a DNS service.`, null);
      return null;
    }
    const ans = (srv.records || {})[host];
    t += 0.004;
    setPhase('dns', `DNS RESPONSE · ${host} → ${ans || 'NXDOMAIN'}`, WHY.dnsR(host, ans));
    const a: Pkt = {
      uid: ++uid, ip: mkIp(res, r.seenSrc || sIp), proto: 'DNS', top: 7, size: ans ? 90 : 74,
      info: ans ? `Standard query response 0x4f2a A ${host} A ${ans}` : `Standard query response 0x4f2a No such name ${host}`,
      tag: ans ? `A ${ans}` : 'NXDOMAIN',
      l4: udp(53, 53211, ans ? 56 : 40),
      l7: { title: 'DNS', sub: 'Response', fields: [['Transaction ID', '0x4f2a', 'l7.id'], ['Flags', ans ? '0x8180 · no error' : '0x8183 · no such name', 'l7.flags'], ['Question', `${host} · A · IN`, 'l7.q'], ['Answer', ans ? `${host} A ${ans} · TTL 300` : 'none', 'l7.an']] },
    };
    const back = originate(r.at, a);
    if (!back.ok) return null;
    if (!ans) {
      emitDrop(srcId, `NXDOMAIN for ${host}`, `${srv.name} has no A record for ${host}. Add one in the DNS server inspector.`, null);
      return null;
    }
    return ans;
  }

  function web(srcId: string, host: string) {
    const ip = dnsLookup(srcId, host);
    if (!ip) return;
    const s = D[srcId];
    const sIp = s.ip as string;
    const tls = !!topo.tls;
    const dp = tls ? 443 : 80;
    const sp = 51544;
    setPhase('tcp', `TCP HANDSHAKE · ${s.name} → ${ip}:${dp}`, WHY.tcp(dp));
    const tcp = (src: string, dst: string, a: number, b: number, flags: string, seq: number, ack: number, len: number, extra: { proto?: string; top?: number; size?: number; info?: string; tag?: string; l7?: Pkt['l7'] }): Pkt => ({
      uid: ++uid, ip: mkIp(src, dst), proto: extra.proto || 'TCP', top: extra.top || 4, size: extra.size || 66 + len,
      info: extra.info || `${a} → ${b} [${flags}] Seq=${seq} Ack=${ack} Len=${len}`, tag: extra.tag || flags,
      l4: tcpL4(a, b, flags, seq, ack, len), l7: extra.l7,
    });
    const syn = originate(srcId, tcp(sIp, ip, sp, dp, 'SYN', 0, 0, 0, { size: 74, info: `${sp} → ${dp} [SYN] Seq=0 Win=64240 MSS=1460`, tag: 'SYN' }));
    if (!syn.ok || !syn.at) return;
    const seen = syn.seenSrc || sIp;
    const srv = D[syn.at];
    t += 0.001;
    if (!(isHost(srv) && srv.role === 'web')) {
      setPhase('tcp', 'CONNECTION REFUSED', WHY.rst(dp));
      originate(syn.at, tcp(ip, seen, dp, sp, 'RST, ACK', 0, 1, 0, { tag: 'RST' }));
      ok = false;
      failure = failure || { at: syn.at, title: `Port ${dp} closed` };
      return;
    }
    if (!originate(syn.at, tcp(ip, seen, dp, sp, 'SYN, ACK', 0, 1, 0, { size: 74, tag: 'SYN-ACK' })).ok) return;
    if (!originate(srcId, tcp(sIp, ip, sp, dp, 'ACK', 1, 1, 0, { tag: 'ACK' })).ok) return;
    if (tls) {
      setPhase('tls', 'TLS 1.3 HANDSHAKE', WHY.tls());
      const rec = (sub: string, f: Field[]) => ({ title: 'TLS', sub, fields: f });
      if (!originate(srcId, tcp(sIp, ip, sp, dp, 'PSH, ACK', 1, 1, 517, { proto: 'TLS', top: 7, info: `Client Hello (SNI=${host})`, tag: 'CLIENT HELLO', l7: rec('Client Hello', [['Content type', '22 · Handshake', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Handshake', 'Client Hello', 'l7.hs'], ['Server name', host, 'l7.sni'], ['Key share', 'x25519', 'l7.ks'], ['Cipher suites', 'TLS_AES_128_GCM_SHA256 +2', 'l7.cs']]) })).ok) return;
      t += 0.002;
      if (!originate(syn.at, tcp(ip, seen, dp, sp, 'PSH, ACK', 1, 518, 1380, { proto: 'TLS', top: 7, info: 'Server Hello, Change Cipher Spec, Certificate, Finished', tag: 'SERVER HELLO + CERT', l7: rec('Server Hello', [['Content type', '22 · Handshake', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Handshake', 'Server Hello + Certificate', 'l7.hs'], ['Certificate', `CN=${host} · ECDSA P-256`, 'l7.cert'], ['Cipher', 'TLS_AES_128_GCM_SHA256', 'l7.cs']]) })).ok) return;
      if (!originate(srcId, tcp(sIp, ip, sp, dp, 'PSH, ACK', 518, 1381, 74, { proto: 'TLS', top: 7, info: 'Change Cipher Spec, Finished', tag: 'FINISHED', l7: rec('Finished', [['Content type', '20/22 · CCS, Handshake', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Handshake', 'Finished (encrypted)', 'l7.hs']]) })).ok) return;
      setPhase('tls', 'HTTPS · ENCRYPTED REQUEST AND RESPONSE', WHY.https());
      if (!originate(srcId, tcp(sIp, ip, sp, dp, 'PSH, ACK', 592, 1381, 412, { proto: 'TLS', top: 7, info: 'Application Data (412 bytes, encrypted)', tag: 'APP DATA · GET', l7: rec('Application Data', [['Content type', '23 · Application Data', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Payload', 'a7 3f 9c 04 e1 6b ... (encrypted)', 'l7.data'], ['Inner request', 'hidden from the network', 'l7.inner']]) })).ok) return;
      t += 0.018;
      originate(syn.at, tcp(ip, seen, dp, sp, 'PSH, ACK', 1381, 1004, 1448, { proto: 'TLS', top: 7, info: 'Application Data (1448 bytes, encrypted)', tag: 'APP DATA · 200', l7: rec('Application Data', [['Content type', '23 · Application Data', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Payload', '5e 02 b8 71 0d c4 ... (encrypted)', 'l7.data'], ['Inner response', 'hidden from the network', 'l7.inner']]) }));
    } else {
      setPhase('http', 'HTTP REQUEST · GET /', WHY.httpReq());
      if (!originate(srcId, tcp(sIp, ip, sp, dp, 'PSH, ACK', 1, 1, 412, { proto: 'HTTP', top: 7, info: 'GET / HTTP/1.1', tag: 'GET / HTTP/1.1', l7: { title: 'HTTP', sub: 'Request', fields: [['Request line', 'GET / HTTP/1.1', 'l7.line'], ['Host', host, 'l7.host'], ['User-Agent', 'Mozilla/5.0 NetTracer', 'l7.ua'], ['Cookie', 'session=8f2c91d0 (readable)', 'l7.cookie']] } })).ok) return;
      t += 0.018;
      setPhase('http', 'HTTP RESPONSE · 200 OK', WHY.httpRes());
      originate(syn.at, tcp(ip, seen, dp, sp, 'PSH, ACK', 1, 413, 1448, { proto: 'HTTP', top: 7, info: 'HTTP/1.1 200 OK  (text/html)', tag: '200 OK', l7: { title: 'HTTP', sub: 'Response', fields: [['Status line', 'HTTP/1.1 200 OK', 'l7.line'], ['Content-Type', 'text/html; charset=utf-8', 'l7.ct'], ['Content-Length', '1382', 'l7.len'], ['Body', '<!doctype html><title>NetTracer</title>...', 'l7.body']] } }));
    }
  }

  setPhase('start', 'READY', '');
  const f = (flow || {}) as Partial<Flow> & { dst?: string; name?: string };
  const src = f.src ? D[f.src] : undefined;
  if (!src) {
    emitDrop(f.src || 'none', 'Source device missing', 'Pick a source device for this traffic.', null);
  } else if (!powered(src)) {
    emitDrop(src.id, `${src.name} is powered off`, `${src.name} cannot send traffic without power.`, null);
  } else {
    if (topo.hsrp) hsrpHello(src.id);
    if (f.type === 'ping') ping(src.id, f.dst as string);
    else if (f.type === 'dns') dnsLookup(src.id, f.name || 'nettracer.lab');
    else web(src.id, f.name || 'nettracer.lab');
  }

  const steps: SimStep[] = [];
  events.forEach((e, i) => {
    const last = steps[steps.length - 1];
    if (!last || last.phase !== e.phase) {
      const p = phases[e.phase];
      steps.push({ phase: e.phase, start: i, end: i, title: p.title, why: p.why, kind: p.kind, proto: e.proto, drop: !!e.drop });
    } else {
      last.end = i;
      if (e.drop) last.drop = true;
    }
    e.step = steps.length - 1;
  });

  return {
    events, steps, ok, failure, ports: port,
    duration: events.length ? events[events.length - 1].t : 0,
    final: { arp: clone(arp), mac: clone(macT) },
  };
}

/* ---------- improvements: analyzer + 1-click fixes ---------- */
export function freeIp(topo: Topology, near: string): string {
  const used = new Set<string>();
  for (const d of Object.values(topo.devices)) {
    if (d.ip) used.add(d.ip);
    for (const f of d.ifaces || []) {
      f.addrs.forEach((a) => used.add(a.ip));
      (f.hsrp || []).forEach((g) => used.add(g.vip));
    }
  }
  for (let h = 11; h < 254; h++) {
    const ip = withHost(near, h);
    if (!used.has(ip)) return ip;
  }
  return withHost(near, 250);
}

export function analyze(topo: Topology, focus?: string): Analysis {
  const D = topo.devices;
  const nics = buildNics(topo, true);
  const hosts = Object.values(D).filter(isHost);
  const routers = Object.values(D).filter(isRouter);
  const issues: Issue[] = [];

  for (const h of hosts) {
    const nic = nics.find((n) => n.kind === 'host' && n.dev === h.id);
    if (!nic || !isIp(h.ip) || !isMask(h.mask)) continue;
    const rifs = nics.filter((n) => n.kind === 'rif' && n.domain === nic.domain);
    if (!rifs.length) continue;
    let cand = null;
    for (const r of rifs) for (const g of r.hsrp) if (!cand && sameNet(g.vip, h.ip, h.mask)) cand = g.vip;
    for (const r of rifs) for (const a of r.addrs) if (!cand && sameNet(a.ip, h.ip, h.mask)) cand = a.ip;
    if (!cand || h.gw === cand) continue;
    const owned = rifs.some((r) => r.addrs.some((a) => a.ip === h.gw) || r.hsrp.some((g) => g.vip === h.gw));
    if (!owned || !sameNet(h.gw, h.ip, h.mask)) {
      issues.push({
        id: `gw-${h.id}`, tag: 'gateway', sev: 'high', penalty: 30,
        title: h.gw ? `Misconfigured gateway ${h.gw} on ${h.name}` : `No default gateway on ${h.name}`,
        detail: h.gw
          ? `${h.name} sends every off-subnet packet to ${h.gw}, and no router interface owns that address. ARP requests go unanswered, so DNS, web and ping traffic all die at the first hop.`
          : `${h.name} can reach its own subnet only. Anything else has no next hop.`,
        actions: [{ label: `Fix Gateway to ${cand}`, icon: 'wrench', fix: { type: 'set', id: h.id, patch: { gw: cand } } }],
      });
    } else if (topo.hsrp) {
      issues.push({
        id: `gwv-${h.id}`, tag: 'hsrp', sev: 'med', penalty: 8,
        title: `${h.name} bypasses the HSRP virtual gateway`,
        detail: `${h.gw} is a physical router address. If that router fails, ${h.name} loses its gateway even though HSRP is running.`,
        actions: [{ label: `Point gateway at VIP ${cand}`, icon: 'wrench', fix: { type: 'set', id: h.id, patch: { gw: cand } } }],
      });
    }
  }

  const seen: Record<string, Device[]> = {};
  for (const h of hosts) if (h.uplink && isIp(h.ip)) (seen[h.ip as string] = seen[h.ip as string] || []).push(h);
  for (const [ip, hs] of Object.entries(seen)) {
    if (hs.length < 2) continue;
    const victim = hs[hs.length - 1];
    const free = freeIp(topo, ip);
    issues.push({
      id: `dup-${ip}`, tag: 'dup', sev: 'high', penalty: 20,
      title: `Duplicate IP ${ip}`,
      detail: `${hs.map((x) => x.name).join(' and ')} both claim ${ip}. Their ARP replies race each other and traffic lands on whichever host answered last.`,
      actions: [{ label: `Re-address ${victim.name} to ${free}`, icon: 'wrench', fix: { type: 'set', id: victim.id, patch: { ip: free } } }],
    });
  }

  for (const r of routers) {
    for (const f of r.ifaces || []) {
      for (const a of f.addrs) {
        if (!isIp(a.ip) || !isMask(a.mask)) continue;
        const net = netOf(a.ip, a.mask);
        if (!(r.routes || []).some((rt) => rt.net === net && rt.mask === a.mask)) {
          issues.push({
            id: `rt-${r.id}-${net}`, tag: 'route', sev: 'high', penalty: 25,
            title: `${r.name} has no route to ${net}/${cidr(a.mask)}`,
            detail: `${f.name} sits on ${net}/${cidr(a.mask)}, but the routing table has no entry for it. Packets for hosts on that network match nothing and are dropped at ${r.name}.`,
            actions: [{ label: `Restore ${net}/${cidr(a.mask)} via ${f.name}`, icon: 'route', fix: { type: 'route', router: r.id, route: { net, mask: a.mask, iface: f.name, via: '', type: 'C' } } }],
          });
        }
      }
    }
  }

  const down = routers.filter((r) => !powered(r));
  if (routers.length && !topo.hsrp) {
    if (down.length) {
      issues.push({
        id: 'down', tag: 'hsrp', sev: 'high', penalty: 30,
        title: `${down[0].name} is down with no backup`,
        detail: `Every host on the LAN uses ${down[0].name} as its only gateway. With it powered off, nothing leaves the LAN. HSRP adds a standby router that takes over the virtual gateway IP within seconds.`,
        actions: [
          { label: 'Enable HSRP Redundancy', icon: 'shield', fix: { type: 'hsrp' } },
          { label: `Power on ${down[0].name}`, icon: 'power', ghost: true, fix: { type: 'set', id: down[0].id, patch: { power: true } } },
        ],
      });
    } else {
      issues.push({
        id: 'spof', tag: 'hsrp', sev: 'med', penalty: 10,
        title: `Single point of failure at ${routers[0].name}`,
        detail: `One router carries all traffic between the LAN and the internet. A reboot or a failed power supply takes the whole office offline. HSRP pairs ${routers[0].name} with a standby router behind a shared virtual IP.`,
        actions: [{ label: 'Enable HSRP Redundancy', icon: 'shield', fix: { type: 'hsrp' } }],
      });
    }
  } else if (down.length) {
    issues.push({
      id: 'down-h', tag: 'hsrp', sev: 'low', penalty: 5,
      title: `${down.map((d) => d.name).join(', ')} down, standby carrying traffic`,
      detail: 'HSRP moved the virtual gateway to the standby router and users stayed online. There is no redundancy left until the failed router returns.',
      actions: down.map((d) => ({ label: `Power on ${d.name}`, icon: 'power', fix: { type: 'set', id: d.id, patch: { power: true } } })),
    });
  }

  if (!topo.vlans && D.sw1) {
    const lan = hosts.filter((h) => h.uplink === 'sw1');
    if (lan.length >= 3) {
      issues.push({
        id: 'bcast', tag: 'vlan', sev: 'med', penalty: 10,
        title: `Broadcast noise: ${lan[2].name} receives ${lan[0].name}'s ARP requests`,
        detail: `All ${lan.length} hosts on SW1 share VLAN 1, one broadcast domain. Every ARP and discovery broadcast interrupts every NIC on the switch. VLAN 10 and VLAN 20 contain broadcasts and let R1 filter traffic between the groups.`,
        actions: [{ label: 'Segment with 802.1Q VLANs', icon: 'split', fix: { type: 'vlans' } }],
      });
    }
  }

  if (!topo.tls && hosts.some((h) => h.role === 'web')) {
    issues.push({
      id: 'tls', tag: 'tls', sev: 'med', penalty: 15,
      title: 'Plaintext HTTP on port 80',
      detail: 'Any device on the path between PC-A and the web server can read the GET request, the session cookie and the HTML. TLS encrypts layer 7 and proves the server identity with a certificate.',
      actions: [{ label: 'Upgrade to TLS 1.3 (HTTPS :443)', icon: 'lock', fix: { type: 'tls' } }],
    });
  }

  const rank = { high: 0, med: 1, low: 2 };
  issues.sort((a, b) => Number(b.tag === focus) - Number(a.tag === focus) || rank[a.sev] - rank[b.sev]);
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + i.penalty, 0));
  const hardening: string[] = [];
  if (topo.vlans) hardening.push('802.1Q · VLAN 10 / 20');
  if (topo.hsrp) hardening.push('HSRP · VIP 192.168.1.1');
  if (topo.tls) hardening.push('TLS 1.3 · HTTPS :443');
  return { issues, score, hardening };
}

export function enableHsrp(t: Topology): void {
  if (t.hsrp || !t.devices.r1) return;
  const r1 = t.devices.r1;
  let g = 1;
  for (const f of r1.ifaces!) {
    f.hsrp = f.addrs.map((a) => {
      const grp = g++;
      return { vip: a.ip, mask: a.mask, group: grp, vmac: `00:00:0c:07:ac:${grp.toString(16).padStart(2, '0')}` };
    });
    f.addrs = f.addrs.map((a) => ({ ip: withHost(a.ip, 2), mask: a.mask }));
  }
  const r2 = clone(r1);
  Object.assign(r2, { id: 'r2', name: 'R2', label: 'Standby Router', priority: 100, power: true, arpStatic: {}, pos: [r1.pos![0], r1.pos![1] - 6.0] });
  r2.ifaces!.forEach((f, i) => {
    f.mac = `00:1e:7a:c2:00:0${i + 1}`;
    f.addrs = f.addrs.map((a) => ({ ip: withHost(a.ip, 3), mask: a.mask }));
  });
  r1.priority = 110;
  t.devices.r2 = r2;
  t.hsrp = true;
}

export function enableVlans(t: Topology): void {
  if (t.vlans) return;
  const D = t.devices;
  for (const h of Object.values(D)) {
    if (!isHost(h) || h.uplink !== 'sw1') continue;
    if (h.id === 'pcC') {
      h.vlan = 20;
      h.ip = withHost('192.168.20.0', hostPart(h.ip));
      h.gw = '192.168.20.1';
      h.arpStatic = {};
    } else h.vlan = 10;
  }
  for (const r of Object.values(D).filter(isRouter)) {
    const ifaces = r.ifaces!;
    const routes = r.routes!;
    const idx = ifaces.findIndex((f) => f.peer === 'sw1' && (Number(f.vlan) || 1) === 1);
    if (idx < 0) continue;
    const f = ifaces[idx];
    const hn = hostPart(f.addrs[0].ip);
    const s10 = { ...f, name: `${f.name}.10`, vlan: 10 };
    const s20 = {
      name: `${f.name}.20`, mac: f.mac, peer: 'sw1', vlan: 20,
      addrs: [{ ip: withHost('192.168.20.0', hn), mask: M24 }],
      hsrp: f.hsrp && f.hsrp.length ? [{ vip: '192.168.20.1', mask: M24, group: 20, vmac: '00:00:0c:07:ac:14' }] : [],
    };
    ifaces.splice(idx, 1, s10, s20);
    r.routes = routes.map((rt) => (rt.iface === f.name ? { ...rt, iface: s10.name } : rt));
    r.routes.push({ net: '192.168.20.0', mask: M24, iface: s20.name, via: '', type: 'C' });
  }
  t.vlans = true;
}

export function applyFix(topo: Topology, fix: Fix): Topology {
  const t = clone(topo);
  const D = t.devices;
  if (fix.type === 'set') Object.assign(D[fix.id], fix.patch);
  else if (fix.type === 'route') D[fix.router].routes!.push(fix.route);
  else if (fix.type === 'tls') t.tls = true;
  else if (fix.type === 'vlans') enableVlans(t);
  else if (fix.type === 'hsrp') enableHsrp(t);
  return t;
}

/* ---------- topology edit helpers ---------- */
export function editIface(topo: Topology, rid: string, ifName: string, ip: string, mask: string): Topology {
  const t = clone(topo);
  const r = t.devices[rid];
  const f = r.ifaces!.find((x) => x.name === ifName)!;
  const routes = r.routes!;
  const old = f.addrs[0];
  const oldNet = isIp(old.ip) && isMask(old.mask) ? netOf(old.ip, old.mask) : null;
  f.addrs[0] = { ip, mask };
  if (isIp(ip) && isMask(mask)) {
    const newNet = netOf(ip, mask);
    const i = routes.findIndex((rt) => rt.type === 'C' && rt.iface === ifName && rt.net === oldNet);
    if (i >= 0) routes[i] = { ...routes[i], net: newNet, mask };
  }
  return t;
}

let devCounter = 0;
export function addHost(topo: Topology, kind: string): { topo: Topology; id: string } {
  const t = clone(topo);
  const D = t.devices;
  devCounter += 1;
  const sw = kind === 'server' ? 'sw2' : 'sw1';
  const peers = Object.values(D).filter((d) => isHost(d) && d.uplink === sw && powered(d));
  const ref = peers.find((p) => (Number(p.vlan) || 1) !== 20) || peers[0];
  const baseIp = ref ? (ref.ip as string) : kind === 'server' ? '203.0.113.10' : '192.168.1.10';
  const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ';
  const n = Object.values(D).filter((d) => d.type === (kind === 'server' ? 'server' : 'laptop')).length;
  const id = `${kind === 'server' ? 'srv' : 'pc'}${Date.now().toString(36)}${devCounter}`;
  const swPos = (D[sw] && D[sw].pos) || [0, 0];
  const count = Object.values(D).filter((d) => isHost(d) && d.uplink === sw).length;
  const slots = kind === 'server'
    ? [[5.6, 6.4], [14, 0.2], [14.2, 6.4], [5.6, -6.6], [14.2, -6.4]]
    : [[-7.4, 6.4], [-3.6, 6.6], [-15.2, 6.4], [-15.6, 0.2], [-7.4, -6.4], [-15.2, -6.4]];
  const taken = (p: number[]) => Object.values(D).some((x) => x.pos && Math.hypot(x.pos[0] - p[0], x.pos[1] - p[1]) < 2.2);
  const pos = slots.find((p) => !taken(p)) || [swPos[0] + (kind === 'server' ? 4 : -4) + (devCounter % 4), swPos[1] + 6.4 - (devCounter % 3) * 1.2];
  D[id] = {
    id, type: kind === 'server' ? 'server' : 'laptop', role: kind === 'server' ? 'web' : 'client',
    name: kind === 'server' ? `SRV-${n + 1}` : `PC-${letters[Math.max(0, n - 3)] || 'X'}`,
    label: kind === 'server' ? 'Server' : 'Workstation',
    ip: freeIp(t, baseIp), mask: ref ? ref.mask : M24, gw: ref ? ref.gw : '', dns: '8.8.8.8',
    mac: `02:4e:54:${(devCounter * 37 % 255).toString(16).padStart(2, '0')}:${(n * 11 % 255).toString(16).padStart(2, '0')}:${(devCounter * 7 % 255).toString(16).padStart(2, '0')}`,
    uplink: sw, vlan: ref ? ref.vlan : 1, power: true, arpStatic: {}, pos,
  };
  return { topo: t, id };
}

export function removeDevice(topo: Topology, id: string): Topology {
  const t = clone(topo);
  delete t.devices[id];
  for (const d of Object.values(t.devices)) if (d.uplink === id) d.uplink = '';
  return t;
}
