# SPDX-License-Identifier: GPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Martin J. Gallagher
"""How every host is doing, as overlay samples the viewer paints.

    dcprobe scan      --servers hosts.txt -o host_status.tsv
    dcprobe watch     --servers hosts.txt -o host_status.tsv --every 30
    dcprobe preflight --servers hosts.txt -o preflight.tsv --bind data --tools mx,netmesh --ports 5300,5310
    dcprobe diff      old.tsv new.tsv

One shell script goes to each host over ssh -- nothing is installed there,
nothing is left behind -- and reads /proc and /sys twice, a second apart:
load, CPU (busy, iowait, steal), memory and swap, the fullest disk, every
physical NIC (link, speed, MTU, rates, errors and drops at the NIC, in its
rings and in the kernel's backlog), what the kernel logged since the last
pass, the busiest processes, and what the host is (kernel, OS, CPU, memory,
NIC driver and firmware). `--why-slow` also runs binnacle's why-slow there,
piped over the same ssh, and keeps its verdict and its first finding.

hosts.txt is the grammar mx and netmesh read -- `name[=addr]` a line -- with
what the host should be beside it, which the viewer writes from the layout:

    r1h1=10.1.1.11 gbps=25
    r1h2=10.1.1.12 gbps=25

A host that does not answer is a sample too (probe_reach FAIL, with the
reason), never a gap: a host missing from the floor plan's colours looks like
a host that is fine.

Every value is one sample on the host's own name, so the viewer reduces a
`watch` file's passes with the aggregation you pick there -- `last` is set as
each metric's default, which reads as "right now".
"""

import argparse
import concurrent.futures
import io
import json
import os
import re
import shlex
import subprocess
import sys
import time

from . import version_notice
from .dcimport import append

PROG = "dcprobe"

# ----------------------------------------------------------------- the probe
#
# POSIX sh and the tools every Linux box has. Positional arguments, so the
# one script serves every pass: $1 the sample interval in seconds, $2 how far
# back the kernel log is read, $3 how many processes to list. Sections start
# with @@name, and anything a host cannot answer is simply left out of its
# section: blank is "not measured", never zero.
PROBE = r"""
S=${1:-1}; TOPN=${3:-5}
nics() {
  for d in /sys/class/net/*; do
    [ -e "$d/device" ] || continue          # physical only: no lo, veth, bridges
    echo "${d##*/}"
  done
}
sample() {
  echo "@@stat$1"; grep '^cpu ' /proc/stat
  echo "@@netdev$1"; cat /proc/net/dev
  echo "@@softnet$1"; cat /proc/net/softnet_stat 2>/dev/null
  if command -v ethtool >/dev/null 2>&1; then
    for n in $(nics); do
      echo "@@ethtool$1 $n"
      ethtool -S "$n" 2>/dev/null | grep -Ei 'drop|discard|miss|fifo|no_buf|out_of_buf|nobuf' | grep -vi 'tx_'
    done
  fi
}
echo "@@meta"
echo "uptime $(cut -d' ' -f1 /proc/uptime)"
echo "loadavg $(cat /proc/loadavg)"
echo "nproc $(getconf _NPROCESSORS_ONLN 2>/dev/null || grep -c '^processor' /proc/cpuinfo)"
echo "hostname $(hostname 2>/dev/null || uname -n)"
sample 1
sleep "$S"
sample 2
echo "@@meminfo"; cat /proc/meminfo
echo "@@df"; df -P -k 2>/dev/null
echo "@@nics"
for n in $(nics); do
  d=/sys/class/net/$n
  drv=$(basename "$(readlink "$d/device/driver" 2>/dev/null)" 2>/dev/null)
  fw=""
  if command -v ethtool >/dev/null 2>&1; then
    fw=$(ethtool -i "$n" 2>/dev/null | sed -n 's/^firmware-version: *//p')
    i=$(ethtool -i "$n" 2>/dev/null | sed -n 's/^driver: *//p'); [ -n "$i" ] && drv=$i
  fi
  addr=$(ip -o -4 addr show dev "$n" 2>/dev/null | awk '{print $4}' | head -n 1)
  printf '%s|%s|%s|%s|%s|%s|%s\n' "$n" "$(cat "$d/operstate" 2>/dev/null)" \
    "$(cat "$d/speed" 2>/dev/null)" "$(cat "$d/mtu" 2>/dev/null)" "$drv" "$fw" "$addr"
done
echo "@@inventory"
echo "kernel $(uname -r)"
[ -r /etc/os-release ] && echo "os $(. /etc/os-release; echo "${PRETTY_NAME:-$NAME $VERSION}")"
echo "cpu $(grep -m1 -E '^(model name|Model|Hardware)' /proc/cpuinfo | cut -d: -f2-)"
echo "@@top"
ps -eo comm=,pcpu=,pmem= 2>/dev/null | grep -vE '^(ps|sort|head|grep) ' | sort -k2 -nr | head -n "$TOPN"
echo "@@dmesg"
if ! dmesg --level=emerg,alert,crit,err 2>/dev/null; then
  if ! journalctl -k -p 3 -o short-monotonic --no-pager -q 2>/dev/null | tail -n 200; then
    echo "@@dmesg-denied"
  fi
fi
"""

