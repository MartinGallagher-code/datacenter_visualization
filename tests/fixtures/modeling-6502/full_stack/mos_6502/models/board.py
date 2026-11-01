"""Stand-in (see README.md): round clocks, a 5% steal plus 1% a sprite,
and one holdout that passes and one that does not."""


class Mos6502Board:
    def c64_steal_fraction(self, region="pal", screen_on=True, sprites=0):
        return 0.05 + 0.01 * sprites if screen_on else 0.0

    def c64_effective_mhz(self, region="pal", screen_on=True):
        clock = 1.0 if region == "pal" else 1.02
        return clock * (1.0 - self.c64_steal_fraction(region, screen_on))

    def effective_mhz(self, board, region="pal"):
        if board == "c64":
            return self.c64_effective_mhz(region)
        return {"apple_ii": 1.0, "bbc_micro": 2.0, "vic_20": 1.1 if region == "pal" else 1.02}[board]

    def availability(self, board, region="pal"):
        return 1.0 - self.c64_steal_fraction(region) if board == "c64" else 1.0

    def holdout_c64_vic20(self):
        return {"predicted": 1.2, "measured": 1.0, "residual": 0.2}

    def holdout_apple_vic20(self):
        return {"predicted": 1.05, "measured": 1.0, "residual": 0.05}
