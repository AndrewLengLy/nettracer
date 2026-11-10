'use client';
/**
 * NetTracer · Protocol & Topology Explorer
 * nettracer.andrewlengly.com
 *
 * Single-file React component. Requires: react, three, lucide-react, Tailwind CSS.
 *   npm i three lucide-react
 *
 * Structure
 *   1 · Network engine   pure simulation (ARP, switching, routing, VLANs, HSRP, DNS/TCP/HTTP/TLS)
 *   2 · Three.js stage   isometric diorama, procedural hardware, packets, exploded OSI layers
 *   3 · React interface  header, labs, capture table, narrative, byte diff, improvements
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Eraser, Laptop, Layers, ListTree, Lock, Network,
  Pause, Pin, Play, Plus, Power, RotateCcw, Route, Router as RouterIcon, Scan, Server, ShieldCheck, SkipBack,
  SkipForward, Split, Trash2, Wrench, X,
} from 'lucide-react';

/* =====================================================================
   1 · NETWORK ENGINE
   Pure functions. topology + flow  ->  frame-by-frame event list.
   Every frame is computed from live device config (IP, mask, gateway,
   VLAN, ARP cache, MAC table, routing table, HSRP, power).
   ===================================================================== */

const BCAST = 'ff:ff:ff:ff:ff:ff';
const ZERO_MAC = '00:00:00:00:00:00';
const M24 = '255.255.255.0';

const PROTO_COLOR = {
  ARP: '#06B6D4',
  ICMP: '#14B8A6',
  DNS: '#F59E0B',
  TCP: '#3B82F6',
  HTTP: '#10B981',
  TLS: '#34D399',
  HSRP: '#6366F1',
  DROP: '#F43F5E',
};
const LEGEND = ['ARP', 'DNS', 'TCP', 'HTTP', 'ICMP', 'TLS', 'HSRP', 'DROP'];
const OSI_NAMES = ['Physical', 'Data Link', 'Network', 'Transport', 'Session', 'Presentation', 'Application'];

const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------- IPv4 helpers ---------- */
const ipInt = (ip) => {
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
const intIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIp = (ip) => ipInt(ip) !== null;
const isMask = (m) => {
  const n = ipInt(m);
  if (n === null) return false;
  const inv = ~n >>> 0;
  return ((inv + 1) & inv) === 0;
};
const cidr = (m) => {
  let n = ipInt(m) || 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
};
const netOf = (ip, mask) => intIp((ipInt(ip) & ipInt(mask)) >>> 0);
const sameNet = (a, b, mask) =>
  isIp(a) && isIp(b) && isMask(mask) && ((ipInt(a) & ipInt(mask)) >>> 0) === ((ipInt(b) & ipInt(mask)) >>> 0);
const hostPart = (ip) => Number(String(ip).split('.')[3] || 0);
const withHost = (ip, h) => String(ip).split('.').slice(0, 3).concat(String(h)).join('.');
const hx16 = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return '0x' + (h & 0xffff).toString(16).padStart(4, '0');
};

/* ---------- device predicates ---------- */
const isHost = (d) => !!d && (d.type === 'laptop' || d.type === 'server');
const isSwitch = (d) => !!d && d.type === 'switch';
const isRouter = (d) => !!d && d.type === 'router';
const powered = (d) => !!d && d.power !== false;

/* ---------- base lab topology (positions are stage-local u,v) ---------- */
function baseTopology() {
  const host = (o) => ({ mask: M24, vlan: 1, power: true, arpStatic: {}, ...o });
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
const CATS = [
  { id: 'all', label: 'ALL' },
  { id: 'l2', label: 'L2 SWITCHING' },
  { id: 'l3', label: 'L3 ROUTING' },
  { id: 'web', label: 'WEB STACK' },
  { id: 'ts', label: 'TROUBLESHOOTING' },
];

const LABS = [
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
    setup: (t) => { t.devices.r1.routes = t.devices.r1.routes.filter((r) => r.net !== '8.8.8.0'); },
    flow: { type: 'web', src: 'pcA', name: 'nettracer.lab' } },
  { id: 'intervlan', num: '07', cat: 'l3', title: 'Inter-VLAN Routing on a Stick', focus: 'hsrp',
    blurb: 'PC-A (VLAN 10) pings PC-C (VLAN 20) through one trunk to R1. Watch the 802.1Q tag change from 10 to 20 while the frame is rebuilt.',
    setup: (t) => { enableVlans(t); },
    flow: { type: 'ping', src: 'pcA', dst: '192.168.20.30' } },
];

function labTopology(lab) {
  const t = baseTopology();
  if (lab && lab.setup) lab.setup(t);
  return t;
}

/* ---------- L2 attachment model ---------- */
function buildNics(topo, ignorePower = false) {
  const D = topo.devices;
  const alive = (d) => ignorePower || powered(d);
  const nics = [];
  for (const d of Object.values(D)) {
    if (isHost(d) && d.uplink && D[d.uplink] && alive(d)) {
      const up = D[d.uplink];
      if (!isSwitch(up) && !isRouter(up)) continue;
      nics.push({
        id: d.id, dev: d.id, kind: 'host', mac: d.mac,
        vlan: isSwitch(up) ? Number(d.vlan) || 1 : 1,
        sw: isSwitch(up) ? up.id : null,
        peer: isRouter(up) ? up.id : null,
        addrs: [{ ip: d.ip, mask: d.mask, mac: d.mac }],
        vmacs: [], hsrp: [], roles: {},
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
          peer: isHost(up) ? up.id : null,
          addrs: (f.addrs || []).map((a) => ({ ...a, mac: f.mac })),
          vmacs: [], hsrp: f.hsrp || [], prio: d.priority || 100, roles: {},
        });
      }
    }
  }
  // HSRP election: highest priority powered member owns each virtual IP
  const groups = {};
  for (const n of nics) for (const g of n.hsrp) (groups[g.vip] = groups[g.vip] || []).push({ n, g });
  for (const [vip, members] of Object.entries(groups)) {
    members.sort((a, b) => b.n.prio - a.n.prio);
    const act = members[0];
    act.n.addrs.push({ ip: vip, mask: act.g.mask, mac: act.g.vmac, virtual: true, group: act.g.group });
    act.n.vmacs.push(act.g.vmac);
    members.forEach((m) => { m.n.roles[vip] = m === act ? 'Active' : 'Standby'; });
  }
  for (const n of nics) n.domain = n.sw ? `${n.sw}#${n.vlan}` : `p2p#${[n.dev, n.peer].sort().join('~')}`;
  return nics;
}

const lpm = (routes, ip) => {
  let best = null;
  for (const r of routes || []) {
    if (!isIp(r.net) || !isMask(r.mask)) continue;
    if (sameNet(ip, r.net, r.mask) && (!best || cidr(r.mask) > cidr(best.mask))) best = r;
  }
  return best;
};