# Preflight: what a run needs before it starts. $1 --bind, $2 the tools, $3
# the UDP ports. No sleep: the time it prints is set against this machine's.
PREFLIGHT = r"""
BIND=$1; TOOLS=$2; PORTS=$3
echo "@@now $(date +%s.%N 2>/dev/null)"
echo "@@nofile $(ulimit -n 2>/dev/null)"
echo "@@python $(python3 --version 2>&1 | head -n 1)"
for t in $(echo "$TOOLS" | tr ',' ' '); do
  case "$t" in
    iperf) cmd=iperf; v=$(iperf -v 2>&1 | head -n 1) ;;
    iperf-orchestrator) cmd=iperf-orchestrator; v=$(iperf-orchestrator --version 2>&1 | head -n 1) ;;
    *) cmd=$t; v=$("$t" --version 2>&1 | head -n 1) ;;
  esac
  if command -v "$cmd" >/dev/null 2>&1; then echo "@@tool $t $v"; else echo "@@tool $t"; fi
done
if [ -n "$BIND" ]; then
  if command -v ip >/dev/null 2>&1; then
    echo "@@bind $(ip -o -4 addr show 2>/dev/null | grep -F -m1 -- "$BIND" | awk '{print $2, $4}')"
  else
    echo "@@bind-unknown"
  fi
fi
for p in $(echo "$PORTS" | tr ',' ' '); do
  hex=$(printf '%04X' "$p")
  if grep -qi ":$hex " /proc/net/udp /proc/net/udp6 2>/dev/null; then echo "@@port $p busy"; else echo "@@port $p free"; fi
done
"""

SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "StrictHostKeyChecking=accept-new"]

# ------------------------------------------------------------------ metadata
#
# (test, !test metadata). `agg=last` so a watch file reads as now; `finding=`
# so the viewer's Findings list counts the trouble, which is what a metric
# named host_nic_rx_drop_ps does not say on its own.
META = [
    ("probe_reach", 'short=REACH label="Answered the probe"'),
    ("probe_why", 'short=WHY label="Why it did not answer"'),
    ("host_load1", 'higher=bad decimals=2 agg=last short=LOAD label="Load, 1 min"'),
    ("host_load_per_core", 'higher=bad decimals=2 agg=last short=LPC label="Load per core, 1 min"'),
    ("host_cpu_pct", 'unit=% higher=bad decimals=1 agg=last min=0 max=100 short=CPU label="CPU busy"'),
    ("host_iowait_pct", 'unit=% higher=bad decimals=1 agg=last min=0 max=100 short=IOW label="CPU in iowait"'),
    ("host_steal_pct", 'unit=% higher=bad decimals=1 agg=last min=0 max=100 short=STL label="CPU stolen by the hypervisor"'),
    ("host_mem_pct", 'unit=% higher=bad decimals=1 agg=last min=0 max=100 short=MEM label="Memory in use"'),
    ("host_swap_pct", 'unit=% higher=bad decimals=1 agg=last min=0 max=100 short=SWP label="Swap in use"'),
    ("host_disk_pct", 'unit=% higher=bad decimals=0 agg=last min=0 max=100 short=DSK label="Fullest disk"'),
    ("host_uptime_h", 'unit=h higher=good decimals=1 agg=last short=UP label="Up for"'),
    ("host_softnet_drop_ps", 'unit=/s higher=bad decimals=1 agg=last finding=drops short=SND label="Kernel backlog drops a second"'),
    ("host_softnet_squeeze_ps", 'unit=/s higher=bad decimals=1 agg=last short=SQZ label="Kernel backlog out of budget a second"'),
    ("host_kernel_errors", 'higher=bad decimals=0 agg=last finding=errors short=KERR label="Kernel errors logged"'),
    ("host_kernel_last", 'short=KLOG label="Last kernel error"'),
    ("host_top", 'short=TOP label="Busiest processes, by ps %CPU"'),
    ("nic_link", 'short=LINK label="NIC link"'),
    ("nic_speed_gbps", 'unit=Gb/s higher=good decimals=0 agg=min short=SPD label="NIC speed"'),
    ("nic_mtu", 'unit=B higher=good decimals=0 agg=min short=MTU label="NIC MTU"'),
    ("nic_rx_gbps", 'unit=Gb/s higher=good decimals=3 agg=last short=RX label="NIC receiving"'),
    ("nic_tx_gbps", 'unit=Gb/s higher=good decimals=3 agg=last short=TX label="NIC sending"'),
    ("nic_rx_drop_ps", 'unit=/s higher=bad decimals=1 agg=last finding=drops short=RXD label="NIC receive drops a second"'),
    ("nic_tx_drop_ps", 'unit=/s higher=bad decimals=1 agg=last finding=drops short=TXD label="NIC send drops a second"'),
    ("nic_err_ps", 'unit=/s higher=bad decimals=1 agg=last finding=errors short=NERR label="NIC errors a second"'),
    ("nic_ring_drop_ps", 'unit=/s higher=bad decimals=1 agg=last finding=drops short=RING label="NIC ring and buffer drops a second"'),
    ("nic_check", 'finding=verdict short=NIC label="NIC as the layout says"'),
    ("inv_kernel", 'short=KERN label=Kernel'),
    ("inv_os", 'short=OS label="Operating system"'),
    ("inv_cpu", 'short=CPUM label="CPU model"'),
    ("inv_cores", 'decimals=0 short=CORE label=Cores'),
    ("inv_mem_gb", 'unit=GB decimals=0 short=RAM label=Memory'),
    ("inv_nic_driver", 'short=DRV label="NIC driver"'),
    ("inv_nic_fw", 'short=FW label="NIC firmware"'),
    ("whyslow_verdict", 'finding=verdict short=WS label="why-slow verdict"'),
    ("whyslow_top", 'short=WSF label="why-slow, first finding"'),
    ("preflight", 'finding=verdict short=PRE label="Ready to run"'),
    ("pre_why", 'short=PREW label="What would stop a run"'),
    ("pre_skew_ms", 'unit=ms higher=bad decimals=1 short=SKEW label="Clock off from here"'),
    ("pre_nofile", 'higher=good decimals=0 short=NOFI label="Open files allowed"'),
    ("pre_bind", 'short=BIND label="--bind on this host"'),
    ("pre_tools", 'short=TOOL label="Tools and versions"'),
]
META_BY = dict(META)

