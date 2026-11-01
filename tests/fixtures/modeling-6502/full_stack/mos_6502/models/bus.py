"""Stand-in (see README.md): one byte a cycle."""


class Mos6502Bus:
    def bandwidth_bytes_per_s(self, clock_mhz=None):
        return clock_mhz * 1e6

    def bytes_per_instruction(self, cpi):
        return cpi