/* ---------- narrative copy ---------- */
const WHY = {
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
function simulate(topo, flow) {
  const D = topo.devices;
  const nics = buildNics(topo);
  const byDomain = {};
  nics.forEach((n) => (byDomain[n.domain] = byDomain[n.domain] || []).push(n));
  const name = (id) => (D[id] ? D[id].name : id);
  const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

  // switch port names
  const port = {};
  for (const sw of Object.values(D).filter(isSwitch)) {
    let h = 0;
    const rmap = {};
    for (const n of nics.filter((x) => x.sw === sw.id)) {
      if (n.kind === 'host') port[n.id] = `Fa0/${++h}`;
      else {
        if (!rmap[n.dev]) rmap[n.dev] = `Gi0/${Object.keys(rmap).length + 1}`;
        port[n.id] = rmap[n.dev];
      }
    }
  }

  // mutable tables
  const arp = {};
  const macT = {};
  for (const d of Object.values(D)) {
    if (isHost(d) || isRouter(d)) arp[d.id] = clone(d.arpStatic || {});
    if (isSwitch(d)) macT[d.id] = clone(d.macStatic || {});
  }

  const events = [];
  const phases = [];
  let phase = null;
  let t = 0;
  let uid = 0;
  let ipId = 0x1a20;
  let ok = true;
  let failure = null;
  const lastFlat = {};

  const setPhase = (kind, title, why) => {
    phase = { id: phases.length, kind, title, why };
    phases.push(phase);
    return phase;
  };
  const latency = (leg) => {
    const far = [leg.from, leg.to].some((id) => D[id] && (D[id].id === 'sw2' || (isHost(D[id]) && D[id].type === 'server')));
    return far ? 0.006 : 0.002;
  };

  function emit(ev) {
    const flat = ev.flat || {};
    const changed = [];
    if (ev.uid != null && lastFlat[ev.uid]) {
      const prev = lastFlat[ev.uid];
      for (const k of Object.keys({ ...prev, ...flat })) {
        if (prev[k] !== flat[k]) changed.push({ key: k, from: prev[k] ?? 'none', to: flat[k] ?? 'none' });
      }
    }
    if (ev.uid != null) lastFlat[ev.uid] = flat;
    const e = { ...ev, no: events.length + 1, t: Number(t.toFixed(4)), phase: phase ? phase.id : 0, changed, snap: { arp: clone(arp), mac: clone(macT) } };
    events.push(e);
    if (ev.legs && ev.legs.length) t += latency(ev.legs[0]);
    return e;
  }

  function emitDrop(at, title, note, fr) {
    ok = false;
    failure = failure || { at, title };
    return emit({
      drop: true, proto: 'DROP', legs: [], at, osi: fr ? Math.min(3, fr.top || 3) : 3,
      src: fr ? fr.src : name(at), dst: fr ? fr.dst : '', info: title, size: fr ? fr.size : 0,
      layers: fr ? fr.layers : [], flat: {}, tag: `DROP · ${title.toUpperCase()}`, note,
      hop: name(at), meta: fr ? fr.meta : {},
    });
  }

  const L2 = (dst, src, type) => ({
    key: 'l2', n: 2, title: 'Ethernet II', sub: type.split(' · ')[1],
    fields: [['Destination', dst, 'l2.dst'], ['Source', src, 'l2.src'], ['EtherType', type, 'l2.type']],
  });

  function withVlan(fr, vlan) {
    const f = {};
    let layers = fr.layers;
    if (topo.vlans || vlan) {
      const v = vlan ? `VID ${vlan} · tagged` : 'untagged';
      layers = fr.layers.map((L) => (L.key === 'l2' ? { ...L, fields: [L.fields[0], L.fields[1], ['802.1Q', v, 'l2.vlan'], L.fields[2]] } : L));
    }
    for (const L of layers) for (const [, v, k] of L.fields) if (k) f[k] = v;
    return { layers, flat: f, size: fr.size + (vlan ? 4 : 0) };
  }

  const osiAt = (n, fr) => {
    if (!n) return 2;
    if (n.kind === 'host') return fr.top;
    if (fr.ipDst && n.addrs.some((a) => a.ip === fr.ipDst)) return fr.top;
    return Math.min(3, fr.top);
  };

  function l2Send(from, fr) {
    const dom = byDomain[from.domain] || [];
    const others = dom.filter((n) => n !== from);
    const accepts = (n) =>
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
      let targets;
      let mode;
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

  function arpFrame(op, sMac, sIp, dMac, tMac, tIp) {
    const layers = [
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

  function resolve(nic, ip) {
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
        const oa = owner.addrs.find((a) => a.ip === ip);
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

  function ipFrame(pkt, sMac, dMac, nextHop) {
    const ip = pkt.ip;
    const pn = pkt.l4.type === 'TCP' ? '6 · TCP' : pkt.l4.type === 'UDP' ? '17 · UDP' : '1 · ICMP';
    const layers = [
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

  function routerOwns(rid, ip) {
    return nics.some((n) => n.dev === rid && n.addrs.some((a) => a.ip === ip));
  }

  function ipForward(out, pkt, nh, note) {
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
      if (h.ip === pkt.ip.dst) return { ok: true, at: n.dev };
      emitDrop(n.dev, `${h.name} does not route`, `${h.name} received a packet addressed to ${pkt.ip.dst}. End hosts do not forward traffic for others, so it is discarded.`, fr);
      return { ok: false };
    }
    const r = D[n.dev];
    if (routerOwns(r.id, pkt.ip.dst)) return { ok: true, at: r.id };
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
    const np = { ...pkt, ip: { ...pkt.ip, ttl } };
    return ipForward(outN, np, hop, (m) =>
      `${r.name} strips the incoming Ethernet header, decrements TTL ${pkt.ip.ttl} → ${ttl}, and matches ${rt.net}/${cidr(rt.mask)} → ${rt.iface}. It writes a brand new frame: source ${outN.mac} (its ${rt.iface}) and destination ${m} (${hop}). Source and destination IP never change.${n.sw && outN.sw === n.sw && outN.vlan !== n.vlan ? ` The packet leaves on the same physical trunk it arrived on, retagged from VLAN ${n.vlan} to VLAN ${outN.vlan}. This design is called router on a stick.` : ''}`);
  }

  function originate(id, pkt) {
    const d = D[id];
    if (!d || !powered(d)) {
      emitDrop(id, `${name(id)} is powered off`, `${name(id)} cannot send anything without power.`, null);
      return { ok: false };
    }
    if (isRouter(d)) {
      const rt = lpm(d.routes, pkt.ip.dst);
      const outN = rt && nics.find((x) => x.dev === d.id && x.iface === rt.iface);
      if (!outN) {
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
    const dst = pkt.ip.dst;
    const local = sameNet(dst, d.ip, d.mask);
    let nh = dst;
    if (!local) {
      if (!d.gw) {
        emitDrop(id, 'No default gateway', `${dst} is outside ${netOf(d.ip, d.mask)}/${cidr(d.mask)}, so ${d.name} must hand it to a default gateway. None is configured, so the packet never leaves the host.`, null);
        return { ok: false };
      }
      if (!sameNet(d.gw, d.ip, d.mask)) {
        emitDrop(id, 'Gateway outside local subnet', `The gateway ${d.gw} is not inside ${netOf(d.ip, d.mask)}/${cidr(d.mask)}. ARP only works inside the local subnet, so ${d.name} can never reach it.`, null);
        return { ok: false };
      }
      nh = d.gw;
    }
    return ipForward(nic, pkt, nh, (m) =>
      `${d.name} wraps the ${pkt.proto} data in an IP header (${pkt.ip.src} → ${dst}, TTL ${pkt.ip.ttl}) and an Ethernet frame. ${local ? `The destination is on its own subnet, so the frame goes straight to ${m}.` : `The destination is off-subnet, so the frame is addressed to the gateway ${nh} at ${m}.`}`);
  }

  /* ----- packet factories ----- */
  const mkIp = (src, dst) => ({ src, dst, ttl: 64, id: ipId++ });
  const icmp = (src, dst, type, seq) => ({
    uid: ++uid, ip: mkIp(src, dst), proto: 'ICMP', top: 3, size: 98,
    info: `Echo (ping) ${type === 8 ? "request" : "reply"}  id=0x0001, seq=${seq}`,
    tag: type === 8 ? 'ECHO REQUEST' : 'ECHO REPLY',
    l4: { type: 'ICMP', sub: type === 8 ? 'Echo request' : 'Echo reply', fields: [['Type', type === 8 ? '8 · Echo request' : '0 · Echo reply', 'icmp.type'], ['Code', '0', 'icmp.code'], ['Identifier', '0x0001', 'icmp.id'], ['Sequence', String(seq), 'icmp.seq'], ['Payload', '56 bytes', 'icmp.data']] },
  });
  const udp = (sp, dp, len) => ({ type: 'UDP', sub: `${sp} → ${dp}`, fields: [['Source port', String(sp), 'l4.sp'], ['Destination port', String(dp), 'l4.dp'], ['Length', String(len), 'l4.len'], ['Checksum', hx16(`${sp}${dp}${len}`), 'l4.csum']] });
  const tcpL4 = (sp, dp, flags, seq, ack, len) => ({ type: 'TCP', sub: `[${flags}]`, fields: [['Source port', String(sp), 'l4.sp'], ['Destination port', String(dp), 'l4.dp'], ['Flags', flags, 'l4.flags'], ['Sequence', String(seq), 'l4.seq'], ['Acknowledgment', String(ack), 'l4.ack'], ['Window', '64240', 'l4.win'], ['Payload', `${len} bytes`, 'l4.len']] });

  /* ----- flows ----- */
  function hsrpHello(srcId) {
    const src = nics.find((n) => n.dev === srcId);
    if (!src) return;
    const act = (byDomain[src.domain] || []).find((n) => n.kind === 'rif' && n.vmacs.length);
    if (!act) return;
    const vipAddr = act.addrs.find((a) => a.virtual);
    setPhase('hsrp', 'HSRP · ACTIVE ROUTER HELLO', WHY.hsrp(vipAddr.ip, vipAddr.mac));
    const real = act.addrs.find((a) => !a.virtual);
    const pkt = {
      uid: ++uid, ip: { src: real.ip, dst: '224.0.0.2', ttl: 1, id: ipId++ }, proto: 'HSRP', top: 7, size: 62,
      info: `Hello (state Active) group ${vipAddr.group}, VIP ${vipAddr.ip}`, tag: `HELLO · ACTIVE ${name(act.dev)}`,
      l4: udp(1985, 1985, 28),
      l7: { title: 'HSRP', sub: 'Hello', fields: [['Version', '0', 'l7.v'], ['State', 'Active', 'l7.state'], ['Group', String(vipAddr.group), 'l7.grp'], ['Priority', String(act.prio), 'l7.prio'], ['Virtual IP', vipAddr.ip, 'l7.vip'], ['Hello / Hold', '3s / 10s', 'l7.timers']] },
    };
    const fr = ipFrame(pkt, vipAddr.mac, '01:00:5e:00:00:02', '224.0.0.2');
    fr.note = `${name(act.dev)} is the Active HSRP router. It sends a Hello to the all-routers multicast group from the virtual MAC ${vipAddr.mac}, so ${D[src.sw] ? D[src.sw].name : 'the switch'} learns where the virtual gateway lives.`;
    const rx = l2Send(act, fr);
    const sb = rx.filter((n) => n.kind === 'rif' && n !== act).map((n) => name(n.dev));
    if (sb.length) events[events.length - 1].note += ` ${list(sb)} hears the Hello and stays Standby.`;
  }

  function ping(srcId, dstIp) {
    const s = D[srcId];
    setPhase('icmp', `ICMP ECHO · ${s.name} → ${dstIp}`, WHY.ping(s.name, dstIp));
    const r = originate(srcId, icmp(s.ip, dstIp, 8, 1));
    if (!r.ok) return;
    t += 0.001;
    setPhase('icmp', `ICMP REPLY · ${name(r.at)} → ${s.name}`, WHY.pong(name(r.at), s.name));
    originate(r.at, icmp(dstIp, s.ip, 0, 1));
  }

  function dnsLookup(srcId, host) {
    const s = D[srcId];
    const res = s.dns || '8.8.8.8';
    setPhase('dns', `DNS QUERY · A ${host}`, WHY.dnsQ(res, host));
    const q = {
      uid: ++uid, ip: mkIp(s.ip, res), proto: 'DNS', top: 7, size: 74, info: `Standard query 0x4f2a A ${host}`, tag: `QUERY A ${host}`,
      l4: udp(53211, 53, 40),
      l7: { title: 'DNS', sub: 'Query', fields: [['Transaction ID', '0x4f2a', 'l7.id'], ['Flags', '0x0100 · standard query', 'l7.flags'], ['Question', `${host} · A · IN`, 'l7.q'], ['Answer RRs', '0', 'l7.an']] },
    };
    const r = originate(srcId, q);
    if (!r.ok) return null;
    const srv = D[r.at];
    if (!(isHost(srv) && srv.role === 'dns')) {
      emitDrop(r.at, 'UDP port 53 unreachable', `${srv.name} received the query, but it does not run a DNS service.`, null);
      return null;
    }
    const ans = (srv.records || {})[host];
    t += 0.004;
    setPhase('dns', `DNS RESPONSE · ${host} → ${ans || 'NXDOMAIN'}`, WHY.dnsR(host, ans));
    const a = {
      uid: ++uid, ip: mkIp(res, s.ip), proto: 'DNS', top: 7, size: ans ? 90 : 74,
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

  function web(srcId, host) {
    const ip = dnsLookup(srcId, host);
    if (!ip) return;
    const s = D[srcId];
    const tls = !!topo.tls;
    const dp = tls ? 443 : 80;
    const sp = 51544;
    setPhase('tcp', `TCP HANDSHAKE · ${s.name} → ${ip}:${dp}`, WHY.tcp(dp));
    const tcp = (src, dst, a, b, flags, seq, ack, len, extra) => ({
      uid: ++uid, ip: mkIp(src, dst), proto: extra.proto || 'TCP', top: extra.top || 4, size: extra.size || 66 + len,
      info: extra.info || `${a} → ${b} [${flags}] Seq=${seq} Ack=${ack} Len=${len}`, tag: extra.tag || flags,
      l4: tcpL4(a, b, flags, seq, ack, len), l7: extra.l7,
    });
    const syn = originate(srcId, tcp(s.ip, ip, sp, dp, 'SYN', 0, 0, 0, { size: 74, info: `${sp} → ${dp} [SYN] Seq=0 Win=64240 MSS=1460`, tag: 'SYN' }));
    if (!syn.ok) return;
    const srv = D[syn.at];
    t += 0.001;
    if (!(isHost(srv) && srv.role === 'web')) {
      setPhase('tcp', 'CONNECTION REFUSED', WHY.rst(dp));
      originate(syn.at, tcp(ip, s.ip, dp, sp, 'RST, ACK', 0, 1, 0, { tag: 'RST' }));
      ok = false;
      failure = failure || { at: syn.at, title: `Port ${dp} closed` };
      return;
    }
    if (!originate(syn.at, tcp(ip, s.ip, dp, sp, 'SYN, ACK', 0, 1, 0, { size: 74, tag: 'SYN-ACK' })).ok) return;
    if (!originate(srcId, tcp(s.ip, ip, sp, dp, 'ACK', 1, 1, 0, { tag: 'ACK' })).ok) return;
    if (tls) {
      setPhase('tls', 'TLS 1.3 HANDSHAKE', WHY.tls());
      const rec = (sub, f) => ({ title: 'TLS', sub, fields: f });
      if (!originate(srcId, tcp(s.ip, ip, sp, dp, 'PSH, ACK', 1, 1, 517, { proto: 'TLS', top: 7, info: `Client Hello (SNI=${host})`, tag: 'CLIENT HELLO', l7: rec('Client Hello', [['Content type', '22 · Handshake', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Handshake', 'Client Hello', 'l7.hs'], ['Server name', host, 'l7.sni'], ['Key share', 'x25519', 'l7.ks'], ['Cipher suites', 'TLS_AES_128_GCM_SHA256 +2', 'l7.cs']]) })).ok) return;
      t += 0.002;
      if (!originate(syn.at, tcp(ip, s.ip, dp, sp, 'PSH, ACK', 1, 518, 1380, { proto: 'TLS', top: 7, info: 'Server Hello, Change Cipher Spec, Certificate, Finished', tag: 'SERVER HELLO + CERT', l7: rec('Server Hello', [['Content type', '22 · Handshake', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Handshake', 'Server Hello + Certificate', 'l7.hs'], ['Certificate', `CN=${host} · ECDSA P-256`, 'l7.cert'], ['Cipher', 'TLS_AES_128_GCM_SHA256', 'l7.cs']]) })).ok) return;
      if (!originate(srcId, tcp(s.ip, ip, sp, dp, 'PSH, ACK', 518, 1381, 74, { proto: 'TLS', top: 7, info: 'Change Cipher Spec, Finished', tag: 'FINISHED', l7: rec('Finished', [['Content type', '20/22 · CCS, Handshake', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Handshake', 'Finished (encrypted)', 'l7.hs']]) })).ok) return;
      setPhase('tls', 'HTTPS · ENCRYPTED REQUEST AND RESPONSE', WHY.https());
      if (!originate(srcId, tcp(s.ip, ip, sp, dp, 'PSH, ACK', 592, 1381, 412, { proto: 'TLS', top: 7, info: 'Application Data (412 bytes, encrypted)', tag: 'APP DATA · GET', l7: rec('Application Data', [['Content type', '23 · Application Data', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Payload', 'a7 3f 9c 04 e1 6b ... (encrypted)', 'l7.data'], ['Inner request', 'hidden from the network', 'l7.inner']]) })).ok) return;
      t += 0.018;
      originate(syn.at, tcp(ip, s.ip, dp, sp, 'PSH, ACK', 1381, 1004, 1448, { proto: 'TLS', top: 7, info: 'Application Data (1448 bytes, encrypted)', tag: 'APP DATA · 200', l7: rec('Application Data', [['Content type', '23 · Application Data', 'l7.ct'], ['Version', 'TLS 1.3', 'l7.v'], ['Payload', '5e 02 b8 71 0d c4 ... (encrypted)', 'l7.data'], ['Inner response', 'hidden from the network', 'l7.inner']]) }));
    } else {
      setPhase('http', 'HTTP REQUEST · GET /', WHY.httpReq());
      if (!originate(srcId, tcp(s.ip, ip, sp, dp, 'PSH, ACK', 1, 1, 412, { proto: 'HTTP', top: 7, info: 'GET / HTTP/1.1', tag: 'GET / HTTP/1.1', l7: { title: 'HTTP', sub: 'Request', fields: [['Request line', 'GET / HTTP/1.1', 'l7.line'], ['Host', host, 'l7.host'], ['User-Agent', 'Mozilla/5.0 NetTracer', 'l7.ua'], ['Cookie', 'session=8f2c91d0 (readable)', 'l7.cookie']] } })).ok) return;
      t += 0.018;
      setPhase('http', 'HTTP RESPONSE · 200 OK', WHY.httpRes());
      originate(syn.at, tcp(ip, s.ip, dp, sp, 'PSH, ACK', 1, 413, 1448, { proto: 'HTTP', top: 7, info: 'HTTP/1.1 200 OK  (text/html)', tag: '200 OK', l7: { title: 'HTTP', sub: 'Response', fields: [['Status line', 'HTTP/1.1 200 OK', 'l7.line'], ['Content-Type', 'text/html; charset=utf-8', 'l7.ct'], ['Content-Length', '1382', 'l7.len'], ['Body', '<!doctype html><title>NetTracer</title>...', 'l7.body']] } }));
    }
  }

  setPhase('start', 'READY', '');
  const f = flow || {};
  const src = D[f.src];
  if (!src) {
    emitDrop(f.src || 'none', 'Source device missing', 'Pick a source device for this traffic.', null);
  } else if (!powered(src)) {
    emitDrop(src.id, `${src.name} is powered off`, `${src.name} cannot send traffic without power.`, null);
  } else {
    if (topo.hsrp) hsrpHello(f.src);
    if (f.type === 'ping') ping(f.src, f.dst);
    else if (f.type === 'dns') dnsLookup(f.src, f.name || 'nettracer.lab');
    else web(f.src, f.name || 'nettracer.lab');
  }

  const steps = [];
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
function freeIp(topo, near) {
  const used = new Set();
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

function analyze(topo, focus) {
  const D = topo.devices;
  const nics = buildNics(topo, true);
  const hosts = Object.values(D).filter(isHost);
  const routers = Object.values(D).filter(isRouter);
  const issues = [];

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

  const seen = {};
  for (const h of hosts) if (h.uplink && isIp(h.ip)) (seen[h.ip] = seen[h.ip] || []).push(h);
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
  issues.sort((a, b) => (b.tag === focus) - (a.tag === focus) || rank[a.sev] - rank[b.sev]);
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + i.penalty, 0));
  const hardening = [];
  if (topo.vlans) hardening.push('802.1Q · VLAN 10 / 20');
  if (topo.hsrp) hardening.push('HSRP · VIP 192.168.1.1');
  if (topo.tls) hardening.push('TLS 1.3 · HTTPS :443');
  return { issues, score, hardening };
}

function enableHsrp(t) {
  if (t.hsrp || !t.devices.r1) return;
  const r1 = t.devices.r1;
  let g = 1;
  for (const f of r1.ifaces) {
    f.hsrp = f.addrs.map((a) => {
      const grp = g++;
      return { vip: a.ip, mask: a.mask, group: grp, vmac: `00:00:0c:07:ac:${grp.toString(16).padStart(2, '0')}` };
    });
    f.addrs = f.addrs.map((a) => ({ ip: withHost(a.ip, 2), mask: a.mask }));
  }
  const r2 = clone(r1);
  Object.assign(r2, { id: 'r2', name: 'R2', label: 'Standby Router', priority: 100, power: true, arpStatic: {}, pos: [r1.pos[0], r1.pos[1] - 6.0] });
  r2.ifaces.forEach((f, i) => {
    f.mac = `00:1e:7a:c2:00:0${i + 1}`;
    f.addrs = f.addrs.map((a) => ({ ip: withHost(a.ip, 3), mask: a.mask }));
  });
  r1.priority = 110;
  t.devices.r2 = r2;
  t.hsrp = true;
}

function enableVlans(t) {
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
    const idx = r.ifaces.findIndex((f) => f.peer === 'sw1' && (Number(f.vlan) || 1) === 1);
    if (idx < 0) continue;
    const f = r.ifaces[idx];
    const hn = hostPart(f.addrs[0].ip);
    const s10 = { ...f, name: `${f.name}.10`, vlan: 10 };
    const s20 = {
      name: `${f.name}.20`, mac: f.mac, peer: 'sw1', vlan: 20,
      addrs: [{ ip: withHost('192.168.20.0', hn), mask: M24 }],
      hsrp: f.hsrp && f.hsrp.length ? [{ vip: '192.168.20.1', mask: M24, group: 20, vmac: '00:00:0c:07:ac:14' }] : [],
    };
    r.ifaces.splice(idx, 1, s10, s20);
    r.routes = r.routes.map((rt) => (rt.iface === f.name ? { ...rt, iface: s10.name } : rt));
    r.routes.push({ net: '192.168.20.0', mask: M24, iface: s20.name, via: '', type: 'C' });
  }
  t.vlans = true;
}

function applyFix(topo, fix) {
  const t = clone(topo);
  const D = t.devices;
  if (fix.type === 'set') Object.assign(D[fix.id], fix.patch);
  else if (fix.type === 'route') D[fix.router].routes.push(fix.route);
  else if (fix.type === 'tls') t.tls = true;
  else if (fix.type === 'vlans') enableVlans(t);
  else if (fix.type === 'hsrp') enableHsrp(t);
  return t;
}

/* ---------- topology edit helpers ---------- */
function editIface(topo, rid, ifName, ip, mask) {
  const t = clone(topo);
  const r = t.devices[rid];
  const f = r.ifaces.find((x) => x.name === ifName);
  const old = f.addrs[0];
  const oldNet = isIp(old.ip) && isMask(old.mask) ? netOf(old.ip, old.mask) : null;
  f.addrs[0] = { ip, mask };
  if (isIp(ip) && isMask(mask)) {
    const newNet = netOf(ip, mask);
    const i = r.routes.findIndex((rt) => rt.type === 'C' && rt.iface === ifName && rt.net === oldNet);
    if (i >= 0) r.routes[i] = { ...r.routes[i], net: newNet, mask };
  }
  return t;
}

let devCounter = 0;
function addHost(topo, kind) {
  const t = clone(topo);
  const D = t.devices;
  devCounter += 1;
  const sw = kind === 'server' ? 'sw2' : 'sw1';
  const peers = Object.values(D).filter((d) => isHost(d) && d.uplink === sw && powered(d));
  const ref = peers.find((p) => (Number(p.vlan) || 1) !== 20) || peers[0];
  const baseIp = ref ? ref.ip : kind === 'server' ? '203.0.113.10' : '192.168.1.10';
  const letters = 'DEFGHIJKLMNOPQRSTUVWXYZ';
  const n = Object.values(D).filter((d) => d.type === (kind === 'server' ? 'server' : 'laptop')).length;
  const id = `${kind === 'server' ? 'srv' : 'pc'}${Date.now().toString(36)}${devCounter}`;
  const swPos = D[sw] ? D[sw].pos : [0, 0];
  const count = Object.values(D).filter((d) => isHost(d) && d.uplink === sw).length;
  const slots = kind === 'server'
    ? [[5.6, 6.4], [14, 0.2], [14.2, 6.4], [5.6, -6.6], [14.2, -6.4]]
    : [[-7.4, 6.4], [-3.6, 6.6], [-15.2, 6.4], [-15.6, 0.2], [-7.4, -6.4], [-15.2, -6.4]];
  const taken = (p) => Object.values(D).some((x) => x.pos && Math.hypot(x.pos[0] - p[0], x.pos[1] - p[1]) < 2.2);
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

function removeDevice(topo, id) {
  const t = clone(topo);
  delete t.devices[id];
  for (const d of Object.values(t.devices)) if (d.uplink === id) d.uplink = '';
  return t;
}
/* =====================================================================
   2 · THREE.JS ISOMETRIC STAGE
   Low-FOV (28°) telephoto camera, matte procedural hardware,
   floor splines, capsule packets, exploded OSI stack.
   ===================================================================== */

const STAGE_YAW = Math.PI / 4 + 0.13;
const CAM_DIR = new THREE.Vector3(22, 20, 22).normalize();
const easeIO = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DEVICE_ACCENT = { laptop: '#06B6D4', router: '#3B82F6', switch: '#94A3B8', dns: '#F59E0B', web: '#10B981', server: '#10B981' };
const accentOf = (d) => (d.type === 'server' ? DEVICE_ACCENT[d.role] || DEVICE_ACCENT.server : DEVICE_ACCENT[d.type] || '#94A3B8');
const LAYER_COLOR = { l2: '#94A3B8', arp: PROTO_COLOR.ARP, l3: '#818CF8', icmp: PROTO_COLOR.ICMP, TCP: '#3B82F6', UDP: '#60A5FA' };
const layerColor = (L, ev) => (L.key === 'l7' ? PROTO_COLOR[ev.proto] || '#10B981' : L.key === 'l4' ? LAYER_COLOR[L.title] || '#60A5FA' : LAYER_COLOR[L.key] || '#94A3B8');

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function radialTex(stops) {
  return canvasTex(256, 256, (g) => {
    const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    g.fillStyle = gr;
    g.fillRect(0, 0, 256, 256);
  });
}

function drawScreen(g, w, h, kind, seed, on) {
  g.fillStyle = '#07090D';
  g.fillRect(0, 0, w, h);
  if (!on) return;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#10141D';
  g.fillRect(0, 0, w, 42);
  ['#F43F5E', '#F59E0B', '#10B981'].forEach((c, i) => {
    g.fillStyle = c;
    g.globalAlpha = 0.75;
    g.beginPath();
    g.arc(24 + i * 18, 21, 5, 0, 7);
    g.fill();
  });
  g.globalAlpha = 1;
  g.fillStyle = '#1A2030';
  roundRect(g, 92, 12, w - 184, 19, 9);
  g.fill();
  g.fillStyle = '#6B7486';
  g.font = '500 13px monospace';
  g.fillText(kind === 'browser' ? 'nettracer.lab' : '~/net $ tcpdump -i eth0', 106, 26);
  if (kind === 'browser') {
    g.fillStyle = '#10B981';
    g.globalAlpha = 0.9;
    roundRect(g, 30, 70, 170, 16, 4);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#283043';
    for (let i = 0; i < 4; i++) {
      roundRect(g, 30, 102 + i * 22, 170 + rnd() * 250, 9, 4);
      g.fill();
    }
    g.fillStyle = '#151B28';
    roundRect(g, 30, 200, w - 60, 92, 8);
    g.fill();
    g.fillStyle = '#3B82F6';
    g.globalAlpha = 0.85;
    roundRect(g, 46, 218, 96, 12, 5);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#283043';
    roundRect(g, 46, 244, 280, 8, 4);
    g.fill();
    roundRect(g, 46, 262, 200, 8, 4);
    g.fill();
  } else {
    const cols = ['#06B6D4', '#F59E0B', '#10B981', '#6366F1', '#9CA3AF'];
    for (let i = 0; i < 10; i++) {
      const y = 62 + i * 25;
      g.fillStyle = cols[Math.floor(rnd() * cols.length)];
      g.globalAlpha = 0.8;
      roundRect(g, 28, y, 30 + rnd() * 34, 9, 3);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = '#2A3142';
      roundRect(g, 74 + rnd() * 26, y, 90 + rnd() * 270, 9, 3);
      g.fill();
    }
  }
}

function labelHTML(d) {
  const on = powered(d);
  let ip = d.ip;
  if (d.type === 'switch') ip = d.name;
  if (d.type === 'router') {
    const f = (d.ifaces || [])[0];
    const vip = f && f.hsrp && f.hsrp[0];
    ip = `${d.name} · ${f ? f.addrs[0].ip : ''}${vip ? ` → VIP ${vip.vip}` : ''}`;
  }
  const lbl = d.type === 'laptop' ? `${d.label} ${d.name}` : d.label;
  return `<span class="nt-dot" style="background:${on ? accentOf(d) : '#F43F5E'}"></span><span class="nt-l">${escHtml(lbl)}</span><span class="nt-s">·</span><span class="nt-ip">${escHtml(ip)}</span>${on ? '' : '<span class="nt-off">OFF</span>'}${(Number(d.vlan) || 1) !== 1 && d.uplink === 'sw1' ? `<span class="nt-vlan">VLAN ${d.vlan}</span>` : ''}`;
}

function buildDevice(d, shared, linkCount) {
  const g = new THREE.Group();
  const on = powered(d);
  const trash = [];
  const M = (color, rough = 0.6, metal = 0.2, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
    trash.push(m);
    return m;
  };
  const Basic = (color, extra = {}) => {
    const m = new THREE.MeshBasicMaterial({ color, ...extra });
    trash.push(m);
    return m;
  };
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = g, shadow = true) => {
    trash.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.userData.pick = true;
    parent.add(mesh);
    return mesh;
  };
  const RB = (w, h, dd, r, seg = 4) => new RoundedBoxGeometry(w, h, dd, seg, r);
  const leds = [];
  let height = 1;
  let foot = [2, 1.4];
  let radius = 1.2;
  const ledOn = (c) => (on ? c : '#2A2D35');

  if (d.type === 'laptop') {
    const alu = M('#C6CBD3', 0.5, 0.3);
    add(RB(2.1, 0.11, 1.46, 0.05), alu, 0, 0.055, 0);
    add(new THREE.BoxGeometry(1.84, 0.012, 0.64), M('#262A33', 0.85, 0.1), 0, 0.111, -0.17);
    const keyGeo = new THREE.BoxGeometry(0.112, 0.018, 0.098);
    trash.push(keyGeo);
    const keys = new THREE.InstancedMesh(keyGeo, M('#15181F', 0.7, 0.1), 52);
    const m4 = new THREE.Matrix4();
    let k = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 13; c++) {
      m4.makeTranslation(-0.79 + c * 0.132, 0.122, -0.42 + r * 0.128);
      keys.setMatrixAt(k++, m4);
    }
    keys.userData.pick = true;
    keys.castShadow = true;
    g.add(keys);
    add(new THREE.BoxGeometry(0.64, 0.006, 0.36), M('#9EA4AF', 0.38, 0.35), 0, 0.112, 0.44, g, false);
    const lid = new THREE.Group();
    lid.position.set(0, 0.11, -0.71);
    lid.rotation.x = -0.27;
    g.add(lid);
    add(RB(2.1, 1.36, 0.06, 0.035), alu, 0, 0.69, 0, lid);
    add(new THREE.BoxGeometry(2.02, 1.28, 0.008), M('#06070A', 0.5, 0.1), 0, 0.69, 0.032, lid, false);
    const tex = canvasTex(512, 320, (gg, w, h) => drawScreen(gg, w, h, d.role === 'client' && d.id === 'pcA' ? 'browser' : 'term', d.mac.length + d.mac.charCodeAt(d.mac.length - 1), on));
    trash.push(tex);
    add(new THREE.PlaneGeometry(1.88, 1.12), Basic('#ffffff', { map: tex, toneMapped: false }), 0, 0.71, 0.037, lid, false);
    leds.push(add(new THREE.SphereGeometry(0.018, 8, 8), Basic(ledOn('#10B981')), 0.9, 0.06, 0.735, g, false).material);
    height = 1.55;
    foot = [2.1, 1.6];
    radius = 1.25;
  } else if (d.type === 'router') {
    const body = M('#30343F', 0.6, 0.2);
    add(RB(2.2, 0.48, 1.32, 0.14, 5), body, 0, 0.24, 0);
    add(RB(1.86, 0.02, 0.98, 0.01, 2), M('#3A3F4B', 0.5, 0.25), 0, 0.478, 0.02);
    add(new THREE.BoxGeometry(1.5, 0.045, 0.012), M('#0A0B0F', 0.9, 0.05), 0.12, 0.2, 0.661, g, false);
    ['#10B981', '#10B981', '#06B6D4', '#F59E0B'].forEach((c, i) => {
      leds.push(add(new THREE.SphereGeometry(0.028, 10, 10), Basic(ledOn(c)), -0.82 + i * 0.12, 0.32, 0.655, g, false).material);
    });
    add(new THREE.BoxGeometry(0.24, 0.03, 0.01), M('#5A6070', 0.4, 0.4), 0.78, 0.33, 0.662, g, false);
    const antMat = M('#262A33', 0.55, 0.2);
    [-0.72, 0, 0.72].forEach((x, i) => {
      add(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 16), antMat, x, 0.52, -0.5);
      const a = add(new THREE.CapsuleGeometry(0.042, 1.02, 4, 10), antMat, x + (i - 1) * 0.08, 1.08, -0.52);
      a.rotation.z = -(i - 1) * 0.12;
    });
    for (let i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.17, 0.11, 0.03), M('#07080B', 0.9), -0.6 + i * 0.26, 0.24, -0.655, g, false);
    height = 1.85;
    foot = [2.2, 1.5];
    radius = 1.3;
  } else if (d.type === 'switch') {
    add(RB(2.9, 0.3, 1.16, 0.05), M('#454B58', 0.42, 0.45), 0, 0.15, 0);
    add(new THREE.BoxGeometry(2.42, 0.21, 0.01), M('#161A22', 0.7, 0.2), -0.08, 0.15, 0.582, g, false);
    const pGeo = new THREE.BoxGeometry(0.125, 0.064, 0.03);
    const lGeo = new THREE.BoxGeometry(0.036, 0.016, 0.01);
    trash.push(pGeo, lGeo);
    const ports = new THREE.InstancedMesh(pGeo, M('#040507', 0.95, 0), 24);
    const lmat = Basic('#ffffff');
    const ledsI = new THREE.InstancedMesh(lGeo, lmat, 24);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let r = 0; r < 2; r++) for (let c = 0; c < 12; c++) {
      const i = r * 12 + c;
      const x = -1.16 + c * 0.172;
      m4.makeTranslation(x, r ? 0.106 : 0.192, 0.575);
      ports.setMatrixAt(i, m4);
      m4.makeTranslation(x, r ? 0.06 : 0.239, 0.586);
      ledsI.setMatrixAt(i, m4);
      const used = r === 0 && c < linkCount;
      ledsI.setColorAt(i, col.set(on && used ? (c === linkCount - 1 ? '#F59E0B' : '#22C55E') : '#1C2028'));
    }
    ports.userData.pick = true;
    g.add(ports, ledsI);
    leds.push(add(new THREE.SphereGeometry(0.022, 8, 8), Basic(ledOn('#22C55E')), 1.27, 0.2, 0.585, g, false).material);
    add(new THREE.BoxGeometry(0.16, 0.06, 0.02), M('#0B0D12', 0.9), 1.27, 0.1, 0.585, g, false);
    height = 0.75;
    foot = [2.9, 1.3];
    radius = 1.6;
  } else {
    const accent = accentOf(d);
    add(RB(1.16, 2.3, 1.26, 0.08), M('#2B303A', 0.6, 0.22), 0, 1.15, 0);
    add(new THREE.BoxGeometry(0.96, 2.06, 0.01), M('#161920', 0.75, 0.2), 0.04, 1.15, 0.632, g, false);
    for (let i = 0; i < 6; i++) {
      const y = 0.38 + i * 0.3;
      add(new THREE.BoxGeometry(0.8, 0.18, 0.03), M('#090B10', 0.85, 0.05), 0.06, y, 0.625, g, false);
      add(new THREE.BoxGeometry(0.5, 0.018, 0.006), M('#2D323E', 0.5, 0.3), 0, y, 0.642, g, false);
      leds.push(add(new THREE.SphereGeometry(0.022, 8, 8), Basic(ledOn(i === 0 ? accent : i % 3 === 2 ? '#F59E0B' : '#22C55E')), 0.37, y, 0.645, g, false).material);
    }
    add(new THREE.BoxGeometry(0.03, 1.92, 0.006), Basic(on ? accent : '#2A2D35'), -0.45, 1.15, 0.64, g, false);
    for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(0.8, 0.012, 0.05), M('#0C0E13', 0.9), 0, 2.302, -0.36 + i * 0.18, g, false);
    height = 2.7;
    foot = [1.3, 1.4];
    radius = 0.95;
  }

  const contact = new THREE.Mesh(new THREE.PlaneGeometry(foot[0] * 1.9, foot[1] * 2.1), new THREE.MeshBasicMaterial({ map: shared.contact, transparent: true, depthWrite: false, opacity: 0.85 }));
  trash.push(contact.geometry, contact.material);
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.006;
  g.add(contact);

  const ringMat = new THREE.MeshBasicMaterial({ color: '#F3F4F6', transparent: true, opacity: 0, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 1.12, radius * 1.12 + 0.045, 80), ringMat);
  const aringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false });
  const aring = new THREE.Mesh(new THREE.RingGeometry(radius * 1.24, radius * 1.24 + 0.12, 80), aringMat);
  [ring, aring].forEach((r) => {
    trash.push(r.geometry, r.material);
    r.rotation.x = -Math.PI / 2;
    r.position.y = 0.012;
    g.add(r);
  });

  const el = document.createElement('div');
  el.className = 'nt-pill';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1);
  label.position.set(0, height + 0.25, 0);
  g.add(label);

  g.traverse((o) => { o.userData.devId = d.id; });
  const S = 1.28;
  g.scale.setScalar(S);
  return {
    group: g, ring, aring, label, el, leds, height: height * S, radius: radius * S, on, k: 0, hk: 0,
    dispose() {
      trash.forEach((x) => x.dispose && x.dispose());
      el.remove();
    },
  };
}

function linksOf(topo) {
  const D = topo.devices;
  const out = [];
  const seen = new Set();
  const add = (a, b) => {
    const k = [a, b].sort().join('|');
    if (!seen.has(k) && D[a] && D[b]) {
      seen.add(k);
      out.push({ key: k, a, b });
    }
  };
  for (const d of Object.values(D)) {
    if (isHost(d) && d.uplink) add(d.id, d.uplink);
    if (isRouter(d)) for (const f of d.ifaces || []) add(d.id, f.peer);
  }
  return out;
}

function buildCable(link, ea, eb) {
  const pa = ea.group.position;
  const pb = eb.group.position;
  const a = new THREE.Vector3(pa.x, 0.05, pa.z);
  const b = new THREE.Vector3(pb.x, 0.05, pb.z);
  const dir = b.clone().sub(a).normalize();
  a.addScaledVector(dir, ea.radius * 0.95);
  b.addScaledVector(dir, -eb.radius * 0.95);
  const L = a.distanceTo(b);
  const perp = new THREE.Vector3(-dir.z, 0, dir.x);
  const k = Math.min(0.75, L * 0.07);
  const c1 = a.clone().addScaledVector(dir, L * 0.35).addScaledVector(perp, k);
  const c2 = a.clone().addScaledVector(dir, L * 0.65).addScaledVector(perp, -k);
  const curve = new THREE.CubicBezierCurve3(a, c1, c2, b);
  const obj = new THREE.Group();
  const geo = new THREE.TubeGeometry(curve, 80, 0.042, 8, false);
  const mat = new THREE.MeshStandardMaterial({ color: '#2C323E', roughness: 0.55, metalness: 0.3, emissive: '#000000' });
  const tube = new THREE.Mesh(geo, mat);
  tube.castShadow = true;
  tube.receiveShadow = true;
  const ggeo = new THREE.TubeGeometry(curve, 80, 0.13, 10, false);
  const gmat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const glow = new THREE.Mesh(ggeo, gmat);
  const plugGeo = new THREE.BoxGeometry(0.13, 0.09, 0.22);
  const plugMat = new THREE.MeshStandardMaterial({ color: '#3A404D', roughness: 0.5, metalness: 0.3 });
  [[a, dir], [b, dir.clone().negate()]].forEach(([p, d]) => {
    const plug = new THREE.Mesh(plugGeo, plugMat);
    plug.position.set(p.x, 0.06, p.z);
    plug.rotation.y = Math.atan2(d.x, d.z);
    plug.castShadow = true;
    obj.add(plug);
  });
  obj.add(tube, glow);
  return {
    key: link.key, a: link.a, b: link.b, curve, obj, mat, gmat, k: 0, col: new THREE.Color('#ffffff'),
    dispose() { [geo, mat, ggeo, gmat, plugGeo, plugMat].forEach((x) => x.dispose()); },
  };
}

function makePacket(shared) {
  const g = new THREE.Group();
  const orient = new THREE.Group();
  g.add(orient);
  const capMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, metalness: 0.1, emissive: '#ffffff', emissiveIntensity: 0.45 });
  const cap = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.46, 6, 18), capMat);
  cap.rotation.x = Math.PI / 2;
  cap.castShadow = true;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.158, 0.158, 0.07, 24), new THREE.MeshStandardMaterial({ color: '#EDEFF3', roughness: 0.35, metalness: 0.2 }));
  band.rotation.x = Math.PI / 2;
  orient.add(cap, band);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: shared.glow, color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }));
  halo.scale.set(1.6, 1.6, 1);
  g.add(halo);
  const stack = new THREE.Group();
  g.add(stack);
  const slabGeo = new RoundedBoxGeometry(0.9, 0.13, 0.62, 3, 0.045);
  const slabs = [0, 1, 2, 3].map(() => {
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.45, metalness: 0.1, transparent: true, opacity: 0.96, emissive: '#000000', emissiveIntensity: 0.35 });
    const mesh = new THREE.Mesh(slabGeo, mat);
    mesh.castShadow = true;
    stack.add(mesh);
    const el = document.createElement('div');
    el.className = 'nt-layer';
    const lab = new CSS2DObject(el);
    lab.center.set(1, 0.5);
    lab.position.set(-0.55, 0, 0);
    mesh.add(lab);
    return { mesh, mat, el, lab };
  });
  const tagEl = document.createElement('div');
  tagEl.className = 'nt-tag';
  const tag = new CSS2DObject(tagEl);
  tag.center.set(0.5, 1);
  g.add(tag);
  g.visible = false;
  return { g, orient, cap, capMat, halo, stack, slabs, tag, tagEl, key: null, nLayers: 0 };
}

function createStage(container, live, cb) {
  let W = Math.max(1, container.clientWidth);
  let H = Math.max(1, container.clientHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.outline = 'none';
  container.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(W, H);
  Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
  container.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0C0E14');
  scene.fog = new THREE.Fog('#0C0E14', 80, 170);
  const camera = new THREE.PerspectiveCamera(28, W / H, 0.5, 400);
  camera.position.copy(CAM_DIR).multiplyScalar(60);
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 14, maxDistance: 130, maxPolarAngle: 1.3, minPolarAngle: 0.2, rotateSpeed: 0.55, zoomSpeed: 0.8, panSpeed: 0.7 });

  scene.add(new THREE.HemisphereLight('#E9EEFF', '#11141C', 1.5));
  const key = new THREE.DirectionalLight('#ffffff', 2.6);
  key.position.set(12, 30, 18);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 90 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 3;
  scene.add(key);
  const fill = new THREE.DirectionalLight('#A9BCFF', 0.75);
  fill.position.set(-20, 12, -6);
  scene.add(fill);
  const rim = new THREE.DirectionalLight('#FFE9CC', 0.55);
  rim.position.set(-8, 9, 24);
  scene.add(rim);

  const shared = {
    contact: radialTex([[0, 'rgba(0,0,0,0.55)'], [0.45, 'rgba(0,0,0,0.28)'], [1, 'rgba(0,0,0,0)']]),
    glow: radialTex([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]),
  };

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ color: '#090A0F', roughness: 1, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.45;
  floor.receiveShadow = true;
  scene.add(floor);

  const stage = new THREE.Group();
  stage.rotation.y = STAGE_YAW;
  scene.add(stage);
  const PL = { cx: -0.6, cz: -0.5, w: 32, d: 18.4 };
  const plate = new THREE.Mesh(new RoundedBoxGeometry(PL.w, 0.44, PL.d, 4, 0.32), new THREE.MeshStandardMaterial({ color: '#131720', roughness: 0.92, metalness: 0.05 }));
  plate.position.set(PL.cx, -0.22, PL.cz);
  plate.receiveShadow = true;
  plate.castShadow = true;
  stage.add(plate);
  const gridLines = (step, opacity) => {
    const pts = [];
    const x0 = PL.cx - PL.w / 2 + 0.5;
    const x1 = PL.cx + PL.w / 2 - 0.5;
    const z0 = PL.cz - PL.d / 2 + 0.5;
    const z1 = PL.cz + PL.d / 2 - 0.5;
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) pts.push(x, 0.003, z0, x, 0.003, z1);
    for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) pts.push(x0, 0.003, z, x1, 0.003, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity, depthWrite: false }));
  };
  stage.add(gridLines(1, 0.03), gridLines(4, 0.06));

  const entries = {};
  let cables = {};
  let topoRef = null;
  const pick = [];
  const packets = Array.from({ length: 6 }, () => {
    const p = makePacket(shared);
    stage.add(p.g);
    return p;
  });

  const ghostMat = new THREE.MeshStandardMaterial({ color: '#94A3B8', roughness: 0.5, transparent: true, opacity: 0, depthWrite: false });
  const ghost = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.13, 0.62, 3, 0.045), ghostMat);
  const ghostEl = document.createElement('div');
  ghostEl.className = 'nt-layer nt-ghost';
  ghostEl.textContent = 'OLD L2 FRAME';
  const ghostLab = new CSS2DObject(ghostEl);
  ghostLab.center.set(0, 0.5);
  ghostLab.position.set(0.55, 0, 0);
  ghost.add(ghostLab);
  ghost.visible = false;
  stage.add(ghost);

  const hopEl = document.createElement('div');
  hopEl.className = 'nt-hop';
  const hopTag = new CSS2DObject(hopEl);
  hopTag.center.set(0.5, 1);
  hopTag.visible = false;
  stage.add(hopTag);

  const dropG = new THREE.Group();
  const dropMat = new THREE.MeshBasicMaterial({ color: PROTO_COLOR.DROP, transparent: true, opacity: 0.95 });
  const barGeo = new RoundedBoxGeometry(0.95, 0.12, 0.12, 2, 0.04);
  const b1 = new THREE.Mesh(barGeo, dropMat);
  const b2 = new THREE.Mesh(barGeo, dropMat);
  b1.rotation.z = Math.PI / 4;
  b2.rotation.z = -Math.PI / 4;
  const xg = new THREE.Group();
  xg.add(b1, b2);
  dropG.add(xg);
  const dropEl = document.createElement('div');
  dropEl.className = 'nt-drop';
  const dropTag = new CSS2DObject(dropEl);
  dropTag.center.set(0.5, 1);
  dropTag.position.set(0, 0.75, 0);
  dropG.add(dropTag);
  dropG.visible = false;
  stage.add(dropG);

  const cableFor = (a, b) => cables[[a, b].sort().join('|')];

  function rebuildCables() {
    for (const c of Object.values(cables)) {
      stage.remove(c.obj);
      c.dispose();
    }
    cables = {};
    if (!topoRef) return;
    for (const l of linksOf(topoRef)) {
      const ea = entries[l.a];
      const eb = entries[l.b];
      if (!ea || !eb) continue;
      cables[l.key] = buildCable(l, ea, eb);
      stage.add(cables[l.key].obj);
    }
    for (const p of packets) p.key = null;
  }

  let drag = null;
  function sync(topo, selected) {
    topoRef = topo;
    const D = topo.devices;
    const links = linksOf(topo);
    for (const id of Object.keys(entries)) {
      if (!D[id]) {
        stage.remove(entries[id].group);
        entries[id].dispose();
        delete entries[id];
      }
    }
    for (const d of Object.values(D)) {
      const lc = links.filter((l) => l.a === d.id || l.b === d.id).length;
      const sig = `${d.type}|${powered(d)}|${d.role || ''}|${lc}|${d.id === 'pcA'}`;
      let e = entries[d.id];
      if (e && e.sig !== sig) {
        stage.remove(e.group);
        e.dispose();
        e = null;
      }
      if (!e) {
        e = buildDevice(d, shared, lc);
        e.sig = sig;
        entries[d.id] = e;
        stage.add(e.group);
      }
      if (!(drag && drag.id === d.id)) e.group.position.set(d.pos[0], 0, d.pos[1]);
      e.el.innerHTML = labelHTML(d);
      e.selected = selected === d.id;
    }
    rebuildCables();
    pick.length = 0;
    Object.values(entries).forEach((e) => e.group.traverse((o) => { if (o.userData.pick) pick.push(o); }));
  }

  let tween = null;
  let fitted = false;
  function fit(animate = true, intro = false) {
    const ents = Object.values(entries);
    if (!ents.length || W < 10 || H < 10) return;
    stage.updateMatrixWorld(true);
    const pts = [];
    ents.forEach((e) => {
      const p = e.group.position;
      [[-1.4, 0, -1.4], [1.4, 0, 1.4], [-1.4, 0, 1.4], [1.4, 0, -1.4], [0, e.height + 0.9, 0]].forEach((o) => pts.push(stage.localToWorld(new THREE.Vector3(p.x + o[0], o[1], p.z + o[2]))));
    });
    const box = new THREE.Box3().setFromPoints(pts);
    const center = box.getCenter(new THREE.Vector3());
    center.y = 0.4;
    const cam = camera.clone();
    cam.aspect = W / H;
    cam.updateProjectionMatrix();
    let lo = 6;
    let hi = 260;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      cam.position.copy(center).addScaledVector(CAM_DIR, mid);
      cam.lookAt(center);
      cam.updateMatrixWorld();
      const fits = pts.every((p) => {
        const q = p.clone().project(cam);
        return Math.abs(q.x) < 0.93 && q.y < 0.72 && q.y > -0.92;
      });
      if (fits) hi = mid;
      else lo = mid;
    }
    const toPos = center.clone().addScaledVector(CAM_DIR, hi);
    if (intro) camera.position.copy(center).addScaledVector(CAM_DIR, hi * 1.45).add(new THREE.Vector3(-6, 4, 6));
    if (!animate && !intro) {
      camera.position.copy(toPos);
      controls.target.copy(center);
      controls.update();
      return;
    }
    if (intro) controls.target.copy(center);
    tween = { t: 0, dur: intro ? 1.6 : 0.9, fromPos: camera.position.clone(), toPos, fromT: controls.target.clone(), toT: center };
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let down = null;
  let hoverId = null;
  const setRay = (evt) => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((evt.clientX - r.left) / r.width) * 2 - 1, -((evt.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const hit = (evt) => {
    setRay(evt);
    const h = ray.intersectObjects(pick, false)[0];
    return h ? h.object.userData.devId : null;
  };
  const onDown = (evt) => {
    const id = hit(evt);
    down = { x: evt.clientX, y: evt.clientY, id };
    if (live.mode === 'sandbox' && id && entries[id]) {
      drag = { id, moved: false, pos: null };
      controls.enabled = false;
      renderer.domElement.style.cursor = 'grabbing';
    }
  };
  const onMove = (evt) => {
    if (drag) {
      if (Math.hypot(evt.clientX - down.x, evt.clientY - down.y) < 4 && !drag.moved) return;
      setRay(evt);
      const pt = new THREE.Vector3();
      if (!ray.ray.intersectPlane(ground, pt)) return;
      const lp = stage.worldToLocal(pt);
      const x = THREE.MathUtils.clamp(Math.round(lp.x * 4) / 4, PL.cx - PL.w / 2 + 1.4, PL.cx + PL.w / 2 - 1.4);
      const z = THREE.MathUtils.clamp(Math.round(lp.z * 4) / 4, PL.cz - PL.d / 2 + 1.4, PL.cz + PL.d / 2 - 1.4);
      entries[drag.id].group.position.set(x, 0, z);
      drag.pos = [x, z];
      drag.moved = true;
      rebuildCables();
      return;
    }
    hoverId = hit(evt);
    renderer.domElement.style.cursor = hoverId ? (live.mode === 'sandbox' ? 'grab' : 'pointer') : '';
  };
  const onUp = (evt) => {
    if (drag) {
      controls.enabled = true;
      const d = drag;
      drag = null;
      renderer.domElement.style.cursor = '';
      if (d.moved && d.pos) cb.onMove(d.id, d.pos);
      else cb.onSelect(d.id);
      down = null;
      return;
    }
    if (down && Math.hypot(evt.clientX - down.x, evt.clientY - down.y) < 5) cb.onSelect(hit(evt));
    down = null;
  };
  const onLeave = () => { hoverId = null; };
  const cvs = renderer.domElement;
  cvs.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cvs.addEventListener('pointerleave', onLeave);

  const ro = new ResizeObserver(() => {
    W = Math.max(1, container.clientWidth);
    H = Math.max(1, container.clientHeight);
    renderer.setSize(W, H);
    labels.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    if (!fitted && Object.keys(entries).length) {
      fitted = true;
      fit(true, true);
    }
  });
  ro.observe(container);

  let last = performance.now();
  const tmpCol = new THREE.Color();
  let raf = 0;
  let time = 0;

  function advance(dt) {
    const evs = live.events;
    if (!evs.length) return;
    const ev = evs[Math.min(live.idx, evs.length - 1)];
    const dur = (ev.drop ? 1.25 : ev.legs.length > 1 ? 1.05 : 0.9) / live.speed;
    if (!(live.playing || live.stepping)) return;
    if (live.progress < 1) {
      live.progress = Math.min(1, live.progress + dt / dur);
      return;
    }
    if (!live.playing) {
      live.stepping = false;
      return;
    }
    live.hold += dt;
    if (live.hold < 0.2 / live.speed) return;
    live.hold = 0;
    if (live.idx < evs.length - 1) {
      live.idx += 1;
      live.progress = 0;
      cb.onIndex(live.idx);
    } else {
      live.playing = false;
      cb.onPlaying(false);
    }
  }

  function update(dt) {
    const evs = live.events;
    const ev = evs.length ? evs[Math.min(live.idx, evs.length - 1)] : null;
    const e = easeIO(live.progress);
    packets.forEach((p) => { p.g.visible = false; });
    ghost.visible = false;
    hopTag.visible = false;
    dropG.visible = false;
    const activeCables = {};
    const activeDevs = new Set();
    const col = new THREE.Color(ev ? PROTO_COLOR[ev.proto] || '#ffffff' : '#ffffff');

    if (ev && ev.drop) {
      const en = entries[ev.at];
      if (en) {
        dropG.visible = true;
        const p = en.group.position;
        dropG.position.set(p.x, en.height + 0.9 + Math.sin(time * 3) * 0.06, p.z);
        const s = 0.85 + easeOut(Math.min(1, live.progress * 2.2)) * 0.25;
        xg.scale.set(s, s, s);
        xg.rotation.y = time * 0.8;
        if (live.progress > 0.02) dropEl.innerHTML = `<b>DROP</b> · ${escHtml(ev.info)}`;
        activeDevs.add(ev.at);
      }
    } else if (ev) {
      if (ev.flood) ev.legs.forEach((l) => activeDevs.add(l.to));
      else activeDevs.add(ev.at);
      const rewrite = ev.changed.some((c) => c.key === 'l2.src');
      const vlanChange = !rewrite && ev.changed.some((c) => c.key === 'l2.vlan');
      ev.legs.forEach((leg, i) => {
        const pk = packets[i];
        const c = cableFor(leg.from, leg.to);
        if (!pk || !c) return;
        activeCables[c.key] = true;
        const fwd = c.a === leg.from;
        const u = THREE.MathUtils.clamp(fwd ? e : 1 - e, 0.0001, 0.9999);
        const pos = c.curve.getPointAt(u);
        const tan = c.curve.getTangentAt(u);
        if (!fwd) tan.negate();
        pk.g.visible = true;
        pk.g.position.set(pos.x, (live.exploded ? 0.42 : 0.34) + Math.sin(time * 5 + i) * 0.025, pos.z);
        pk.orient.rotation.y = Math.atan2(tan.x, tan.z);
        const keyStr = `${ev.no}:${i}:${live.exploded}`;
        if (pk.key !== keyStr) {
          pk.key = keyStr;
          const color = PROTO_COLOR[ev.proto] || '#ffffff';
          pk.capMat.color.set(color);
          pk.capMat.emissive.set(color);
          pk.halo.material.color.set(color);
          pk.orient.visible = !live.exploded;
          pk.stack.visible = live.exploded;
          pk.stack.scale.setScalar(1.5);
          pk.halo.scale.setScalar(live.exploded ? 2.2 : 1.6);
          const layers = ev.layers || [];
          pk.nLayers = layers.length;
          pk.slabs.forEach((s, k) => {
            const L = layers[k];
            s.mesh.visible = !!L;
            if (!L) return;
            const lc = layerColor(L, ev);
            s.mat.color.set(lc);
            s.mat.emissive.set(lc);
            s.mesh.position.y = k * 0.3;
            s.lab.position.set(-0.5, 0, 0.3);
            s.lab.visible = i === 0;
            s.el.textContent = `L${L.n} · ${L.title.split(' ')[0].toUpperCase()}`;
          });
          pk.tag.visible = i === 0;
          pk.tag.position.y = live.exploded ? layers.length * 0.45 + 0.35 : 0.5;
          pk.tagEl.style.borderColor = color;
          pk.tagEl.innerHTML = `<b>${ev.t.toFixed(3)}s</b> · ${escHtml(ev.tag || ev.proto)}`;
        }
        if (live.exploded && i === 0) {
          const s0 = pk.slabs[0];
          if (rewrite && live.progress < 0.45) {
            const k = live.progress / 0.45;
            const start = c.curve.getPointAt(fwd ? 0.02 : 0.98);
            ghost.visible = true;
            ghost.position.set(start.x, 0.42 + easeOut(k) * 1.5, start.z);
            ghost.scale.setScalar(1.5);
            ghostMat.opacity = 1 - k;
            s0.mesh.position.y = (1 - easeOut(k)) * 0.8;
            s0.mat.opacity = 0.2 + 0.76 * k;
          } else {
            s0.mesh.position.y = 0;
            s0.mat.opacity = 0.96;
          }
        }
      });
      if ((rewrite || vlanChange) && ev.legs.length) {
        const en = entries[ev.legs[0].from];
        if (en) {
          const ttl = ev.changed.find((c) => c.key === 'l3.ttl');
          const vl = ev.changed.find((c) => c.key === 'l2.vlan');
          hopEl.innerHTML = rewrite
            ? `<b>MAC REWRITE</b>${ttl ? ` · TTL ${ttl.from} → ${ttl.to}` : ''}${vl ? ` · ${escHtml(vl.to.replace(' · tagged', ''))}` : ''}`
            : `<b>802.1Q</b> · ${vl.to.includes('VID') ? `TAG ${escHtml(vl.to.replace(' · tagged', ''))}` : 'TAG REMOVED'}`;
          hopTag.position.set(en.group.position.x, en.height + 0.95, en.group.position.z);
          hopTag.visible = true;
        }
      }
    }

    const lerp = Math.min(1, dt * 7);
    for (const c of Object.values(cables)) {
      const on = !!activeCables[c.key];
      if (on) c.col.copy(col);
      c.k += ((on ? 1 : 0) - c.k) * lerp;
      c.mat.emissive.copy(c.col).multiplyScalar(c.k * 0.85);
      tmpCol.set('#2C323E').lerp(c.col, c.k * 0.35);
      c.mat.color.copy(tmpCol);
      c.gmat.color.copy(c.col);
      c.gmat.opacity = c.k * 0.22;
    }
    for (const [id, en] of Object.entries(entries)) {
      const act = activeDevs.has(id);
      en.k += ((act ? 1 : 0) - en.k) * lerp;
      en.hk += ((en.selected ? 0.9 : hoverId === id ? 0.35 : 0) - en.hk) * lerp;
      en.ring.material.opacity = en.hk;
      en.aring.material.color.copy(ev && ev.drop ? tmpCol.set(PROTO_COLOR.DROP) : col);
      en.aring.material.opacity = en.k * (0.35 + 0.25 * Math.sin(time * 6));
      if (en.on && en.leds.length) {
        const blink = act ? (Math.sin(time * 22) > 0 ? 1 : 0.25) : 1;
        en.leds[0].opacity = blink;
        en.leds[0].transparent = true;
      }
    }

    if (tween) {
      tween.t = Math.min(1, tween.t + dt / tween.dur);
      const k = easeIO(tween.t);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
      controls.target.lerpVectors(tween.fromT, tween.toT, k);
      if (tween.t >= 1) tween = null;
    }
  }

  function tick() {
    raf = requestAnimationFrame(tick);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    time += dt;
    advance(dt);
    update(dt);
    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    packets.forEach((p) => { p.tagEl.style.zIndex = '100000'; });
    hopEl.style.zIndex = '100001';
    dropEl.style.zIndex = '100001';
  }
  tick();

  return {
    sync(topo, selected) {
      sync(topo, selected);
      if (!fitted && W > 10 && H > 10) {
        fitted = true;
        fit(true, true);
      }
    },
    fit: () => fit(true),
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cvs.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      cvs.removeEventListener('pointerleave', onLeave);
      controls.dispose();
      Object.values(entries).forEach((e) => e.dispose());
      Object.values(cables).forEach((c) => c.dispose());
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) [].concat(o.material).forEach((m) => m.dispose());
      });
      Object.values(shared).forEach((t) => t.dispose());
      renderer.dispose();
      cvs.remove();
      labels.domElement.remove();
    },
  };
}
/* =====================================================================
   3 · REACT INTERFACE  (Header · Labs · Stage + Capture · Narrative)
   ===================================================================== */

const FONT_SANS = "'Inter', 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const micro = 'text-[10px] tracking-[0.14em] uppercase text-zinc-500 font-mono';
const pad2 = (n) => String(n).padStart(2, '0');
const SEV = { high: { c: '#F43F5E', l: 'CRITICAL' }, med: { c: '#F59E0B', l: 'WARNING' }, low: { c: '#A1A1AA', l: 'NOTICE' } };
const scoreColor = (s) => (s >= 85 ? '#10B981' : s >= 60 ? '#F59E0B' : '#F43F5E');
const ACTION_ICON = { wrench: Wrench, shield: ShieldCheck, split: Split, lock: Lock, route: Route, power: Power };

const CSS = `
.nt-root .font-mono{font-family:${FONT_MONO}}
.nt-root{font-feature-settings:'cv11','ss01','tnum'}
.nt-scroll{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
.nt-scroll::-webkit-scrollbar{width:8px;height:8px}
.nt-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:8px;border:2px solid transparent;background-clip:padding-box}
.nt-scroll::-webkit-scrollbar-track{background:transparent}
.nt-pill{display:flex;align-items:center;gap:6px;padding:4px 9px 4px 7px;margin-bottom:6px;border-radius:999px;background:rgba(17,19,26,.9);border:1px solid rgba(255,255,255,.09);font:500 10.5px/1 ${FONT_MONO};color:#A1A1AA;white-space:nowrap;letter-spacing:.01em;box-shadow:0 8px 22px rgba(0,0,0,.4);backdrop-filter:blur(6px)}
.nt-pill .nt-dot{width:6px;height:6px;border-radius:99px;flex:none}
.nt-pill .nt-l{color:#F3F4F6;font-family:${FONT_SANS};font-weight:500;font-size:11px;letter-spacing:0}
.nt-pill .nt-s{color:#52525B}
.nt-pill .nt-off{margin-left:2px;padding:2px 5px;border-radius:4px;background:rgba(244,63,94,.14);color:#F43F5E;font-size:9px;letter-spacing:.12em}
.nt-pill .nt-vlan{margin-left:2px;padding:2px 5px;border-radius:4px;background:rgba(99,102,241,.16);color:#A5B4FC;font-size:9px;letter-spacing:.1em}
.nt-tag{margin-bottom:4px;padding:3px 7px;border-radius:6px;background:rgba(9,10,15,.92);border:1px solid #fff;color:#F3F4F6;font:500 10px/1.15 ${FONT_MONO};white-space:nowrap;letter-spacing:.05em}
.nt-tag b{color:#A1A1AA;font-weight:500}
.nt-layer{margin-right:6px;padding:2px 5px;border-radius:4px;background:rgba(9,10,15,.85);border:1px solid rgba(255,255,255,.1);color:#D4D4D8;font:600 8.5px/1 ${FONT_MONO};letter-spacing:.12em;white-space:nowrap}
.nt-ghost{margin-left:6px;color:#F59E0B;border-color:rgba(245,158,11,.4)}
.nt-hop{margin-bottom:4px;padding:4px 8px;border-radius:6px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.45);color:#FCD34D;font:500 10px/1 ${FONT_MONO};letter-spacing:.06em;white-space:nowrap}
.nt-hop b{color:#F59E0B;font-weight:600}
.nt-drop{margin-bottom:4px;padding:4px 8px;border-radius:6px;background:rgba(244,63,94,.14);border:1px solid rgba(244,63,94,.5);color:#FDA4AF;font:500 10px/1 ${FONT_MONO};letter-spacing:.06em;white-space:nowrap}
.nt-drop b{color:#F43F5E;font-weight:600}
@keyframes ntIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.nt-in{animation:ntIn .28s cubic-bezier(.2,.8,.2,1) both}
`;

function ProtoChip({ p, small }) {
  const c = PROTO_COLOR[p] || '#A1A1AA';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border font-mono tracking-[0.1em] ${small ? 'h-5 px-1.5 text-[9.5px]' : 'h-6 px-2 text-[10px]'}`} style={{ borderColor: c + '55', color: c, background: c + '12' }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {p}
    </span>
  );
}

function LayerBadge({ n, color, lit = true }) {
  return (
    <span className="inline-grid h-5 w-5 place-items-center rounded-[4px] border font-mono text-[10px] font-semibold" style={lit ? { background: color || '#F3F4F6', borderColor: color || '#F3F4F6', color: '#090A0F' } : { borderColor: 'rgba(255,255,255,.1)', color: '#52525B' }}>
      {n}
    </span>
  );
}

function LogoMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
      <path d="M13 2.5 23 8.25v9.5L13 23.5 3 17.75v-9.5L13 2.5Z" stroke="#F3F4F6" strokeOpacity=".9" strokeWidth="1.2" />
      <path d="M3 8.25 13 14l10-5.75M13 14v9.5" stroke="#F3F4F6" strokeOpacity=".35" strokeWidth="1.2" />
      <circle cx="13" cy="14" r="2.1" fill="#06B6D4" />
    </svg>
  );
}

/* ---------- header ---------- */
function Header({ lab, mode, setMode, ev, names, health }) {
  const lit = ev ? ev.osi || 2 : 0;
  const color = ev ? PROTO_COLOR[ev.proto] : '#F3F4F6';
  const R = 15;
  const C = 2 * Math.PI * R;
  return (
    <header className="grid h-[62px] shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-6 border-b border-white/[0.07] bg-[#0C0E14] px-5">
      <div className="flex min-w-0 items-center gap-3">
        <LogoMark />
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold tracking-[0.12em] text-[#F3F4F6]">
            NETTRACER <span className="text-zinc-600">·</span> <span className="text-zinc-300">PROTOCOL & TOPOLOGY EXPLORER</span>
          </div>
          <div className={`${micro} mt-1 truncate`}>Learn how networks work & how to improve them</div>
        </div>
      </div>

      <div className="flex min-w-0 items-center justify-center gap-4">
        <div className="flex h-8 min-w-0 items-center gap-2.5 rounded-full border border-white/[0.08] bg-[#11131A] pl-1 pr-3.5">
          <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-[3px] font-mono text-[9.5px] tracking-[0.14em] text-zinc-400">NOW LEARNING</span>
          <span className="max-w-[210px] truncate text-[12px] text-zinc-200">{mode === 'sandbox' ? 'Sandbox · custom topology' : `${lab.num} · ${lab.title}`}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className={micro}>OSI layer</span>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <span
                key={n}
                title={`L${n} · ${OSI_NAMES[n - 1]}`}
                className="grid h-[22px] w-[22px] place-items-center rounded-[5px] border font-mono text-[10.5px] font-semibold transition-all duration-300"
                style={n <= lit ? (n === lit ? { background: color, borderColor: color, color: '#090A0F', boxShadow: `0 0 14px ${color}55` } : { background: '#F3F4F6', borderColor: '#F3F4F6', color: '#090A0F' }) : { borderColor: 'rgba(255,255,255,.09)', color: '#52525B' }}
              >
                {n}
              </span>
            ))}
          </div>
          <span className="hidden w-[132px] truncate font-mono text-[10px] tracking-[0.08em] text-zinc-500 2xl:block">
            {ev ? `L${lit} ${OSI_NAMES[lit - 1].toUpperCase()} @ ${names[ev.at] || ev.at}` : 'IDLE'}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-5">
        <div className="flex items-center gap-2.5">
          <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90">
            <circle cx="18" cy="18" r={R} stroke="rgba(255,255,255,.07)" strokeWidth="3" fill="none" />
            <circle cx="18" cy="18" r={R} stroke={scoreColor(health.score)} strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - health.score / 100)} style={{ transition: 'stroke-dashoffset .6s cubic-bezier(.2,.8,.2,1), stroke .3s' }} />
          </svg>
          <div>
            <div className={`${micro} whitespace-nowrap`}>Network health</div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-[17px] font-medium tabular-nums" style={{ color: scoreColor(health.score) }}>{health.score}</span>
              <span className="whitespace-nowrap font-mono text-[10px] text-zinc-600">/100 · {health.issues.length} issue{health.issues.length === 1 ? '' : 's'}</span>
            </div>
          </div>
        </div>
        <div className="flex h-8 items-center rounded-lg border border-white/[0.08] bg-[#11131A] p-[3px]">
          {[['guided', 'GUIDED LABS'], ['sandbox', 'SANDBOX']].map(([id, l]) => (
            <button key={id} onClick={() => setMode(id)} className={`h-full whitespace-nowrap rounded-md px-3 font-mono text-[10px] tracking-[0.12em] transition ${mode === id ? 'bg-[#F3F4F6] text-[#090A0F]' : 'text-zinc-500 hover:text-zinc-200'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

/* ---------- left: storyline ---------- */
function StepList({ sim, idx, seek }) {
  const cur = sim.events[idx] ? sim.events[idx].step : -1;
  return (
    <ol className="mt-3 space-y-px">
      {sim.steps.map((s, i) => {
        const active = i === cur;
        const done = i < cur;
        const c = s.drop ? PROTO_COLOR.DROP : PROTO_COLOR[s.proto] || '#A1A1AA';
        return (
          <li key={i}>
            <button onClick={() => seek(s.start, 0.5)} className={`flex w-full items-stretch gap-2.5 rounded-md px-2 py-[7px] text-left transition ${active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'}`}>
              <span className={`w-[20px] shrink-0 pt-px font-mono text-[10.5px] tabular-nums ${active ? 'text-zinc-100' : done ? 'text-zinc-500' : 'text-zinc-600'}`}>{pad2(i + 1)}</span>
              <span className="w-[2px] shrink-0 rounded-full transition-colors" style={{ background: active ? c : done ? c + '66' : 'rgba(255,255,255,.07)' }} />
              <span className="min-w-0 flex-1">
                <span className={`block font-mono text-[10.5px] uppercase leading-snug tracking-[0.06em] ${active ? 'text-zinc-100' : done ? 'text-zinc-400' : 'text-zinc-500'}`}>{s.title}</span>
                <span className="mt-0.5 block font-mono text-[9.5px] text-zinc-600">
                  {s.end - s.start + 1} frame{s.end > s.start ? 's' : ''} · {s.drop ? <span className="text-[#F43F5E]">DROP</span> : s.proto}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Outcome({ sim, names }) {
  const okc = sim.ok ? '#10B981' : '#F43F5E';
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border px-2.5 py-2" style={{ borderColor: okc + '33', background: okc + '0d' }}>
      {sim.ok ? <CircleCheck size={14} color={okc} className="mt-px shrink-0" /> : <CircleX size={14} color={okc} className="mt-px shrink-0" />}
      <span className="font-mono text-[10.5px] leading-snug" style={{ color: okc }}>
        {sim.ok ? `DELIVERED · ${sim.events.length} FRAMES · ${sim.duration.toFixed(3)}s` : `FAILED AT ${(names[sim.failure && sim.failure.at] || '').toUpperCase()} · ${sim.failure ? sim.failure.title.toUpperCase() : ''}`}
      </span>
    </div>
  );
}

function LabsPanel({ cat, setCat, labId, selectLab, sim, idx, seek, names }) {
  const shown = LABS.filter((l) => cat === 'all' || l.cat === cat);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-white/[0.07] px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <span className={micro}>Scenarios & storyline</span>
          <span className={micro}>{pad2(shown.length)} / {pad2(LABS.length)}</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {CATS.map((c) => (
            <button key={c.id} onClick={() => setCat(c.id)} className={`h-6 rounded-md border px-2 font-mono text-[9.5px] tracking-[0.12em] transition ${cat === c.id ? 'border-white/20 bg-white/[0.08] text-zinc-100' : 'border-white/[0.06] text-zinc-500 hover:text-zinc-300'}`}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="nt-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {shown.map((l) => {
          const active = l.id === labId;
          return (
            <div key={l.id} className={`rounded-lg border transition ${active ? 'border-white/[0.12] bg-[#161922]' : 'border-white/[0.06] bg-[#11131A] hover:border-white/[0.1]'}`}>
              <button onClick={() => !active && selectLab(l)} className="w-full px-3 pb-2.5 pt-3 text-left">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10.5px] text-zinc-500">{l.num}</span>
                  <span className="font-mono text-[9px] tracking-[0.14em] text-zinc-600">{CATS.find((c) => c.id === l.cat).label}</span>
                  {active ? <ChevronDown size={13} className="ml-auto text-zinc-500" /> : <ChevronRight size={13} className="ml-auto text-zinc-600" />}
                </div>
                <div className={`mt-1.5 text-[13.5px] font-medium leading-snug ${active ? 'text-zinc-50' : 'text-zinc-300'}`}>{l.title}</div>
                {active && <p className="mt-1.5 text-[12px] leading-[1.55] text-zinc-400">{l.blurb}</p>}
              </button>
              {active && (
                <div className="nt-in border-t border-white/[0.06] px-2 pb-3 pt-2">
                  <StepList sim={sim} idx={idx} seek={seek} />
                  <div className="px-1"><Outcome sim={sim} names={names} /></div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t border-white/[0.07] px-4 py-2.5 font-mono text-[9.5px] tracking-[0.1em] text-zinc-600">SPACE PLAY · ← → STEP · CLICK A ROW TO SCRUB</div>
    </div>
  );
}

function SandboxPanel({ topo, setTopo, sbFlow, setSbFlow, sim, idx, seek, onSelect, names }) {
  const hosts = Object.values(topo.devices).filter(isHost);
  const [type, setType] = useState(sbFlow.type);
  const [src, setSrc] = useState(sbFlow.src);
  const [target, setTarget] = useState(sbFlow.type === 'ping' ? sbFlow.dst : sbFlow.name || 'nettracer.lab');
  const ipOpts = [];
  for (const d of Object.values(topo.devices)) {
    if (isHost(d) && d.ip) ipOpts.push([d.ip, d.name]);
    if (isRouter(d)) for (const f of d.ifaces) f.addrs.forEach((a) => ipOpts.push([a.ip, `${d.name} ${f.name}`]));
  }
  const switchType = (t) => {
    setType(t);
    setTarget(t === 'ping' ? '203.0.113.10' : 'nettracer.lab');
  };
  const run = () => setSbFlow(type === 'ping' ? { type, src, dst: target.trim() } : { type, src, name: target.trim() });
  const add = (kind) => {
    const r = addHost(topo, kind);
    setTopo(r.topo);
    onSelect(r.id);
  };
  const valid = type === 'ping' ? isIp(target) : target.trim().length > 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="nt-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-white/[0.07] px-4 pb-4 pt-4">
          <span className={micro}>Build</span>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[['laptop', 'Add laptop', Laptop, 'on SW1'], ['server', 'Add server', Server, 'on SW2']].map(([k, l, I, sub]) => (
              <button key={k} onClick={() => add(k)} className="group flex flex-col items-start gap-2 rounded-lg border border-white/[0.07] bg-[#161922] p-3 text-left transition hover:border-white/[0.16]">
                <span className="flex w-full items-center justify-between"><I size={16} className="text-zinc-300" /><Plus size={13} className="text-zinc-600 group-hover:text-zinc-300" /></span>
                <span className="text-[12.5px] text-zinc-200">{l}</span>
                <span className="font-mono text-[9.5px] tracking-[0.1em] text-zinc-600">{sub.toUpperCase()}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] leading-[1.55] text-zinc-500">Drag any device to move it. Click one to edit its IP, mask, gateway, VLAN, uplink or power. Every change re-runs the capture.</p>
        </div>
        <div className="border-b border-white/[0.07] px-4 pb-4 pt-4">
          <span className={micro}>Traffic generator</span>
          <div className="mt-3 space-y-2">
            <label className="flex h-8 items-center gap-2">
              <span className="w-[62px] font-mono text-[10px] tracking-[0.12em] text-zinc-500">SOURCE</span>
              <select value={src} onChange={(e) => setSrc(e.target.value)} className="h-7 min-w-0 flex-1 rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[12px] text-zinc-100 outline-none">
                {hosts.map((h) => <option key={h.id} value={h.id}>{h.name} · {h.ip}</option>)}
              </select>
            </label>
            <div className="flex h-8 items-center gap-2">
              <span className="w-[62px] font-mono text-[10px] tracking-[0.12em] text-zinc-500">TYPE</span>
              <div className="flex h-7 flex-1 rounded-md border border-white/[0.08] bg-[#0C0E14] p-[2px]">
                {[['ping', 'PING'], ['web', 'WEB'], ['dns', 'DNS']].map(([id, l]) => (
                  <button key={id} onClick={() => switchType(id)} className={`flex-1 rounded font-mono text-[10px] tracking-[0.1em] ${type === id ? 'bg-white/[0.1] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>{l}</button>
                ))}
              </div>
            </div>
            <label className="flex h-8 items-center gap-2">
              <span className="w-[62px] font-mono text-[10px] tracking-[0.12em] text-zinc-500">{type === 'ping' ? 'DEST IP' : 'HOST'}</span>
              <input list="nt-ips" value={target} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && valid) run(); }} className={`h-7 min-w-0 flex-1 rounded-md border bg-[#0C0E14] px-2 font-mono text-[12px] text-zinc-100 outline-none focus:border-white/25 ${valid ? 'border-white/[0.08]' : 'border-[#F43F5E]/60'}`} />
              {type === 'ping' && <datalist id="nt-ips">{ipOpts.map(([ip, n]) => <option key={ip + n} value={ip}>{n}</option>)}</datalist>}
            </label>
            <button disabled={!valid} onClick={run} className="mt-1 flex h-8 w-full items-center justify-center gap-2 rounded-md bg-[#F3F4F6] font-mono text-[10.5px] font-semibold tracking-[0.12em] text-[#090A0F] transition hover:bg-white disabled:opacity-40">
              <Play size={12} fill="currentColor" /> RUN CAPTURE
            </button>
          </div>
        </div>
        <div className="px-2 pb-4 pt-4">
          <div className="px-2"><span className={micro}>Storyline · {sim.steps.length} steps</span></div>
          <StepList sim={sim} idx={idx} seek={seek} />
          <div className="px-1"><Outcome sim={sim} names={names} /></div>
        </div>
      </div>
    </div>
  );
}

/* ---------- center bottom: playback + capture ---------- */
function PlaybackBar({ speed, setSpeed, playing, togglePlay, stepBy, reset, idx, events, seek }) {
  const ev = events[idx];
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.07] px-3">
      <div className="flex h-7 items-center overflow-hidden rounded-md border border-white/[0.08]">
        {[0.5, 1, 2, 4].map((s) => (
          <button key={s} onClick={() => setSpeed(s)} className={`h-full px-2 font-mono text-[10.5px] transition ${speed === s ? 'bg-white/[0.09] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>{s}x</button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button onClick={togglePlay} className="flex h-7 items-center gap-1.5 rounded-md bg-[#F3F4F6] px-2.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-[#090A0F] hover:bg-white">
          {playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
          {playing ? 'PAUSE' : 'PLAY'}
        </button>
        <button onClick={() => stepBy(-1)} title="Previous frame" className="grid h-7 w-7 place-items-center rounded-md border border-white/[0.08] text-zinc-400 hover:text-zinc-100"><SkipBack size={12} /></button>
        <button onClick={() => stepBy(1)} className="flex h-7 items-center gap-1.5 rounded-md border border-white/[0.08] px-2.5 font-mono text-[10.5px] tracking-[0.1em] text-zinc-300 hover:text-zinc-50">STEP <SkipForward size={11} /></button>
        <button onClick={reset} className="flex h-7 items-center gap-1.5 rounded-md border border-white/[0.08] px-2.5 font-mono text-[10.5px] tracking-[0.1em] text-zinc-400 hover:text-zinc-50"><RotateCcw size={11} /> RESET</button>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-400">
          {pad2(idx + 1)}<span className="text-zinc-600">/{pad2(events.length)}</span>
          <span className="ml-2 text-zinc-500">{ev ? ev.t.toFixed(3) : '0.000'}s</span>
        </span>
        <div className="flex h-[14px] min-w-0 flex-1 items-center gap-[2px]">
          {events.map((e, i) => (
            <button key={i} onClick={() => seek(i)} title={`#${e.no} ${e.proto} · ${e.info}`} className="h-full min-w-[2px] flex-1 rounded-[2px] transition-all" style={{ background: PROTO_COLOR[e.proto], opacity: i === idx ? 1 : i < idx ? 0.55 : 0.16, transform: i === idx ? 'scaleY(1.25)' : 'none' }} />
          ))}
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-1 2xl:flex">
        {LEGEND.slice(0, 5).map((p) => <ProtoChip key={p} p={p} small />)}
      </div>
      <div className="flex shrink-0 items-center gap-1 2xl:hidden">
        {LEGEND.slice(0, 5).map((p) => <span key={p} className="font-mono text-[9.5px] tracking-[0.08em]" style={{ color: PROTO_COLOR[p] }}>{p}</span>)}
      </div>
    </div>
  );
}

function CaptureTable({ events, idx, seek }) {
  const box = useRef(null);
  useEffect(() => {
    const c = box.current;
    if (!c) return;
    const row = c.querySelector(`[data-row="${idx}"]`);
    if (!row) return;
    const top = row.offsetTop - 26;
    const bottom = row.offsetTop + row.offsetHeight;
    if (top < c.scrollTop) c.scrollTop = top;
    else if (bottom > c.scrollTop + c.clientHeight) c.scrollTop = bottom - c.clientHeight + 4;
  }, [idx, events]);
  const grid = 'grid grid-cols-[44px_66px_minmax(0,1.1fr)_minmax(0,1.1fr)_70px_minmax(0,3fr)_50px] items-center gap-x-3';
  return (
    <div ref={box} className="nt-scroll relative min-h-0 flex-1 overflow-y-auto">
      <div className={`${grid} sticky top-0 z-10 h-[26px] border-b border-white/[0.07] bg-[#0E1016] px-3 font-mono text-[9.5px] tracking-[0.14em] text-zinc-500`}>
        <span>NO.</span><span>TIME</span><span>SOURCE</span><span>DESTINATION</span><span>PROTOCOL</span><span>INFO</span><span className="text-right">SIZE</span>
      </div>
      {events.map((e, i) => {
        const c = PROTO_COLOR[e.proto];
        const cur = i === idx;
        return (
          <div key={i} data-row={i} role="row" onClick={() => seek(i)} className={`${grid} relative h-[25px] cursor-pointer px-3 font-mono text-[11px] transition-colors ${cur ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'} ${i > idx ? 'opacity-45' : ''}`}>
            {cur && <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: c }} />}
            <span className="tabular-nums text-zinc-500">{e.no}</span>
            <span className="tabular-nums text-zinc-400">{e.t.toFixed(3)}</span>
            <span className="truncate text-zinc-300">{e.src}</span>
            <span className="truncate text-zinc-300">{e.dst}</span>
            <span className="flex items-center gap-1.5" style={{ color: c }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />{e.proto}</span>
            <span className={`truncate ${e.drop ? 'text-[#FDA4AF]' : 'text-zinc-200'}`}>{e.info}<span className="text-zinc-600">{e.hop ? `  · ${e.hop}` : ''}</span></span>
            <span className="text-right tabular-nums text-zinc-500">{e.size || ''}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- right: narrative, byte diff, improvements ---------- */
const macBytes = (m) => (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(m || '') ? m.split(':') : ['··', '··', '··', '··', '··', '··']);
const ipBytes = (ip) => (isIp(ip) ? ip.split('.').map((n) => Number(n).toString(16).padStart(2, '0')) : ['··', '··', '··', '··']);
function bytesOf(L, flat) {
  const f = (k) => flat[k] || '';
  if (L.key === 'l2') {
    const out = [];
    macBytes(f('l2.dst')).forEach((b) => out.push([b, 'l2.dst']));
    macBytes(f('l2.src')).forEach((b) => out.push([b, 'l2.src']));
    const v = f('l2.vlan');
    if (v.startsWith('VID')) {
      const vid = parseInt(v.slice(4), 10);
      out.push(['81', 'l2.vlan'], ['00', 'l2.vlan'], [((vid >> 8) & 15).toString(16).padStart(2, '0'), 'l2.vlan'], [(vid & 255).toString(16).padStart(2, '0'), 'l2.vlan']);
    }
    const et = f('l2.type').slice(2, 6);
    out.push([et.slice(0, 2), 'l2.type'], [et.slice(2, 4), 'l2.type']);
    return out;
  }
  if (L.key === 'l3') {
    const ttl = (Number(f('l3.ttl')) || 0).toString(16).padStart(2, '0');
    const pr = (parseInt(f('l3.proto'), 10) || 0).toString(16).padStart(2, '0');
    const cs = f('l3.csum').slice(2).padStart(4, '0');
    const id = f('l3.id').slice(2).padStart(4, '0');
    return [['45', ''], ['00', ''], ['00', ''], ['54', ''], [id.slice(0, 2), 'l3.id'], [id.slice(2), 'l3.id'], ['40', ''], ['00', ''], [ttl, 'l3.ttl'], [pr, 'l3.proto'], [cs.slice(0, 2), 'l3.csum'], [cs.slice(2), 'l3.csum'], ...ipBytes(f('l3.src')).map((b) => [b, 'l3.src']), ...ipBytes(f('l3.dst')).map((b) => [b, 'l3.dst'])];
  }
  if (L.key === 'arp') {
    const op = f('arp.op').startsWith('1') ? '01' : '02';
    return [['00', ''], ['01', ''], ['08', ''], ['00', ''], ['06', ''], ['04', ''], ['00', 'arp.op'], [op, 'arp.op'], ...macBytes(f('arp.smac')).map((b) => [b, 'arp.smac']), ...ipBytes(f('arp.sip')).map((b) => [b, 'arp.sip']), ...macBytes(f('arp.tmac')).map((b) => [b, 'arp.tmac']), ...ipBytes(f('arp.tip')).map((b) => [b, 'arp.tip'])];
  }
  return null;
}

function LayerCard({ L, ev, changedMap }) {
  const [open, setOpen] = useState(true);
  const c = layerColor(L, ev);
  const mutated = L.fields.filter(([, , k]) => changedMap[k]);
  const bytes = bytesOf(L, ev.flat || {});
  return (
    <div className={`mt-2 overflow-hidden rounded-lg border bg-[#161922] ${mutated.length ? 'border-amber-500/30' : 'border-white/[0.07]'}`}>
      <button onClick={() => setOpen(!open)} className="flex h-9 w-full items-center gap-2.5 px-2.5 text-left">
        <LayerBadge n={L.n} color={c} />
        <span className="text-[12.5px] font-medium text-zinc-100">{L.title}</span>
        {L.sub && <span className="truncate font-mono text-[10.5px] text-zinc-500">{L.sub}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {mutated.length > 0 && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em] text-amber-400">{mutated.length} CHANGED</span>}
          <ChevronDown size={13} className={`text-zinc-500 transition ${open ? '' : '-rotate-90'}`} />
        </span>
      </button>
      {open && (
        <div className="border-t border-white/[0.05] px-2.5 pb-2.5 pt-1.5">
          {L.fields.map(([label, value, k]) => {
            const ch = changedMap[k];
            return (
              <div key={label} className={`-mx-1 grid grid-cols-[104px_minmax(0,1fr)] items-baseline gap-2 rounded px-1 py-[3px] ${ch ? 'bg-amber-500/[0.07]' : ''}`}>
                <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-zinc-500">{label}</span>
                <span className="min-w-0 break-all font-mono text-[11.5px] leading-snug text-zinc-200">
                  {ch ? (
                    <>
                      <span className="block text-[10.5px] text-zinc-600 line-through decoration-zinc-600">{ch.from}</span>
                      <span className="text-amber-300"><span className="mr-1 text-amber-500">→</span>{value}</span>
                    </>
                  ) : value}
                </span>
              </div>
            );
          })}
          {bytes && (
            <div className="mt-2 flex flex-wrap gap-x-[5px] gap-y-0.5 rounded-md bg-[#0C0E14] px-2 py-1.5 font-mono text-[10.5px] leading-[1.6]">
              {bytes.map(([b, k], i) => (
                <span key={i} className={changedMap[k] ? 'rounded-[2px] bg-amber-500/20 px-[1px] text-amber-300' : k ? 'text-zinc-400' : 'text-zinc-600'}>{b}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RightPanel({ sim, idx, ev, health, lab, mode, applyAction }) {
  if (!ev) return <div className="p-5 text-[12px] text-zinc-500">No frames in this capture.</div>;
  const step = sim.steps[ev.step];
  const changedMap = {};
  ev.changed.forEach((c) => { changedMap[c.key] = c; });
  const meta = ev.meta || {};
  const pills = [
    ['SRC MAC', meta.srcMac, 'l2.src'],
    ['DST MAC', meta.dstMac, 'l2.dst'],
    ['NEXT HOP', meta.nextHop, ''],
    ['TTL', meta.ttl, 'l3.ttl'],
  ];
  const focusTag = mode === 'guided' ? lab.focus : null;
  return (
    <div className="nt-scroll h-full overflow-y-auto">
      <section className="border-b border-white/[0.07] px-5 pb-5 pt-4">
        <div className="flex items-center justify-between">
          <span className={micro}>Step {pad2(ev.step + 1)} of {pad2(sim.steps.length)}</span>
          <ProtoChip p={ev.proto} />
        </div>
        <div key={ev.step} className="nt-in">
          <div className="mt-2 flex items-baseline gap-2.5">
            <span className="text-[46px] font-light leading-none tracking-tight tabular-nums text-[#F3F4F6]">{pad2(ev.step + 1)}</span>
            <span className="font-mono text-[12px] text-zinc-600">/ {pad2(sim.steps.length)}</span>
          </div>
          <h2 className="mt-3 text-[13px] font-semibold uppercase leading-snug tracking-[0.08em] text-zinc-100">{step.title}</h2>
          <div className={`${micro} mt-4`}>The why</div>
          <p className="mt-1.5 text-[13px] leading-[1.62] text-zinc-300">{step.why || ev.note}</p>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <span className={micro}>At this hop</span>
          <span className="truncate rounded border border-white/[0.07] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-300">{ev.hop}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-zinc-500">#{ev.no} · {ev.t.toFixed(3)}s</span>
        </div>
        <p className={`mt-1.5 text-[12.5px] leading-[1.6] ${ev.drop ? 'text-[#FDA4AF]' : 'text-zinc-400'}`}>{ev.note}</p>
        <div className="mt-4 grid grid-cols-2 gap-1.5">
          {pills.map(([l, v, k]) => {
            const ch = k && changedMap[k];
            return (
              <div key={l} className={`rounded-md border px-2.5 py-1.5 ${ch ? 'border-amber-500/35 bg-amber-500/[0.06]' : 'border-white/[0.07] bg-[#11131A]'}`}>
                <div className="font-mono text-[9px] tracking-[0.14em] text-zinc-500">{l}</div>
                <div className={`mt-0.5 truncate font-mono text-[11.5px] ${ch ? 'text-amber-300' : 'text-zinc-200'}`}>{v || 'n/a'}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="border-b border-white/[0.07] px-5 pb-5 pt-4">
        <div className="flex items-center justify-between">
          <span className={`${micro} whitespace-nowrap`}>OSI encapsulation & byte diff</span>
          {ev.changed.length ? <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em] text-amber-400">{ev.changed.length} MUTATED</span> : <span className="font-mono text-[9px] tracking-[0.12em] text-zinc-600">{ev.drop ? 'DISCARDED' : 'UNCHANGED'}</span>}
        </div>
        <div className="mt-3 flex h-9 items-center gap-2.5 rounded-lg border border-white/[0.07] bg-[#11131A] px-2.5">
          <LayerBadge n={1} color="#52525B" />
          <span className="text-[12.5px] text-zinc-300">Physical</span>
          <span className="ml-auto font-mono text-[10.5px] text-zinc-500">{ev.drop ? 'no transmission' : `1000BASE-T · ${ev.size} B on the wire`}</span>
        </div>
        {(ev.layers || []).map((L) => <LayerCard key={`${ev.no}-${L.key}`} L={L} ev={ev} changedMap={changedMap} />)}
      </section>

      <section className="px-5 pb-6 pt-4">
        <div className="flex items-center justify-between">
          <span className={micro}>How to improve this network</span>
          <span className="font-mono text-[10.5px]" style={{ color: scoreColor(health.score) }}>{health.score}/100</span>
        </div>
        {health.issues.length === 0 && (
          <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5">
            <CircleCheck size={15} className="mt-px shrink-0 text-emerald-400" />
            <p className="text-[12.5px] leading-[1.55] text-emerald-200">Every check passes. Switch labs to watch the hardened network carry the same traffic.</p>
          </div>
        )}
        {health.issues.map((i) => (
          <div key={i.id} className="nt-in mt-3 rounded-lg border border-white/[0.07] bg-[#161922] p-3.5">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEV[i.sev].c }} />
              <span className="font-mono text-[9.5px] tracking-[0.14em]" style={{ color: SEV[i.sev].c }}>{SEV[i.sev].l}</span>
              <span className="font-mono text-[9.5px] text-zinc-600">−{i.penalty} pts</span>
              {i.tag === focusTag && <span className="ml-auto rounded border border-white/[0.1] px-1.5 py-0.5 font-mono text-[9px] tracking-[0.12em] text-zinc-400">THIS LAB</span>}
            </div>
            <div className="mt-2 text-[13px] font-medium leading-snug text-zinc-100">{i.title}</div>
            <p className="mt-1.5 text-[12px] leading-[1.58] text-zinc-400">{i.detail}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {i.actions.map((a) => {
                const I = ACTION_ICON[a.icon] || Wrench;
                return (
                  <button key={a.label} onClick={() => applyAction(a)} className={a.ghost ? 'flex h-8 items-center gap-1.5 rounded-md border border-white/[0.1] px-3 text-[11.5px] text-zinc-300 transition hover:border-white/25 hover:text-zinc-50' : 'flex h-8 items-center gap-1.5 rounded-md bg-[#F3F4F6] px-3 text-[11.5px] font-medium text-[#090A0F] transition hover:bg-white'}>
                    <I size={13} /> {a.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {health.hardening.length > 0 && (
          <div className="mt-4">
            <span className={micro}>Applied hardening</span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {health.hardening.map((h) => (
                <span key={h} className="flex h-6 items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-2 font-mono text-[10px] tracking-[0.06em] text-emerald-300"><Check size={11} /> {h}</span>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------- device inspector (floating over the stage) ---------- */
function Field({ label, value, onCommit, validate = () => true, placeholder }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const dirty = v !== (value ?? '');
  const bad = dirty && !validate(v.trim());
  const commit = () => {
    if (!dirty) return;
    if (validate(v.trim())) onCommit(v.trim());
    else setV(value ?? '');
  };
  return (
    <label className="flex h-8 items-center gap-2">
      <span className="w-[70px] shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-zinc-500">{label}</span>
      <input
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setV(value ?? '');
        }}
        className={`h-7 min-w-0 flex-1 rounded-md border bg-[#0C0E14] px-2 font-mono text-[12px] text-zinc-100 outline-none transition focus:border-white/25 ${bad ? 'border-[#F43F5E]/60' : dirty ? 'border-amber-500/40' : 'border-white/[0.08]'}`}
      />
    </label>
  );
}

function MiniTable({ head, rows, empty }) {
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-white/[0.06]">
      <div className="grid bg-white/[0.03] px-2 py-1 font-mono text-[9px] tracking-[0.12em] text-zinc-500" style={{ gridTemplateColumns: head.map((h) => h[1]).join(' ') }}>
        {head.map(([h]) => <span key={h}>{h}</span>)}
      </div>
      {rows.length === 0 && <div className="px-2 py-2 font-mono text-[10.5px] text-zinc-600">{empty}</div>}
      {rows.map((r, i) => (
        <div key={i} className="grid items-center border-t border-white/[0.04] px-2 py-[3px] font-mono text-[10.5px] text-zinc-300" style={{ gridTemplateColumns: head.map((h) => h[1]).join(' ') }}>
          {r.map((c, j) => <span key={j} className="truncate">{c}</span>)}
        </div>
      ))}
    </div>
  );
}

function Inspector({ id, topo, setTopo, ev, sim, onClose, mode, onDeleted }) {
  const d = topo.devices[id];
  const [nr, setNr] = useState({ net: '', mask: M24, iface: '', via: '' });
  const [rec, setRec] = useState({ name: '', ip: '' });
  if (!d) return null;
  const snap = ev ? ev.snap : sim.final;
  const patch = (p) => setTopo((t) => applyFix(t, { type: 'set', id, patch: p }));
  const okIp = (v) => isIp(v);
  const okMask = (v) => isMask(v);
  const okGw = (v) => v === '' || isIp(v);
  const on = powered(d);
  const Icon = d.type === 'laptop' ? Laptop : d.type === 'router' ? RouterIcon : d.type === 'switch' ? Network : Server;
  const switches = Object.values(topo.devices).filter(isSwitch);
  const arpRows = Object.entries((snap.arp || {})[id] || {}).map(([ip, e]) => [ip, e.mac, e.static ? 'static' : 'dynamic']);
  const macRows = Object.values((snap.mac || {})[id] || {}).map((e) => [String(e.vlan), e.mac, e.portName || sim.ports[e.port] || e.port, e.static ? 'S' : 'D']);
  const section = 'mt-3 border-t border-white/[0.06] pt-3';
  const smallBtn = 'flex h-6 items-center gap-1 rounded border border-white/[0.08] px-2 font-mono text-[9.5px] tracking-[0.1em] text-zinc-400 transition hover:border-white/20 hover:text-zinc-100';

  return (
    <div className="nt-in nt-scroll pointer-events-auto max-h-full w-[328px] overflow-y-auto rounded-xl border border-white/[0.09] bg-[#11131A]/95 p-3.5 shadow-[0_24px_60px_rgba(0,0,0,.55)] backdrop-blur-md">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-md border border-white/[0.08] bg-[#161922]"><Icon size={15} style={{ color: accentOf(d) }} /></span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-zinc-100">{d.name} <span className="text-zinc-500">· {d.label}</span></div>
          <div className="font-mono text-[9.5px] tracking-[0.12em] text-zinc-500">{d.type.toUpperCase()}{d.mac ? ` · ${d.mac}` : ''}</div>
        </div>
        <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100"><X size={14} /></button>
      </div>
      <div className="mt-3 flex items-center justify-between rounded-md border border-white/[0.06] bg-[#0C0E14] px-2.5 py-1.5">
        <span className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-zinc-400"><Power size={12} className={on ? 'text-emerald-400' : 'text-[#F43F5E]'} /> POWER {on ? 'ON' : 'OFF'}</span>
        <button onClick={() => patch({ power: !on })} className={`relative h-[18px] w-8 rounded-full transition ${on ? 'bg-emerald-500/80' : 'bg-white/[0.12]'}`}>
          <span className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${on ? 'left-[16px]' : 'left-[2px]'}`} />
        </button>
      </div>

      {isHost(d) && (
        <>
          <div className={section}>
            <span className={micro}>IP configuration</span>
            <div className="mt-1.5">
              <Field label="IPv4" value={d.ip} validate={okIp} onCommit={(v) => patch({ ip: v })} />
              <Field label="Mask" value={d.mask} validate={okMask} onCommit={(v) => patch({ mask: v })} />
              <Field label="Gateway" value={d.gw} validate={okGw} placeholder="none" onCommit={(v) => patch({ gw: v })} />
              {d.type === 'laptop' && <Field label="DNS" value={d.dns} validate={okIp} onCommit={(v) => patch({ dns: v })} />}
              <label className="flex h-8 items-center gap-2">
                <span className="w-[70px] shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-zinc-500">Uplink</span>
                <select value={d.uplink || ''} onChange={(e) => patch({ uplink: e.target.value })} className="h-7 min-w-0 flex-1 rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[12px] text-zinc-100 outline-none">
                  <option value="">unplugged</option>
                  {switches.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.label}</option>)}
                </select>
              </label>
              {isSwitch(topo.devices[d.uplink]) && (
                <label className="flex h-8 items-center gap-2">
                  <span className="w-[70px] shrink-0 font-mono text-[9.5px] uppercase tracking-[0.12em] text-zinc-500">Access VLAN</span>
                  <select value={String(d.vlan || 1)} onChange={(e) => patch({ vlan: Number(e.target.value) })} className="h-7 min-w-0 flex-1 rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[12px] text-zinc-100 outline-none">
                    {[1, 10, 20, 30].map((v) => <option key={v} value={v}>VLAN {v}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
          {d.role === 'dns' && (
            <div className={section}>
              <span className={micro}>DNS records · A</span>
              <MiniTable head={[['NAME', '1fr'], ['ADDRESS', '96px'], ['', '18px']]} empty="no records" rows={Object.entries(d.records || {}).map(([n, ip]) => [n, ip, <button key={n} onClick={() => { const r = { ...d.records }; delete r[n]; patch({ records: r }); }} className="text-zinc-600 hover:text-[#F43F5E]"><Trash2 size={11} /></button>])} />
              <div className="mt-2 flex gap-1.5">
                <input value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="host.lab" className="h-7 min-w-0 flex-1 rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[11px] text-zinc-100 outline-none" />
                <input value={rec.ip} onChange={(e) => setRec({ ...rec, ip: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="203.0.113.10" className="h-7 w-[104px] rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[11px] text-zinc-100 outline-none" />
                <button disabled={!rec.name || !isIp(rec.ip)} onClick={() => { patch({ records: { ...(d.records || {}), [rec.name.trim()]: rec.ip.trim() } }); setRec({ name: '', ip: '' }); }} className="grid h-7 w-7 place-items-center rounded-md bg-[#F3F4F6] text-[#090A0F] disabled:opacity-30"><Plus size={13} /></button>
              </div>
            </div>
          )}
        </>
      )}

      {isRouter(d) && (
        <>
          <div className={section}>
            <span className={micro}>Interfaces</span>
            {d.ifaces.map((f) => (
              <div key={f.name} className="mt-2 rounded-md border border-white/[0.06] bg-[#0C0E14] p-2">
                <div className="flex items-center gap-2 font-mono text-[10.5px]">
                  <span className="text-zinc-100">{f.name}</span>
                  <span className="text-zinc-600">{f.mac}</span>
                  {Number(f.vlan) > 1 && <span className="ml-auto rounded bg-indigo-500/15 px-1.5 text-[9px] tracking-[0.1em] text-indigo-300">DOT1Q {f.vlan}</span>}
                </div>
                <Field label="IP" value={f.addrs[0].ip} validate={okIp} onCommit={(v) => setTopo((t) => editIface(t, id, f.name, v, f.addrs[0].mask))} />
                <Field label="Mask" value={f.addrs[0].mask} validate={okMask} onCommit={(v) => setTopo((t) => editIface(t, id, f.name, f.addrs[0].ip, v))} />
                {f.addrs.slice(1).map((a) => <div key={a.ip} className="pl-[78px] font-mono text-[10.5px] text-zinc-500">secondary {a.ip}/{cidr(a.mask)}</div>)}
                {(f.hsrp || []).map((g) => <div key={g.vip} className="pl-[78px] font-mono text-[10.5px] text-indigo-300">HSRP {g.group} · VIP {g.vip}</div>)}
              </div>
            ))}
          </div>
          <div className={section}>
            <span className={micro}>Routing table</span>
            <MiniTable
              head={[['', '14px'], ['NETWORK', '1fr'], ['IFACE', '62px'], ['VIA', '56px'], ['', '16px']]}
              empty="empty · every packet will be dropped"
              rows={(d.routes || []).map((r, i) => [r.type, `${r.net}/${cidr(r.mask)}`, r.iface, r.via || 'conn.', <button key={i} onClick={() => patch({ routes: d.routes.filter((_, j) => j !== i) })} className="text-zinc-600 hover:text-[#F43F5E]"><Trash2 size={11} /></button>])}
            />
            <div className="mt-2 grid grid-cols-[1fr_74px] gap-1.5">
              <input value={nr.net} onChange={(e) => setNr({ ...nr, net: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="network 0.0.0.0" className="h-7 rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[11px] text-zinc-100 outline-none" />
              <select value={nr.iface || d.ifaces[0].name} onChange={(e) => setNr({ ...nr, iface: e.target.value })} className="h-7 rounded-md border border-white/[0.08] bg-[#0C0E14] px-1 font-mono text-[11px] text-zinc-100 outline-none">
                {d.ifaces.map((f) => <option key={f.name}>{f.name}</option>)}
              </select>
              <input value={nr.mask} onChange={(e) => setNr({ ...nr, mask: e.target.value })} onKeyDown={(e) => e.stopPropagation()} placeholder="mask" className="h-7 rounded-md border border-white/[0.08] bg-[#0C0E14] px-2 font-mono text-[11px] text-zinc-100 outline-none" />
              <button disabled={!isIp(nr.net) || !isMask(nr.mask)} onClick={() => { patch({ routes: [...d.routes, { net: netOf(nr.net, nr.mask), mask: nr.mask, iface: nr.iface || d.ifaces[0].name, via: nr.via, type: isIp(nr.via) ? 'S' : 'C' }] }); setNr({ net: '', mask: M24, iface: '', via: '' }); }} className="flex h-7 items-center justify-center gap-1 rounded-md bg-[#F3F4F6] font-mono text-[10px] font-semibold text-[#090A0F] disabled:opacity-30"><Plus size={12} /> ROUTE</button>
            </div>
          </div>
        </>
      )}

      {(isHost(d) || isRouter(d)) && (
        <div className={section}>
          <div className="flex items-center gap-2">
            <span className={micro}>ARP cache · frame {ev ? ev.no : 'end'}</span>
            <span className="ml-auto flex gap-1">
              <button title="Keep these entries for the next run (skips ARP)" onClick={() => patch({ arpStatic: Object.fromEntries(Object.entries((snap.arp || {})[id] || {}).map(([ip, e]) => [ip, { mac: e.mac, static: true }])) })} className={smallBtn}><Pin size={10} /> PIN</button>
              <button onClick={() => patch({ arpStatic: {} })} className={smallBtn}><Eraser size={10} /> CLEAR</button>
            </span>
          </div>
          <MiniTable head={[['IP', '1fr'], ['MAC', '118px'], ['TYPE', '50px']]} rows={arpRows} empty="empty · next packet triggers ARP" />
        </div>
      )}

      {isSwitch(d) && (
        <div className={section}>
          <div className="flex items-center gap-2">
            <span className={micro}>MAC table · frame {ev ? ev.no : 'end'}</span>
            <span className="ml-auto flex gap-1">
              <button title="Keep learned entries for the next run (no flooding)" onClick={() => patch({ macStatic: Object.fromEntries(Object.entries((snap.mac || {})[id] || {}).map(([k, e]) => [k, { ...e, static: true }])) })} className={smallBtn}><Pin size={10} /> PIN</button>
              <button onClick={() => patch({ macStatic: {} })} className={smallBtn}><Eraser size={10} /> CLEAR</button>
            </span>
          </div>
          <MiniTable head={[['VLAN', '34px'], ['MAC', '1fr'], ['PORT', '44px'], ['', '12px']]} rows={macRows} empty="empty · every unicast will flood" />
        </div>
      )}

      {mode === 'sandbox' && isHost(d) && !['pcA', 'dns', 'web'].includes(d.id) && (
        <button onClick={() => { setTopo((t) => removeDevice(t, id)); onDeleted(); }} className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-[#F43F5E]/30 font-mono text-[10px] tracking-[0.12em] text-[#FDA4AF] hover:bg-[#F43F5E]/10"><Trash2 size={12} /> REMOVE DEVICE</button>
      )}
    </div>
  );
}

/* ---------- network sequence ladder ---------- */
function SequenceModal({ sim, idx, seek, onClose, topo }) {
  const box = useRef(null);
  const ids = [];
  sim.events.forEach((e) => {
    (e.legs || []).forEach((l) => [l.from, l.to].forEach((x) => { if (!ids.includes(x)) ids.push(x); }));
    if (e.drop && e.at && !ids.includes(e.at)) ids.push(e.at);
  });
  const D = topo.devices;
  ids.sort((a, b) => ((D[a] && D[a].pos[0]) || 0) - ((D[b] && D[b].pos[0]) || 0) || ((D[a] && D[a].pos[1]) || 0) - ((D[b] && D[b].pos[1]) || 0));
  const colW = 118;
  const left = 96;
  const rowH = 30;
  const top = 14;
  const cx = (id) => left + ids.indexOf(id) * colW + colW / 2;
  const width = left + ids.length * colW + 20;
  const height = top + sim.events.length * rowH + 16;
  useEffect(() => {
    const c = box.current;
    if (!c) return;
    const y = top + idx * rowH;
    if (y < c.scrollTop + 30 || y > c.scrollTop + c.clientHeight - 60) c.scrollTop = y - c.clientHeight / 2;
  }, [idx]);
  const protos = [...new Set(sim.events.map((e) => e.proto))];
  return (
    <div className="nt-in pointer-events-auto absolute bottom-3 left-3 right-3 top-[52px] z-20 flex flex-col overflow-hidden rounded-xl border border-white/[0.09] bg-[#0E1016]/[0.97] shadow-[0_30px_80px_rgba(0,0,0,.6)] backdrop-blur-md">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.07] px-4">
        <ListTree size={14} className="text-zinc-400" />
        <span className={micro}>Network sequence</span>
        <span className="font-mono text-[10.5px] text-zinc-500">{sim.events.length} frames · {sim.duration.toFixed(3)}s end to end</span>
        <button onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-100"><X size={14} /></button>
      </div>
      <div ref={box} className="nt-scroll relative min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex h-9 items-center border-b border-white/[0.06] bg-[#0E1016]" style={{ width }}>
          <span className="absolute left-4 font-mono text-[9.5px] tracking-[0.14em] text-zinc-600">TIME</span>
          {ids.map((id) => (
            <span key={id} className="absolute -translate-x-1/2 whitespace-nowrap rounded-full border border-white/[0.08] bg-[#161922] px-2 py-[3px] font-mono text-[10px] text-zinc-200" style={{ left: cx(id) }}>
              {D[id] ? D[id].name : id}
            </span>
          ))}
        </div>
        <svg width={width} height={height} className="block">
          <defs>
            {protos.map((p) => (
              <marker key={p} id={`nt-arr-${p}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill={PROTO_COLOR[p]} />
              </marker>
            ))}
          </defs>
          {ids.map((id) => <line key={id} x1={cx(id)} x2={cx(id)} y1={0} y2={height} stroke="rgba(255,255,255,.08)" strokeDasharray="3 4" />)}
          {sim.events.map((e, i) => {
            const y = top + i * rowH + rowH / 2;
            const c = PROTO_COLOR[e.proto];
            const cur = i === idx;
            const legs = e.legs || [];
            const x1 = legs.length ? cx(legs[0].from) : cx(e.at);
            const xs = legs.map((l) => cx(l.to));
            const mid = legs.length ? (x1 + xs.reduce((a, b) => a + b, 0) / xs.length) / 2 : x1;
            const text = e.tag || e.info;
            return (
              <g key={i} onClick={() => seek(i)} className="cursor-pointer" opacity={i > idx ? 0.4 : 1}>
                <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill={cur ? 'rgba(255,255,255,.05)' : 'transparent'} />
                {cur && <rect x={0} y={y - rowH / 2} width={2} height={rowH} fill={c} />}
                <text x={16} y={y + 4} fill={cur ? '#F3F4F6' : '#71717A'} fontSize="10.5" fontFamily={FONT_MONO}>{e.t.toFixed(3)}s</text>
                {e.drop ? (
                  <g>
                    <path d={`M${x1 - 6} ${y - 6} l12 12 M${x1 + 6} ${y - 6} l-12 12`} stroke={PROTO_COLOR.DROP} strokeWidth="2" strokeLinecap="round" />
                    <text x={x1 + 14} y={y + 4} fill="#FDA4AF" fontSize="10" fontFamily={FONT_MONO}>DROP · {e.info}</text>
                  </g>
                ) : (
                  <>
                    {legs.map((l, k) => (
                      <line key={k} x1={x1} x2={cx(l.to) + (cx(l.to) > x1 ? -3 : 3)} y1={y} y2={y} stroke={c} strokeWidth={cur ? 2 : 1.4} strokeDasharray={legs.length > 1 ? '5 3' : undefined} markerEnd={`url(#nt-arr-${e.proto})`} opacity={legs.length > 1 && k > 0 ? 0.55 : 1} />
                    ))}
                    <circle cx={x1} cy={y} r="2.5" fill={c} />
                    <text x={mid} y={y - 5} textAnchor="middle" fill={c} fontSize="9.5" fontFamily={FONT_MONO} letterSpacing=".04em">{text.length > 30 ? text.slice(0, 29) + '…' : text}</text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ---------- root ---------- */
export default function NetTracer() {
  const [mode, setModeState] = useState('guided');
  const [labId, setLabId] = useState(LABS[0].id);
  const [cat, setCat] = useState('all');
  const [topo, setTopo] = useState(() => labTopology(LABS[0]));
  const [sbFlow, setSbFlow] = useState(LABS[0].flow);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [exploded, setExploded] = useState(false);
  const [showSeq, setShowSeq] = useState(false);
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);

  const lab = LABS.find((l) => l.id === labId) || LABS[0];
  const flow = mode === 'sandbox' ? sbFlow : lab.flow;
  const simKey = useMemo(() => JSON.stringify(topo, (k, v) => (k === 'pos' ? undefined : v)), [topo]);
  const flowKey = JSON.stringify(flow);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sim = useMemo(() => simulate(topo, flow), [simKey, flowKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const health = useMemo(() => analyze(topo, mode === 'guided' ? lab.focus : null), [simKey, lab.focus, mode]);
  const safeIdx = Math.min(idx, Math.max(0, sim.events.length - 1));
  const ev = sim.events[safeIdx] || null;
  const names = useMemo(() => Object.fromEntries(Object.values(topo.devices).map((d) => [d.id, d.name])), [topo]);

  const mountRef = useRef(null);
  const stageRef = useRef(null);
  const live = useRef({ events: [], idx: 0, progress: 0, playing: true, stepping: false, speed: 1, exploded: false, mode: 'guided', hold: 0 });
  const cbRef = useRef(null);
  cbRef.current = {
    onIndex: (i) => setIdx(i),
    onPlaying: (p) => setPlaying(p),
    onSelect: (id) => setSelected(id),
    onMove: (id, pos) => setTopo((t) => (t.devices[id] ? { ...t, devices: { ...t.devices, [id]: { ...t.devices[id], pos } } } : t)),
  };

  useEffect(() => {
    const s = createStage(mountRef.current, live.current, {
      onIndex: (i) => cbRef.current.onIndex(i),
      onPlaying: (p) => cbRef.current.onPlaying(p),
      onSelect: (id) => cbRef.current.onSelect(id),
      onMove: (id, p) => cbRef.current.onMove(id, p),
    });
    stageRef.current = s;
    return () => {
      s.dispose();
      stageRef.current = null;
    };
  }, []);
  useEffect(() => {
    if (stageRef.current) stageRef.current.sync(topo, selected);
  }, [topo, selected]);
  useEffect(() => {
    const L = live.current;
    Object.assign(L, { events: sim.events, idx: 0, progress: 0, hold: 0, playing: true, stepping: false });
    setIdx(0);
    setPlaying(true);
  }, [sim]);
  useEffect(() => { live.current.speed = speed; }, [speed]);
  useEffect(() => { live.current.exploded = exploded; }, [exploded]);
  useEffect(() => { live.current.mode = mode; }, [mode]);
  useEffect(() => {
    if (!toast) return undefined;
    const h = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  const seek = useCallback((i, progress = 0.55) => {
    const L = live.current;
    const n = Math.max(0, Math.min(L.events.length - 1, i));
    Object.assign(L, { idx: n, progress, playing: false, stepping: false, hold: 0 });
    setIdx(n);
    setPlaying(false);
  }, []);
  const togglePlay = useCallback(() => {
    const L = live.current;
    if (L.playing) {
      L.playing = false;
      setPlaying(false);
      return;
    }
    if (L.idx >= L.events.length - 1 && L.progress >= 1) {
      L.idx = 0;
      L.progress = 0;
      setIdx(0);
    }
    L.playing = true;
    setPlaying(true);
  }, []);
  const stepBy = useCallback((dlt) => {
    const L = live.current;
    const n = Math.max(0, Math.min(L.events.length - 1, L.idx + dlt));
    Object.assign(L, { idx: n, progress: 0, playing: false, stepping: true, hold: 0 });
    setIdx(n);
    setPlaying(false);
  }, []);
  const reset = useCallback(() => {
    Object.assign(live.current, { idx: 0, progress: 0, playing: false, stepping: false, hold: 0 });
    setIdx(0);
    setPlaying(false);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') stepBy(1);
      else if (e.key === 'ArrowLeft') stepBy(-1);
      else if (e.key === 'Escape') { setSelected(null); setShowSeq(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, stepBy]);

  const selectLab = (l) => {
    setLabId(l.id);
    setTopo(labTopology(l));
    setSbFlow(l.flow);
    setSelected(null);
    setTimeout(() => stageRef.current && stageRef.current.fit(), 80);
  };
  const setMode = (m) => {
    if (m === mode) return;
    if (m === 'sandbox') setSbFlow(lab.flow);
    setModeState(m);
  };
  const applyAction = (a) => {
    const addsRouter = a.fix.type === 'hsrp' && !topo.devices.r2;
    setTopo((t) => applyFix(t, a.fix));
    setToast({ msg: a.label, k: Date.now() });
    if (addsRouter) setTimeout(() => stageRef.current && stageRef.current.fit(), 90);
  };

  return (
    <div className="nt-root flex h-screen w-full min-w-[1180px] flex-col overflow-hidden bg-[#090A0F] text-[#F3F4F6] antialiased" style={{ fontFamily: FONT_SANS }}>
      <style>{CSS}</style>
      <Header lab={lab} mode={mode} setMode={setMode} ev={ev} names={names} health={health} />
      <div className="grid min-h-0 flex-1 grid-cols-[292px_minmax(0,1fr)_376px]">
        <aside className="min-h-0 bg-[#0C0E14]">
          {mode === 'guided' ? (
            <LabsPanel cat={cat} setCat={setCat} labId={labId} selectLab={selectLab} sim={sim} idx={safeIdx} seek={seek} names={names} />
          ) : (
            <SandboxPanel topo={topo} setTopo={setTopo} sbFlow={sbFlow} setSbFlow={setSbFlow} sim={sim} idx={safeIdx} seek={seek} onSelect={setSelected} names={names} />
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col border-x border-white/[0.07]">
          <div className="relative min-h-0 flex-[65] overflow-hidden bg-[#0C0E14]">
            <div ref={mountRef} className="absolute inset-0 isolate z-0" />
            <div className="z-10 pointer-events-none absolute left-4 top-4 max-w-[46%]">
              <div className={micro}>{mode === 'guided' ? `Lab ${lab.num} · ${CATS.find((c) => c.id === lab.cat).label}` : 'Sandbox topology builder'}</div>
              <div className="mt-1 truncate text-[15px] font-medium text-zinc-100">{mode === 'guided' ? lab.title : `${sbFlow.type.toUpperCase()} · ${names[sbFlow.src] || sbFlow.src} → ${sbFlow.dst || sbFlow.name}`}</div>
              <div className="mt-1 font-mono text-[10px] tracking-[0.08em] text-zinc-600">{Object.keys(topo.devices).length} DEVICES · {linksOf(topo).length} LINKS · {topo.vlans ? 'VLAN 10/20' : 'VLAN 1'}{topo.hsrp ? ' · HSRP' : ''}{topo.tls ? ' · TLS' : ''}</div>
            </div>
            <div className="z-10 absolute right-3 top-3 flex items-center gap-1.5">
              <button onClick={() => setExploded(!exploded)} className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[10px] tracking-[0.1em] backdrop-blur transition ${exploded ? 'border-white/25 bg-white/[0.1] text-zinc-50' : 'border-white/[0.08] bg-[#11131A]/90 text-zinc-400 hover:text-zinc-100'}`}>
                <Layers size={13} /> EXPLODE OSI LAYERS
              </button>
              <button onClick={() => setShowSeq(!showSeq)} className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[10px] tracking-[0.1em] backdrop-blur transition ${showSeq ? 'border-white/25 bg-white/[0.1] text-zinc-50' : 'border-white/[0.08] bg-[#11131A]/90 text-zinc-400 hover:text-zinc-100'}`}>
                <ListTree size={13} /> SEQUENCE
              </button>
              <button title="Fit view" onClick={() => stageRef.current && stageRef.current.fit()} className="grid h-8 w-8 place-items-center rounded-md border border-white/[0.08] bg-[#11131A]/90 text-zinc-400 backdrop-blur hover:text-zinc-100">
                <Scan size={13} />
              </button>
            </div>
            <div className="z-10 pointer-events-none absolute bottom-3 right-4 font-mono text-[9.5px] tracking-[0.12em] text-zinc-600">
              {mode === 'sandbox' ? 'DRAG DEVICE TO MOVE · DRAG FLOOR TO ORBIT · SCROLL ZOOM' : 'DRAG ORBIT · RIGHT-DRAG PAN · SCROLL ZOOM · CLICK A DEVICE'}
            </div>
            {selected && topo.devices[selected] && (
              <div className="z-10 pointer-events-none absolute bottom-3 left-3 top-[86px] flex items-end">
                <Inspector key={selected} id={selected} topo={topo} setTopo={setTopo} ev={ev} sim={sim} mode={mode} onClose={() => setSelected(null)} onDeleted={() => setSelected(null)} />
              </div>
            )}
            {showSeq && <SequenceModal sim={sim} idx={safeIdx} seek={seek} onClose={() => setShowSeq(false)} topo={topo} />}
            {toast && (
              <div key={toast.k} className="nt-in pointer-events-none absolute bottom-10 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-emerald-500/30 bg-[#0E1A16]/95 px-3.5 py-2 font-mono text-[10.5px] tracking-[0.06em] text-emerald-300 shadow-xl">
                <Check size={12} /> {toast.msg.toUpperCase()} · RE-RUNNING SIMULATION
              </div>
            )}
          </div>
          <div className="flex min-h-0 flex-[35] flex-col border-t border-white/[0.07] bg-[#0E1016]">
            <PlaybackBar speed={speed} setSpeed={setSpeed} playing={playing} togglePlay={togglePlay} stepBy={stepBy} reset={reset} idx={safeIdx} events={sim.events} seek={seek} />
            <CaptureTable events={sim.events} idx={safeIdx} seek={seek} />
          </div>
        </main>

        <aside className="min-h-0 bg-[#0C0E14]">
          <RightPanel key={mode + labId} sim={sim} idx={safeIdx} ev={ev} health={health} lab={lab} mode={mode} applyAction={applyAction} />
        </aside>
      </div>
    </div>
  );
}