# What preflight wants: open files enough for a mesh of sockets, and clocks
# close enough that one host's stamps line up with another's.
NOFILE_MIN = 4096
SKEW_WARN_MS = 100.0
SKEW_FAIL_MS = 1000.0

BAD_TARGET = set(" \t\n\r,\"'")


def die(msg, code=2):
    sys.stderr.write("%s: %s\n" % (PROG, msg))
    sys.exit(code)


def cell(value):
    """A value as the results file reads it back: a number as it is, words
    quoted when they hold a separator, and never a quote of their own."""
    if isinstance(value, float):
        # Fixed point, never 3.2e-06: six places is a bit a second at Gb/s.
        text = ("%.6f" % value).rstrip("0").rstrip(".")
        return text if text not in ("", "-0") else "0"
    text = re.sub(r"\s+", " ", str(value)).replace('"', "'").strip()
    if not text:
        return '"-"'
    return '"%s"' % text if re.search(r"[\s,]", text) else text


class Out(object):
    def __init__(self):
        self.samples = []

    def add(self, test, host, value, **tags):
        if value is None or value == "":
            return
        self.samples.append((test, host, value, tags))

    def lines(self, stamp, with_meta=True):
        used = []
        for test, _h, _v, _t in self.samples:
            if test not in used:
                used.append(test)
        out = []
        if with_meta:
            out += ["!test\t%s\t%s" % (t, META_BY[t]) for t in used if t in META_BY]
        for test, host, value, tags in self.samples:
            extras = "".join("\t%s=%s" % (k, cell(v)) for k, v in sorted(tags.items())
                             if v is not None and v != "")
            out.append("%s\t%s\t%s\tat=%s%s" % (test, host, cell(value), stamp, extras))
        return out


# ------------------------------------------------------------------- hosts

def read_hosts(path):
    """hosts.txt: `name[=addr] [key=value ...]` a line, `#` comments. Returns
    [(name, addr, {key: value})]."""
    if not os.path.isfile(path):
        die("server list not found: %s" % path)
    hosts = []
    seen = set()
    with io.open(path, encoding="utf-8-sig", errors="replace") as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            words = line.split()
            name, _, addr = words[0].partition("=")
            addr = addr.rsplit(":", 1)[0] if addr.count(":") == 1 else addr
            if not name or set(name) & BAD_TARGET:
                die("%s:%d: %r is not a host name" % (path, n, words[0]))
            if name in seen:
                die("%s:%d: %s is listed twice" % (path, n, name))
            seen.add(name)
            want = {}
            for w in words[1:]:
                k, eq, v = w.partition("=")
                if not eq:
                    die("%s:%d: %r is not key=value" % (path, n, w))
                want[k] = v
            hosts.append((name, addr or name, want))
    if not hosts:
        die("%s lists no hosts" % path)
    return hosts


def ssh_run(args, addr, remote, body, timeout):
    """Run `remote` on addr with `body` on its stdin. Returns (rc, stdout,
    stderr); a host that does not answer is rc 124 or 255, never an
    exception."""
    target = "%s@%s" % (args.user, addr) if args.user else addr
    cmd = shlex.split(args.ssh) + SSH_OPTS + [target, remote]
    try:
        p = subprocess.run(cmd, input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=timeout, errors="replace")
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "no answer in %ds" % timeout
    except OSError as exc:
        return 127, "", str(exc)


