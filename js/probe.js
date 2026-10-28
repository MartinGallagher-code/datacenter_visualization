// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Martin J. Gallagher

// Host status: dcprobe's files for the layout's hosts, and what a loaded scan
// says about them. dcprobe reaches every host over ssh and writes how each is
// doing as overlay samples; this writes its hosts.txt -- each host by the
// layout's name, at its addr=, with the speed the layout gives its NIC -- and
// the commands, and reads a loaded scan back into the few lists worth a look.
// Nothing here runs anything. Pure, so it is testable.

import { hostToken } from './runfiles.js';
import { asFile } from './stamp.js';
import { overlayValue } from './results.js';

/** What the probe's script and archive are saved as. */
export const PROBE_SCRIPT = 'probe-hosts.sh';
export const PROBE_TAR = 'probe-hosts.tar';

/** The UDP ports each tool's run listens on, for preflight to find free. */
export const TOOL_PORTS = { mx: 5300, netmesh: 5310, iperf: 5001 };

/**
 * hosts.txt and the dcprobe commands for these hosts.
 *
 * @param hosts  the layout's hosts
 * @param opts   { speed: (el) => the layout's Gb/s for its NIC, or 0;
 *                 bind: the run's --bind, which is also the NIC to judge;
 *                 mtu; every: seconds between watch passes; whySlow;
 *                 tools: the run tools to be ready for -- mx, netmesh, iperf }
 */
export function probeFiles(hosts, { speed = () => 0, bind = '', mtu = 0, every = 30, whySlow = false, tools = ['mx', 'netmesh', 'iperf'], model = null } = {}) {
  const line = (el) => {
    const { name, addr } = hostToken(el);
    const gbps = speed(el);
    return `${addr === name ? name : `${name}=${addr}`}${gbps > 0 ? ` gbps=${Number(gbps.toPrecision(4))}` : ''}`;
  };
  const text = [
    '# dcprobe hosts -- name[=addr] and the speed the layout gives its NIC, a line',
    // What the scan calls the layout it writes into its results (--model).
    ...(model && model.name ? [`# layout: ${String(model.name).replace(/\s+/g, ' ')}`] : []),
    ...hosts.map(line),
    '',
  ].join('\n');
  const nic = bind ? ` --nic ${shellWord(bind)}` : '';
  // The layout goes with the results, as it does with a run's: loading
  // host_status.tsv brings back the floor plan the hosts were probed in.
  const withModel = model && model.text ? ' --model model.dc' : '';
  const mtuFlag = mtu ? ` --mtu ${mtu}` : '';
  const ws = whySlow ? ' --why-slow' : '';
  const ports = tools.map((t) => TOOL_PORTS[t]).filter(Boolean);
  // mx and netmesh copy their agents to each host and need only python3
  // there, which preflight always checks; iperf needs iperf2 on every host.
  const needs = tools.includes('iperf') ? ['iperf'] : [];
  return {
    // As a run tool's files are: saved alone, as a script, or as one archive
    // (runScript and runTar), under names of their own.
    tool: 'probe',
    label: 'dcprobe',
    what: 'how every host in the layout is doing',
    script: PROBE_SCRIPT,
    tar: PROBE_TAR,
    needs: [{ command: 'dcprobe', how: 'pip install datacenter-layout-viewer, or put the tools/ folder of a clone of datacenter_visualization on PATH' }],
    files: [
      { name: 'hosts.txt', text, note: `${hosts.length.toLocaleString()} host${hosts.length === 1 ? '' : 's'}` },
      ...(model && model.text ? [{ name: 'model.dc', text: asFile(model.text), note: `the layout${model.name ? `, ${model.name}` : ''}: written into the results` }] : []),
    ],
    commands: [
      '# can every host run the load? ssh, the tools, --bind, the ports, the clocks',
      `dcprobe preflight --servers hosts.txt${withModel} -o preflight.tsv${needs.length ? ` --tools ${needs.join(',')}` : ''}`
        + `${ports.length ? ` --ports ${ports.join(',')}` : ''}${bind ? ` --bind ${shellWord(bind)}` : ''}`,
      '# one look at every host: load host_status.tsv beside the layout',
      `dcprobe scan --servers hosts.txt${withModel} -o host_status.tsv${nic}${mtuFlag}${ws}`,
      `# ... or a look every ${every} s: the file always says how things are now, and Live (reload every N s) follows it`,
      `# dcprobe watch --servers hosts.txt${withModel} -o host_status.tsv --every ${every} --history host_history.tsv${nic}${mtuFlag}${ws}`,
      '# what changed since an earlier scan: kernels, firmware, NIC speeds and MTUs',
      '# dcprobe diff host_status-before.tsv host_status.tsv -o changes.tsv',
    ],
    notes: [
      'dcprobe reads each host over ssh -- load, CPU, memory, swap, disks, every NIC against the layout, kernel errors, '
        + 'the busiest processes, and what the host is -- and leaves nothing behind.',
      ...(bind ? [`Only the NICs matching ${bind} are judged against the layout’s speed${mtu ? ` and MTU ${mtu}` : ''}.`] : []),
      ...(whySlow ? ['--why-slow pipes binnacle’s why-slow to each host too; it needs python3 there and binnacle here.'] : []),
    ],
  };
}

