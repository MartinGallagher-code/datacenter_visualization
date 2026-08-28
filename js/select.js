// Selector predicates, shared by `link` rules in the DSL and by the UI filter box.
//
// A selector is a comma-separated AND-list of predicates:
//
//   +gpu              element (or an ancestor) carries the tag `gpu`
//   ^gpu              the tag is written on the element itself, not inherited
//   kind=rack         element kind
//   role=tor          attribute equals (glob-aware, inherited attrs count)
//   DH1/A/*           glob against id, name or full path
//   !+decom           negation of any predicate
//   +gpu|+fpga        OR between alternatives
//
// Matching is case-insensitive throughout; datacenter inventories are typed by hand.

export function globToRegExp(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                   .replace(/\*/g, '.*')
                   .replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function matchValue(value, pattern) {
  if (value === undefined || value === null) return false;
  return /[*?]/.test(pattern) ? globToRegExp(pattern).test(String(value)) : eq(value, pattern);
}

// One predicate, no commas, no pipes, no leading '!'.
function compileAtom(atom) {
  if (atom.startsWith('+')) {
    const tag = atom.slice(1).toLowerCase();
    return (el) => el.tagsAll.has(tag);
  }
  if (atom.startsWith('^')) {
    const tag = atom.slice(1).toLowerCase();
    return (el) => el.tags.has(tag);
  }

  const eqAt = atom.indexOf('=');
  if (eqAt > 0) {
    const key = atom.slice(0, eqAt).toLowerCase();
    const val = atom.slice(eqAt + 1);
    if (key === 'kind') return (el) => matchValue(el.kind, val);
    if (key === 'id') return (el) => matchValue(el.id, val);
    if (key === 'name') return (el) => matchValue(el.name, val);
    if (key === 'path') return (el) => matchValue(el.path, val);
    if (key === 'tag') return (el) => [...el.tagsAll].some((t) => matchValue(t, val));
    return (el) => matchValue(el.attrsEff[key], val);
  }

  // Bare token: glob over identity fields, and over the id of any ancestor so that
  // `DH1` selects everything in that room.
  const re = globToRegExp(atom);
  return (el) => {
    if (re.test(el.id) || re.test(el.name) || re.test(el.path)) return true;
    for (let p = el.parent; p; p = p.parent) if (re.test(p.id)) return true;
    return false;
  };
}

function compileTerm(term) {
  const alternatives = term.split('|').filter(Boolean).map((alt) => {
    let negate = false;
    while (alt.startsWith('!')) { negate = !negate; alt = alt.slice(1); }
    const fn = compileAtom(alt);
    return negate ? (el) => !fn(el) : fn;
  });
  if (alternatives.length === 1) return alternatives[0];
  return (el) => alternatives.some((fn) => fn(el));
}

export function compileSelector(selector) {
  const terms = String(selector).split(',').map((s) => s.trim()).filter(Boolean).map(compileTerm);
  if (!terms.length) return () => true;
  return (el) => terms.every((fn) => fn(el));
}