def ssh_why(err, rc):
    """Why a host did not answer, in ssh's own last words."""
    why = (err.strip().splitlines() or ["exited %d" % rc])[-1].strip()
    return (why if why.startswith("ssh") else "ssh: " + why)[:160]


def sh_args(*words):
    """`sh -s --` and its arguments, quoted once for the remote shell."""
    return "sh -s -- %s" % " ".join(shlex.quote(str(w)) for w in words)


# ------------------------------------------------------------------ parsing

def sections(text):
    """@@name lines open sections; returns {name: [lines]}. A section header
    may carry words after its name (`@@ethtool1 eth0`)."""
    out = {}
    cur = None
    for line in text.splitlines():
        if line.startswith("@@"):
            cur = line[2:].strip()
            out.setdefault(cur, [])
            continue
        if cur is not None:
            out[cur].append(line)
    return out


def _cpu(lines):
    for line in lines:
        f = line.split()
        if f and f[0] == "cpu":
            return [int(x) for x in f[1:9]] + [0] * max(0, 8 - len(f[1:9]))
    return None


def _netdev(lines):
    out = {}
    for line in lines:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        f = rest.split()
        if len(f) >= 16:
            out[name.strip()] = [int(x) for x in f[:16]]
    return out


def _softnet(lines):
    drop = squeeze = 0
    for line in lines:
        f = line.split()
        if len(f) >= 3:
            drop += int(f[1], 16)
            squeeze += int(f[2], 16)
    return drop, squeeze


def _counters(lines):
    total = 0
    for line in lines:
        k, _, v = line.partition(":")
        try:
            total += int(v.strip())
        except ValueError:
            pass
    return total


def _meminfo(lines):
    m = {}
    for line in lines:
        k, _, v = line.partition(":")
        f = v.split()
        if f:
            try:
                m[k.strip()] = int(f[0])
            except ValueError:
                pass
    return m


IGNORE_FS = ("/proc", "/sys", "/dev", "/run", "/snap", "/var/lib/docker", "/boot/efi")


def _fullest(lines):
    best = None
    for line in lines[1:]:
        f = line.split()
        if len(f) < 6 or not f[4].endswith("%"):
            continue
        mount = f[5]
        if f[0] in ("tmpfs", "devtmpfs", "overlay", "squashfs", "none", "udev") \
                or mount.startswith(IGNORE_FS):
            continue
        try:
            pct = float(f[4][:-1])
        except ValueError:
            continue
        if best is None or pct > best[0]:
            best = (pct, mount)
    return best


def _dmesg(lines, uptime, since):
    """Kernel errors logged in the last `since` seconds, by their stamp
    against the host's uptime. Returns (count, last message)."""
    count, last = 0, ""
    for line in lines:
        m = re.match(r"\s*\[\s*(\d+\.\d+)\]\s*(.*)", line)
        if not m:
            continue
        if since and uptime is not None and float(m.group(1)) < uptime - since:
            continue
        count += 1
        last = m.group(2).strip()
    return count, last