const shellWord = (word) => (/^[\w.:/@%+=,-]+$/.test(word) ? word : `'${word}'`);

// What a loaded scan is worth a look for, and from which of its metrics.
// Each a verdict a host fails, or a reading over a line.
const CHECKS = [
  { key: 'unreachable', label: 'did not answer', severity: 'critical', test: 'probe_reach', bad: (v) => v === 'FAIL', why: 'probe_why' },
  { key: 'preflight', label: 'not ready to run', severity: 'critical', test: 'preflight', bad: (v) => v === 'FAIL', why: 'pre_why' },
  { key: 'preflight-warn', label: 'ready, with a warning', severity: 'warn', test: 'preflight', bad: (v) => v === 'WARN', why: 'pre_why' },
  { key: 'nic', label: 'NIC not as the layout says', severity: 'critical', test: 'nic_check', bad: (v) => v === 'FAIL', why: 'nic_why' },
  { key: 'nic-warn', label: 'a NIC to check', severity: 'warn', test: 'nic_check', bad: (v) => v === 'WARN', why: 'nic_why' },
  { key: 'whyslow', label: 'why-slow found trouble', severity: 'critical', test: 'whyslow_verdict', bad: (v) => v === 'FAIL', why: 'whyslow_top' },
  { key: 'whyslow-warn', label: 'why-slow has a warning', severity: 'warn', test: 'whyslow_verdict', bad: (v) => v === 'WARN', why: 'whyslow_top' },
  { key: 'kernel', label: 'kernel errors logged', severity: 'warn', test: 'host_kernel_errors', bad: (v) => v > 0, why: 'host_kernel_last', unit: '' },
  { key: 'cpu', label: 'CPU busy (90% or more)', severity: 'warn', test: 'host_cpu_pct', bad: (v) => v >= 90, unit: '%' },
  { key: 'load', label: 'more runnable than cores (load a core 1.5+)', severity: 'warn', test: 'host_load_per_core', bad: (v) => v >= 1.5, unit: '' },
  { key: 'iowait', label: 'waiting on I/O (20% or more)', severity: 'warn', test: 'host_iowait_pct', bad: (v) => v >= 20, unit: '%' },
  { key: 'mem', label: 'memory nearly full (90% or more)', severity: 'warn', test: 'host_mem_pct', bad: (v) => v >= 90, unit: '%' },
  { key: 'swap', label: 'swapping (25% of swap or more)', severity: 'warn', test: 'host_swap_pct', bad: (v) => v >= 25, unit: '%' },
  { key: 'disk', label: 'a disk nearly full (90% or more)', severity: 'warn', test: 'host_disk_pct', bad: (v) => v >= 90, unit: '%' },
  { key: 'changed', label: 'changed since the earlier scan', severity: 'warn', test: 'probe_changed', bad: (v) => v > 0, unit: '', why: 'probe_changed_what' },
];

/** The metrics dcprobe writes, by name: what makes a loaded overlay a scan's. */
export const PROBE_TESTS = new Set(['probe_reach', 'preflight', ...CHECKS.map((c) => c.test)]);

/**
 * A loaded scan, read back: how many hosts it covers, and each list of hosts
 * worth a look, most serious first, every host with what it said.
 *
 * @param overlays  the bound overlays, by test name
 * @param model     the layout they are bound to
 */
export function probeSummary(overlays, model) {
  const reach = overlays.get('probe_reach');
  if (!reach && !overlays.get('preflight')) return null;
  const hosts = (overlay) => (overlay ? [...overlay.direct].map((k) => model.byKey.get(k)).filter(Boolean) : []);
  const answered = hosts(reach).filter((el) => {
    const r = overlayValue(reach, el);
    return r && r.value === 'PASS';
  });
  const groups = [];
  for (const check of CHECKS) {
    const overlay = overlays.get(check.test);
    if (!overlay) continue;
    const found = [];
    for (const el of hosts(overlay)) {
      const r = overlayValue(overlay, el);
      if (!r || !check.bad(r.value)) continue;
      let text = typeof r.value === 'number' ? `${Number(r.value.toFixed(1))}${check.unit || ''}` : String(r.value);
      const said = check.why ? overlays.get(check.why) : null;
      const why = said && overlayValue(said, el);
      if (why && why.value !== '-') text += ` -- ${why.value}`;
      found.push({ el, text });
    }
    if (found.length) groups.push({ key: check.key, label: check.label, severity: check.severity, hosts: found });
  }
  return { probed: reach ? hosts(reach).length : hosts(overlays.get('preflight')).length, answered: answered.length, groups };
}
