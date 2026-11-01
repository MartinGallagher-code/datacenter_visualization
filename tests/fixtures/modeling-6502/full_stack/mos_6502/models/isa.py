"""Stand-in (see README.md): a five-row cycle table and a mix priced off it."""

TABLE = {
    ("TAX", "implied"): 2,
    ("LDA", "zeropage"): 3,
    ("STA", "zeropage"): 3,
    ("LDA", "absolute"): 4,
    ("STA", "absolute"): 4,
    ("LDA", "absolute,X"): 4,
}

# CPI 0.5*2 + 0.2*3 + 0.2*4 + 0.1*(0.6*3 + 0.4*2) = 2.66
TYPICAL_MIX = {
    ("TAX", "implied"): 0.5,
    ("LDA", "zeropage"): 0.1,
    ("STA", "zeropage"): 0.1,
    ("LDA", "absolute"): 0.1,
    ("STA", "absolute"): 0.1,
    "branch": 0.1,
}


def cycles_for(mnemonic, mode):
    try:
        return TABLE[(mnemonic, mode)]
    except KeyError:
        raise KeyError(f"{mnemonic} {mode}")


def mix_cpi(mix, page_cross_rate=0.0, branch_taken_fraction=0.6):
    total = 0.0
    for key, w in mix.items():
        if key == "branch":
            c = branch_taken_fraction * 3 + (1.0 - branch_taken_fraction) * 2
        else:
            c = TABLE[key] + (page_cross_rate if key == ("LDA", "absolute,X") else 0.0)
        total += w * c
    return total