def read_probe(host, text, seconds, since, want, out):
    """One host's probe output, as samples on `out`."""
    s = sections(text)
    meta = {}
    for line in s.get("meta", []):
        k, _, v = line.partition(" ")
        meta[k] = v.strip()
    try:
        uptime = float(meta.get("uptime", ""))
    except ValueError:
        uptime = None
    try:
        nproc = int(meta.get("nproc", "0"))
    except ValueError:
        nproc = 0
    load = meta.get("loadavg", "").split()
    if load:
        l1 = float(load[0])
        out.add("host_load1", host, l1)
        if nproc:
            out.add("host_load_per_core", host, l1 / nproc)
    if uptime is not None:
        out.add("host_uptime_h", host, uptime / 3600.0)

    c1, c2 = _cpu(s.get("stat1", [])), _cpu(s.get("stat2", []))
    if c1 and c2:
        d = [b - a for a, b in zip(c1, c2)]
        total = float(sum(d)) or 1.0
        user, nice, system, idle, iowait, irq, softirq, steal = d
        out.add("host_cpu_pct", host, 100.0 * (total - idle - iowait) / total)
        out.add("host_iowait_pct", host, 100.0 * iowait / total)
        out.add("host_steal_pct", host, 100.0 * steal / total)

    mem = _meminfo(s.get("meminfo", []))
    if mem.get("MemTotal"):
        avail = mem.get("MemAvailable", mem.get("MemFree", 0) + mem.get("Cached", 0))
        out.add("host_mem_pct", host, 100.0 * (mem["MemTotal"] - avail) / mem["MemTotal"])
        out.add("inv_mem_gb", host, round(mem["MemTotal"] / 1048576.0))
    if mem.get("SwapTotal"):
        out.add("host_swap_pct", host, 100.0 * (mem["SwapTotal"] - mem.get("SwapFree", 0)) / mem["SwapTotal"])
    elif "SwapTotal" in mem:
        out.add("host_swap_pct", host, 0.0)

    full = _fullest(s.get("df", []))
    if full:
        out.add("host_disk_pct", host, full[0], mount=full[1])

    sn1, sn2 = _softnet(s.get("softnet1", [])), _softnet(s.get("softnet2", []))
    if s.get("softnet1") and s.get("softnet2"):
        out.add("host_softnet_drop_ps", host, max(0, sn2[0] - sn1[0]) / seconds)
        out.add("host_softnet_squeeze_ps", host, max(0, sn2[1] - sn1[1]) / seconds)

    # The NICs: link, speed and MTU against what the layout says, then what
    # moved through each and what each dropped over the sample.
    nd1, nd2 = _netdev(s.get("netdev1", [])), _netdev(s.get("netdev2", []))
    want_gbps = _num(want.get("gbps"))
    want_mtu = _num(want.get("mtu")) or _MTU["mtu"] or None
    problems = []
    nics = [line.split("|", 6) for line in s.get("nics", []) if line.count("|") >= 6]
    # With a pattern -- the run's --bind, or nic= on the host's line -- only
    # the NICs it names are judged; without one, a NIC that is down is
    # listed but not held against the host, since most boxes have ports
    # nobody cabled.
    match = want.get("nic") or args_nic(out)
    if match:
        nics = [n for n in nics if match in n[0] or match in n[6]]
    for name, state, speed, mtu, drv, fw, addr in nics:
        tags = {"nic": name}
        up = state == "up"
        out.add("nic_link", host, "PASS" if up else "FAIL", **tags)
        gbps = _num(speed)
        gbps = gbps / 1000.0 if gbps is not None and gbps > 0 else None
        if gbps:
            out.add("nic_speed_gbps", host, gbps, **tags)
        mtu_n = _num(mtu)
        if mtu_n:
            out.add("nic_mtu", host, mtu_n, **tags)
        out.add("inv_nic_driver", host, drv, **tags)
        out.add("inv_nic_fw", host, fw, **tags)
        if name in nd1 and name in nd2:
            dd = [max(0, y - x) for x, y in zip(nd1[name], nd2[name])]
            out.add("nic_rx_gbps", host, dd[0] * 8 / 1e9 / seconds, **tags)
            out.add("nic_tx_gbps", host, dd[8] * 8 / 1e9 / seconds, **tags)
            out.add("nic_rx_drop_ps", host, dd[3] / seconds, **tags)
            out.add("nic_tx_drop_ps", host, dd[11] / seconds, **tags)
            out.add("nic_err_ps", host, (dd[2] + dd[10]) / seconds, **tags)
        e1, e2 = s.get("ethtool1 %s" % name), s.get("ethtool2 %s" % name)
        if e1 is not None and e2 is not None:
            out.add("nic_ring_drop_ps", host, max(0, _counters(e2) - _counters(e1)) / seconds, **tags)
        if not up:
            if match:
                problems.append("%s is %s" % (name, state or "down"))
            continue
        if want_gbps and gbps and gbps < want_gbps:
            problems.append("%s at %gG, the layout says %gG" % (name, gbps, want_gbps))
        if want_mtu and mtu_n and mtu_n != want_mtu:
            problems.append("%s MTU %d, the run's is %d" % (name, mtu_n, want_mtu))
    if nics:
        # One verdict a host: FAIL when no NIC it should use is up, or none
        # is at the layout's speed; WARN for anything else said above.
        live = [n for n in nics if n[1] == "up"]
        # A NIC that reports no speed -- a VM's, most often -- is not held
        # against the host: unknown is not slow.
        fast = [n for n in live if not want_gbps or not (_num(n[2]) or 0) > 0
                or _num(n[2]) / 1000.0 >= want_gbps]
        if not live:
            problems = problems or ["no NIC is up"]
            verdict = "FAIL"
        elif not fast:
            verdict = "FAIL"
        else:
            verdict = "WARN" if problems else "PASS"
        out.add("nic_check", host, verdict, why="; ".join(problems))

    inv = {}
    for line in s.get("inventory", []):
        k, _, v = line.partition(" ")
        inv[k] = v.strip()
    out.add("inv_kernel", host, inv.get("kernel"))
    out.add("inv_os", host, inv.get("os"))
    out.add("inv_cpu", host, re.sub(r"\s+", " ", inv.get("cpu", "")).strip())
    if nproc:
        out.add("inv_cores", host, nproc)

    top = []
    for line in s.get("top", []):
        f = line.split()
        if len(f) >= 3:
            top.append("%s %s%%" % (" ".join(f[:-2]), f[-2]))
    if top:
        out.add("host_top", host, " · ".join(top))

    if "dmesg-denied" in s:
        out.add("host_kernel_last", host, "the kernel log needs root here")
    else:
        count, last = _dmesg(s.get("dmesg", []), uptime, since)
        out.add("host_kernel_errors", host, count)
        if last:
            out.add("host_kernel_last", host, last[:160])


