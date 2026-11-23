/**
 * Shared types for net-core. No runtime code lives here.
 */

export type DeviceType = 'laptop' | 'server' | 'switch' | 'router';

/** Optional facts about a device that came from a real network scan. Ignored by the simulator. */
export interface DeviceMeta {
  /** Vendor guessed from the MAC prefix, e.g. "Apple". */
  vendor?: string;
  /** Device kind guessed by the scanner: router, phone, pc, tv, printer, unknown. */
  kind?: 'router' | 'phone' | 'pc' | 'tv' | 'printer' | 'speaker' | 'console' | 'iot' | 'internet' | 'unknown';
  /** Hostname reported by the OS, when one resolved. */
  hostname?: string;
  /** How the device reaches the router. Visual only. */
  link?: 'wired' | 'wifi';
  /** Round-trip time from the scanning PC at scan time, in milliseconds. */
  latencyMs?: number | null;
  /** MAC as shown to people. Masked to "aa:bb:cc:dd:xx:xx" unless the scan used --full-mac. */
  macDisplay?: string;
  /** True when the MAC has the locally administered bit set (phones often use private Wi-Fi addresses). */
  randomMac?: boolean;
  /** True for the PC that ran the scan. */
  scanner?: boolean;
}

export interface ArpEntry {
  mac: string;
  static?: boolean;
}

export interface MacEntry {
  mac: string;
  vlan: number;
  port: string;
  portName?: string;
  static?: boolean;
}

export interface Addr {
  ip: string;
  mask: string;
}

export interface HsrpGroup {
  vip: string;
  mask: string;
  group: number;
  vmac: string;
}

export interface Iface {
  name: string;
  mac: string;
  peer: string;
  vlan: number;
  addrs: Addr[];
  hsrp: HsrpGroup[];
}

export interface Route {
  net: string;
  mask: string;
  iface: string;
  via: string;
  type: string;
}

/**
 * Source NAT on a router. Packets that enter on `inside` and leave on `outside`
 * get their source address rewritten to `publicIp`. Replies to `publicIp` are
 * translated back using the mapping recorded on the way out.
 */
export interface NatConfig {
  inside: string;
  outside: string;
  publicIp: string;
}

export interface Device {
  id: string;
  type: DeviceType;
  name: string;
  label?: string;
  role?: 'client' | 'dns' | 'web' | string;
  power?: boolean;
  /** Stage-local position. NetTracer uses [u, v]; other renderers may ignore it. */
  pos?: number[];
  // hosts
  ip?: string;
  mask?: string;
  gw?: string;
  dns?: string;
  mac?: string;
  uplink?: string;
  vlan?: number;
  arpStatic?: Record<string, ArpEntry>;
  records?: Record<string, string>;
  // switches
  macStatic?: Record<string, MacEntry>;
  // routers
  priority?: number;
  ifaces?: Iface[];
  routes?: Route[];
  nat?: NatConfig;
  meta?: DeviceMeta;
}

/** One hop past the home router, from a traceroute. */
export interface TraceHop {
  n: number;
  ip: string | null;
  rttMs: number | null;
}

/** What the scanner learned about the path to the internet. */
export interface InternetInfo {
  target: string;
  latencyMs: number | null;
  gatewayLatencyMs: number | null;
  hops: TraceHop[];
}

export interface Topology {
  vlans: boolean;
  hsrp: boolean;
  tls: boolean;
  devices: Record<string, Device>;
  /** Present on topologies built from a home network scan. */
  internet?: InternetInfo;
  /** Present on topologies built from a home network scan. */
  scan?: {
    version: number;
    scannedAt: string;
    subnet: string;
    macsMasked: boolean;
    tool: string;
  };
}

export type Flow =
  | { type: 'ping'; src: string; dst: string }
  | { type: 'dns'; src: string; name?: string }
  | { type: 'web'; src: string; name?: string };

export type Field = [label: string, value: string, key?: string];

export interface Layer {
  key: string;
  n: number;
  title: string;
  sub?: string;
  fields: Field[];
}

export interface Leg {
  from: string;
  to: string;
}

export interface Change {
  key: string;
  from: string;
  to: string;
}

export interface SimEvent {
  no: number;
  t: number;
  phase: number;
  step: number;
  uid?: number;
  proto: string;
  src: string;
  dst: string;
  info: string;
  tag: string;
  note: string;
  hop: string;
  at: string;
  osi: number;
  size: number;
  legs: Leg[];
  layers: Layer[];
  flat: Record<string, string>;
  changed: Change[];
  meta: Record<string, string>;
  drop?: boolean;
  flood?: boolean;
  discards?: string[];
  /** Set on the event where a router rewrote an address with NAT. */
  nat?: { router: string; from: string; to: string; direction: 'out' | 'in' };
  snap: { arp: Record<string, Record<string, ArpEntry>>; mac: Record<string, Record<string, MacEntry>> };
  top?: number;
}

export interface SimStep {
  phase: number;
  start: number;
  end: number;
  title: string;
  why: string;
  kind: string;
  proto: string;
  drop: boolean;
}

export interface SimResult {
  events: SimEvent[];
  steps: SimStep[];
  ok: boolean;
  failure: { at: string; title: string } | null;
  ports: Record<string, string>;
  duration: number;
  final: { arp: Record<string, Record<string, ArpEntry>>; mac: Record<string, Record<string, MacEntry>> };
}

export type Fix =
  | { type: 'set'; id: string; patch: Partial<Device> }
  | { type: 'route'; router: string; route: Route }
  | { type: 'tls' }
  | { type: 'vlans' }
  | { type: 'hsrp' };

export interface IssueAction {
  label: string;
  icon: string;
  fix: Fix;
  ghost?: boolean;
}

export interface Issue {
  id: string;
  tag: string;
  sev: 'high' | 'med' | 'low';
  penalty: number;
  title: string;
  detail: string;
  actions: IssueAction[];
}

export interface Analysis {
  issues: Issue[];
  score: number;
  hardening: string[];
}

export interface Lab {
  id: string;
  num: string;
  cat: string;
  title: string;
  focus: string;
  blurb: string;
  setup?: (t: Topology) => void;
  flow: Flow;
}