_NIC = {"match": ""}
_MTU = {"mtu": 0}


def args_nic(_out):
    """The --nic pattern given on the command line, for hosts whose line
    names none."""
    return _NIC["match"]


def _num(text):
    try:
        v = float(text)
    except (TypeError, ValueError):
        return None
    return v


# ------------------------------------------------------------------ why-slow

def why_slow_source(path):
    """why-slow's own file, to pipe to each host: the one named, or the one
    installed with binnacle."""
    if path:
        if not os.path.isfile(path):
            die("--why-slow-file %s: not found" % path)
        return io.open(path, encoding="utf-8").read()
    try:
        from binnacle import why_slow  # noqa: F401
        return io.open(why_slow.__file__, encoding="utf-8").read()
    except ImportError:
        die("--why-slow needs binnacle's why_slow.py: pip install binnacle, "
            "or pass --why-slow-file (binnacle copy why-slow writes it here)")


def read_why_slow(host, text, out):
    try:
        doc = json.loads(text)
    except ValueError:
        out.add("whyslow_verdict", host, "WARN", why="why-slow gave no answer")
        return
    findings = doc.get("findings") or []
    worst = "INFO"
    order = {"INFO": 1, "WARN": 2, "CRITICAL": 3}
    for f in findings:
        if order.get(f.get("severity"), 0) > order[worst]:
            worst = f.get("severity")
    out.add("whyslow_verdict", host, {"CRITICAL": "FAIL", "WARN": "WARN"}.get(worst, "PASS"))
    serious = [f for f in findings if f.get("severity") in ("CRITICAL", "WARN")]
    if serious:
        f = serious[0]
        out.add("whyslow_top", host, "%s: %s" % (f.get("title", ""), f.get("detail", ""))[:200])


# ------------------------------------------------------------------- verbs

def one_pass(args, hosts, since, why_src):
    out = Out()

    def probe(entry):
        name, addr, want = entry
        rc, text, err = ssh_run(args, addr, sh_args(args.sample, since, args.top), PROBE,
                                timeout=args.timeout + args.sample)
        ws = None
        if rc == 0 and why_src is not None:
            ws = ssh_run(args, addr, "python3 - --json", why_src, timeout=args.timeout + 10)
        return entry, rc, text, err, ws

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        results = list(pool.map(probe, hosts))
    down = 0
    for (name, _addr, want), rc, text, err, ws in results:
        if rc != 0 or "@@meta" not in text:
            down += 1
            out.add("probe_reach", name, "FAIL")
            out.add("probe_why", name, ssh_why(err, rc))
            continue
        out.add("probe_reach", name, "PASS")
        read_probe(name, text, float(args.sample), since, want, out)
        if ws is not None:
            wrc, wtext, werr = ws
            if wtext.strip().startswith("{"):
                read_why_slow(name, wtext, out)
            else:
                why = (werr.strip().splitlines() or ["exit %d" % wrc])[-1]
                out.add("whyslow_verdict", name, "WARN", why=("why-slow did not run: " + why)[:160])
    return out, down


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write(args, out, header=None):
    lines = out.lines(stamp(), with_meta=not args.no_meta)
    if header and lines:
        lines.insert(0, header)
    if args.output == "-":
        for line in lines:
            sys.stdout.write(line + "\n")
        sys.stdout.flush()
        return len(lines)
    if not args.append and os.path.exists(args.output):
        os.remove(args.output)
    return append(args.output, lines)


def cmd_scan(args):
    hosts = read_hosts(args.servers)
    why_src = why_slow_source(args.why_slow_file) if args.why_slow else None
    out, down = one_pass(args, hosts, args.dmesg_since, why_src)
    write(args, out, "# dcprobe %s: %d hosts, %d did not answer" % (stamp(), len(hosts), down))
    _summary(hosts, out, down, args)
    return 1 if down else 0


def cmd_watch(args):
    hosts = read_hosts(args.servers)
    why_src = why_slow_source(args.why_slow_file) if args.why_slow else None
    since = args.dmesg_since
    passes = 0
    try:
        while True:
            started = time.time()
            out, down = one_pass(args, hosts, since, why_src)
            write(args, out, "# dcprobe %s: %d hosts, %d did not answer" % (stamp(), len(hosts), down))
            passes += 1
            if not args.quiet:
                sys.stderr.write("%s: pass %d at %s: %d hosts, %d did not answer\n"
                                 % (PROG, passes, stamp(), len(hosts), down))
            if args.passes and passes >= args.passes:
                return 0
            # From the second pass on, only what the kernel logged since the last.
            since = args.every
            time.sleep(max(0.0, args.every - (time.time() - started)))
    except KeyboardInterrupt:
        return 0


def cmd_preflight(args):
    hosts = read_hosts(args.servers)
    out = Out()

    def check(entry):
        name, addr, _want = entry
        t0 = time.time()
        rc, text, err = ssh_run(args, addr, sh_args(args.bind, args.tools, args.ports), PREFLIGHT,
                                timeout=args.timeout)
        t1 = time.time()
        return entry, rc, text, err, t0, t1

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        results = list(pool.map(check, hosts))
    failed = 0
    tools = [t for t in args.tools.split(",") if t]
    for (name, _addr, _want), rc, text, err, t0, t1 in results:
        if rc != 0 or "@@now" not in text:
            failed += 1
            why = ssh_why(err, rc)
            out.add("probe_reach", name, "FAIL")
            out.add("preflight", name, "FAIL", why=why)
            out.add("pre_why", name, why)
            continue
        out.add("probe_reach", name, "PASS")
        fails, warns, have = [], [], []
        for line in text.splitlines():
            f = line.split()
            if not f:
                continue
            if f[0] == "@@now" and len(f) > 1:
                try:
                    skew = (float(f[1]) - (t0 + t1) / 2.0) * 1000.0
                    out.add("pre_skew_ms", name, abs(skew), ssh_ms="%.0f" % ((t1 - t0) * 1000))
                    # Within the ssh round trip it cannot be told from none.
                    slack = (t1 - t0) * 500.0
                    if abs(skew) - slack > SKEW_FAIL_MS:
                        fails.append("clock %+.0f ms" % skew)
                    elif abs(skew) - slack > SKEW_WARN_MS:
                        warns.append("clock %+.0f ms" % skew)
                except ValueError:
                    warns.append("no clock (date +%s.%N)")
            elif f[0] == "@@nofile" and len(f) > 1:
                if f[1] == "unlimited":
                    out.add("pre_nofile", name, 1e9)
                elif f[1].isdigit():
                    out.add("pre_nofile", name, float(f[1]))
                    if int(f[1]) < NOFILE_MIN:
                        warns.append("ulimit -n %s" % f[1])
            elif f[0] == "@@python":
                if len(f) < 3 or not f[1].lower().startswith("python"):
                    fails.append("no python3")
            elif f[0] == "@@tool" and len(f) > 1:
                if len(f) == 2:
                    fails.append("no %s" % f[1])
                else:
                    have.append("%s %s" % (f[1], " ".join(f[2:])))
            elif f[0] == "@@bind-unknown":
                warns.append("no ip command, so --bind %s could not be checked" % args.bind)
            elif f[0] == "@@bind":
                if len(f) < 3:
                    fails.append("--bind %s matches nothing" % args.bind)
                    out.add("pre_bind", name, "FAIL")
                else:
                    out.add("pre_bind", name, "%s %s" % (f[1], f[2].split("/")[0]))
            elif f[0] == "@@port" and len(f) == 3 and f[2] == "busy":
                fails.append("UDP port %s in use" % f[1])
        if tools:
            out.add("pre_tools", name, " · ".join(have) if have else "none")
        verdict = "FAIL" if fails else ("WARN" if warns else "PASS")
        why = "; ".join(fails + warns)
        if verdict != "PASS":
            failed += verdict == "FAIL"
            out.add("pre_why", name, why[:160])
        out.add("preflight", name, verdict, why=why[:160] if why else "")
    write(args, out, "# dcprobe preflight %s: %d hosts, %d not ready" % (stamp(), len(hosts), failed))
    if not args.quiet:
        for test, host, value, tags in out.samples:
            if test == "preflight":
                sys.stderr.write("  %-24s %-4s %s\n" % (host, value, tags.get("why", "")))
        sys.stderr.write("%s: %d of %d hosts ready%s\n" % (PROG, len(hosts) - failed, len(hosts),
                                                            "" if not failed else " -- fix those before the run"))
    return 1 if failed else 0


# What a host is, and its NICs' settings: what diff compares.
DIFF_TESTS = ("inv_kernel", "inv_os", "inv_cpu", "inv_cores", "inv_mem_gb", "inv_nic_driver",
              "inv_nic_fw", "nic_speed_gbps", "nic_mtu", "nic_link", "probe_reach")


def read_results(path):
    """{(test, host, nic): value} from a dcprobe file, the last pass winning."""
    if not os.path.isfile(path):
        die("not found: %s" % path)
    got = {}
    with io.open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line.strip() or line.startswith(("#", "!")):
                continue
            f = re.findall(r'"[^"]*"|\S+', line.rstrip("\n").replace("\t", " "))
            if len(f) < 3 or f[0] not in DIFF_TESTS:
                continue
            tags = dict(t.split("=", 1) for t in f[3:] if "=" in t)
            got[(f[0], f[1], tags.get("nic", "").strip('"'))] = f[2].strip('"')
    return got


def cmd_diff(args):
    old, new = read_results(args.old), read_results(args.new)
    changes = {}
    for key in sorted(set(old) | set(new)):
        a, b = old.get(key), new.get(key)
        if a == b:
            continue
        test, host, nic = key
        what = "%s%s: %s -> %s" % (test.replace("inv_", ""), " " + nic if nic else "",
                                   a if a is not None else "(none)", b if b is not None else "(none)")
        changes.setdefault(host, []).append(what)
    for host in sorted(changes):
        print("%s" % host)
        for what in changes[host]:
            print("  %s" % what)
    if not changes:
        print("no host changed what it is between the two scans")
    if args.output:
        out = Out()
        hosts = sorted(set(k[1] for k in list(old) + list(new)))
        for host in hosts:
            out.add("probe_changed", host, float(len(changes.get(host, []))),
                    what="; ".join(changes.get(host, []))[:200])
        META_BY.setdefault("probe_changed", 'higher=bad decimals=0 finding=errors short=CHG '
                                            'label="Changed since the earlier scan"')
        args.verb = "diff"
        write(args, out, "# dcprobe diff %s -> %s" % (args.old, args.new))
    return 1 if changes else 0


def _summary(hosts, out, down, args):
    if args.quiet:
        return
    sys.stderr.write("%s: %d hosts, %d answered" % (PROG, len(hosts), len(hosts) - down))
    sys.stderr.write(" -> %s\n" % args.output)
    for test, host, value, tags in out.samples:
        if test == "probe_reach" and value == "FAIL":
            sys.stderr.write("  %-24s did not answer\n" % host)
        if test in ("nic_check", "whyslow_verdict") and value != "PASS":
            sys.stderr.write("  %-24s %s %s %s\n" % (host, test, value, tags.get("why", "")))


def main(argv=None):
    ap = argparse.ArgumentParser(prog=PROG, description="How every host is doing, as overlay samples.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--version", action="version", version=version_notice(PROG))
    sub = ap.add_subparsers(dest="verb")

    def fleet(p, default_out):
        p.add_argument("--servers", default="hosts.txt", metavar="FILE",
                       help="name[=addr] [gbps=N mtu=N nic=PATTERN] a line (default hosts.txt)")
        p.add_argument("-o", "--output", default=default_out, metavar="FILE", help="results file ('-' for stdout)")
        p.add_argument("--user", default=os.environ.get("DCPROBE_USER", ""))
        p.add_argument("--ssh", default=os.environ.get("DCPROBE_SSH", "ssh"), metavar="CMD")
        p.add_argument("--jobs", type=int, default=32, help="hosts probed at once (default 32)")
        p.add_argument("--timeout", type=int, default=20, help="seconds a host has to answer (default 20)")
        p.add_argument("--no-meta", action="store_true", help="no !test lines")
        p.add_argument("--quiet", action="store_true")

    def probing(p):
        p.add_argument("--sample", type=float, default=1.0, metavar="SECS",
                       help="how long rates are measured over (default 1)")
        p.add_argument("--top", type=int, default=5, help="processes listed (default 5)")
        p.add_argument("--dmesg-since", type=float, default=3600.0, metavar="SECS",
                       help="kernel errors this far back (default an hour; watch: since the last pass)")
        p.add_argument("--why-slow", action="store_true", help="run binnacle's why-slow on each host too")
        p.add_argument("--why-slow-file", metavar="PATH", help="why_slow.py, if binnacle is not installed here")
        p.add_argument("--nic", default="", metavar="PATTERN",
                       help="judge only the NICs whose name or address holds this (the run's --bind)")
        p.add_argument("--mtu", type=int, default=0, help="the MTU every judged NIC should have")

    s = sub.add_parser("scan", help="one pass over every host")
    fleet(s, "host_status.tsv")
    probing(s)
    s.add_argument("--append", action="store_true", help="add to the file rather than replace it")
    w = sub.add_parser("watch", help="a pass every --every seconds, appended")
    fleet(w, "host_status.tsv")
    probing(w)
    w.add_argument("--every", type=float, default=30.0, metavar="SECS")
    w.add_argument("--passes", type=int, default=0, help="stop after this many (default: until Ctrl-C)")
    pf = sub.add_parser("preflight", help="can every host run the load?")
    fleet(pf, "preflight.tsv")
    pf.add_argument("--append", action="store_true", help="add to the file rather than replace it")
    pf.add_argument("--bind", default="", help="the --bind the run will use")
    pf.add_argument("--tools", default="", help="comma-separated: mx, iperf, iperf-orchestrator, netmesh, ...")
    pf.add_argument("--ports", default="", help="UDP ports the run listens on, comma-separated")
    d = sub.add_parser("diff", help="what changed between two scans")
    d.add_argument("old")
    d.add_argument("new")
    d.add_argument("-o", "--output", default="", metavar="FILE", help="also write probe_changed per host")
    d.add_argument("--no-meta", action="store_true")
    args = ap.parse_args(argv)
    if not args.verb:
        ap.print_help()
        return 2
    _NIC["match"] = getattr(args, "nic", "")
    _MTU["mtu"] = getattr(args, "mtu", 0)
    args.append = getattr(args, "append", False) or args.verb == "watch"
    return {"scan": cmd_scan, "watch": cmd_watch, "preflight": cmd_preflight, "diff": cmd_diff}[args.verb](args)


if __name__ == "__main__":
    sys.exit(main())
